/**
 * Payout method catalogue.
 *
 * Reads which banks and wallets can be paid in a currency, and which fields each needs, from the
 * Partner API's public "supported resources" endpoints, and validates collected fields against the
 * rules those endpoints publish. It does not choose a method for the person and does not save
 * anything; `transfer-orchestrator.ts` does both.
 *
 * Reference: https://developers.unigox.com/api-reference/supported-resources
 */

import { partnerApiRequest } from "./partner-api-client.ts";
import type { PartnerApiTransport } from "./partner-api-client.ts";

/**
 * Largest page the institutions endpoint serves.
 * Source: Third-party payouts guide ("`limit` defaults to 20 and caps at 100; a larger value is a 400").
 */
const INSTITUTIONS_PAGE_LIMIT = 100;

/**
 * Field key some rails list for the institution choice itself. The institution is selected as the
 * payout method, not typed as a detail, so this key is never collected.
 */
const INSTITUTION_FIELD_KEY = "institution_id";

/** A rail an institution can be paid over. Produced by the catalogue, consumed by the orchestrator. */
export interface PaymentNetworkInfo {
  /** Numeric id the API reports for this rail on the institution. Informational; lookups use `slug`. */
  id: number;
  /** Rail display name, e.g. "European Transfer (SEPA)". */
  name: string;
  /** Rail slug sent as `rail` when saving payment details. */
  slug: string;
  /** Fiat currency the rail was listed for. */
  fiatCurrencyCode: string;
}

/** A bank or wallet that can receive a payout. Produced by the catalogue, consumed by the orchestrator. */
export interface PaymentMethodInfo {
  /** Numeric id the API reports for the institution. Informational; lookups use `slug`. */
  id: number;
  /** Institution display name, e.g. "Revolut". */
  name: string;
  /** Institution slug sent as `institution_id` when saving payment details. */
  slug: string;
  /** Broad kind as the API labels it, e.g. "BANK". */
  type: string;
  /** Institution type slug that selects a rail format, e.g. "digital-banks". */
  typeSlug: string;
  /** Rails this institution can be paid over in the queried currency. Never empty. */
  networks: PaymentNetworkInfo[];
}

/** Payout methods available for one currency. */
export interface CurrencyPaymentData {
  /** The queried currency. `name` repeats the code because the catalogue endpoints carry no name. */
  currency: { code: string; name: string };
  /**
   * Methods the person can choose from. For a rail with more institutions than one page, this holds
   * the first page plus every institution matching a requested search term, not the whole rail.
   */
  paymentMethods: PaymentMethodInfo[];
}

/** One field to collect for a payout method, as its rail publishes it. */
export interface PaymentFieldConfig {
  /** Key to send inside `details` when saving payment details. */
  field: string;
  /** Human-readable name from the API, e.g. "IBAN". */
  label: string;
  /** Example or hint from the API. Empty when the API gives none. */
  placeholder: string;
  /** Input kind from the API, e.g. "text", "tel", "email", "country". */
  type: string;
  /** Whether the rail requires the field. */
  required: boolean;
  /** Regular expression the value must match. Absent when the rail publishes none. */
  pattern?: string;
  /** Allowed values for a select field. Absent for free-form fields. */
  options?: Array<{ code: string; name: string }>;
}

/** The fields to collect for one institution on one rail. */
export interface ResolvedPaymentMethodFieldConfig {
  /** The institution the fields were resolved for. */
  method: PaymentMethodInfo;
  /** The rail the fields were resolved for. */
  network: PaymentNetworkInfo;
  /** Id of the rail format that applies to this institution. Absent when the rail has no formats. */
  selectedFormatId?: string;
  /** Fields to collect, in the rail's order. */
  fields: PaymentFieldConfig[];
}

/** One problem found while validating collected fields. */
export interface PaymentFieldValidationError {
  /** Key of the offending field. */
  field: string;
  /** Short sentence for the person, built from the field's label. */
  message: string;
}

/** Outcome of validating collected fields against a rail's rules. */
export interface PaymentFieldValidationResult {
  /** True when every required field is present and every present field matches its pattern. */
  valid: boolean;
  /** Present fields after normalization (trimmed; IBAN and codes upper-cased; `@` removed from a Revtag). */
  normalizedDetails: Record<string, string>;
  /** Problems found, at most one per field, in field order. Empty when `valid`. */
  errors: PaymentFieldValidationError[];
}

/** Catalogue operations bound to one API host. Returned by `createPaymentCatalogue`. */
export interface PaymentCatalogue {
  /**
   * Lists payout methods for a currency.
   *
   * @param currency Fiat currency code.
   * @param searchTerms Words the person used that may name an institution. For rails too large for
   *   one page, each term is searched on the API so a named bank is found without paging the rail.
   * @returns Methods merged across rails. Empty `paymentMethods` when the currency has no usable rail.
   * @throws PartnerApiError when the API refuses a request.
   */
  getPaymentMethodsForCurrency(currency: string, searchTerms?: string[]): Promise<CurrencyPaymentData>;
  /**
   * Resolves the fields to collect for one institution on one rail.
   *
   * @param params.currency Fiat currency code.
   * @param params.methodSlug Institution slug.
   * @param params.networkSlug Rail slug.
   * @returns The institution, the rail, the applicable format and its fields.
   * @throws Error when the rail is not offered for the currency, the institution is not on the rail,
   *   or no format of the rail applies to the institution.
   * @throws PartnerApiError when the API refuses a request.
   */
  getPaymentMethodFieldConfig(params: { currency: string; methodSlug: string; networkSlug: string }): Promise<ResolvedPaymentMethodFieldConfig>;
}

/** A rail format as the API returns it: the field set for some institution types. */
interface RailFormat {
  id: string;
  institution_types?: string[] | null;
  has_liquidity?: boolean;
  fields?: RawField[];
}

/** A payout rail as the API returns it. */
interface Rail {
  slug: string;
  name: string;
  fields?: RawField[];
  formats?: RailFormat[];
}

/** A field definition as the API returns it. */
interface RawField {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  pattern?: string;
  placeholder?: string;
  options?: Array<{ code: string; name: string }>;
}

/** An institution as the API returns it. */
interface Institution {
  id: string;
  name: string;
  type?: string;
  institution_type?: string;
  payment_method_id?: number;
  payment_network_id?: number;
}

/** One page of institutions with the size of the full result set. */
interface InstitutionPage {
  institutions: Institution[];
  total: number;
}

/**
 * Creates catalogue operations for one API host.
 *
 * @param transport Base URL and HTTP implementation. The catalogue endpoints are public, so no API
 *   key is needed; one is sent when present.
 * @returns The catalogue operations. Nothing is cached between calls.
 */
export function createPaymentCatalogue(transport: PartnerApiTransport): PaymentCatalogue {
  return {
    async getPaymentMethodsForCurrency(currency, searchTerms = []) {
      const rails = (await listPayoutRails(transport, currency)).filter(railHasCollectableFields);
      const institutionsByRail = await Promise.all(
        rails.map((rail) => listSelectableInstitutions(transport, rail, currency, searchTerms))
      );
      return {
        currency: { code: currency, name: currency },
        paymentMethods: mergeMethodsAcrossRails(rails, institutionsByRail, currency),
      };
    },

    async getPaymentMethodFieldConfig({ currency, methodSlug, networkSlug }) {
      const rails = await listPayoutRails(transport, currency);
      const rail = rails.find((entry) => entry.slug === networkSlug);
      if (!rail) {
        throw new Error(`Rail ${networkSlug} is not offered for ${currency} payouts`);
      }
      const page = await listInstitutions(transport, { rail: rail.slug, currency, institutionId: methodSlug });
      const institution = page.institutions.find((entry) => entry.id === methodSlug);
      if (!institution) {
        throw new Error(`Institution ${methodSlug} is not listed on rail ${networkSlug} for ${currency}`);
      }
      const selection = selectRailFields(rail, institution);
      if (!selection) {
        throw new Error(`Rail ${networkSlug} has no payable format for institution ${methodSlug}`);
      }
      const network = toNetworkInfo(rail, institution, currency);
      return {
        method: toMethodInfo(institution, [network]),
        network,
        selectedFormatId: selection.formatId,
        fields: selection.fields,
      };
    },
  };
}

/**
 * Validates collected payout fields against a rail's published rules.
 *
 * @param details Collected values keyed by field key. Missing keys count as empty.
 * @param fields The rail's field definitions, as resolved by the catalogue.
 * @returns Whether the values are acceptable, the normalized values, and one message per problem.
 *   A pattern the JavaScript engine cannot compile is treated as absent, leaving the check to the API.
 */
export function validatePaymentDetailInput(
  details: Record<string, string>,
  fields: PaymentFieldConfig[]
): PaymentFieldValidationResult {
  const errors: PaymentFieldValidationError[] = [];
  const normalizedDetails: Record<string, string> = {};

  for (const fieldConfig of fields) {
    const rawValue = details[fieldConfig.field];
    const value = normalizeFieldValue(fieldConfig.field, typeof rawValue === "string" ? rawValue.trim() : "");
    const label = fieldConfig.label || fieldConfig.field;

    if (!value) {
      if (fieldConfig.required) errors.push({ field: fieldConfig.field, message: `${label} is required` });
      continue;
    }
    normalizedDetails[fieldConfig.field] = value;

    if (!matchesPattern(value, fieldConfig.pattern)) {
      errors.push({ field: fieldConfig.field, message: `That doesn't look like a valid ${label}` });
    }
  }

  return { valid: errors.length === 0, normalizedDetails, errors };
}

/**
 * Lists the payout rails offered for a currency.
 *
 * @param transport API host.
 * @param currency Fiat currency code.
 * @returns Rails in the API's order. Empty when the currency has none.
 * @throws PartnerApiError when the API refuses the request.
 */
async function listPayoutRails(transport: PartnerApiTransport, currency: string): Promise<Rail[]> {
  const data = await partnerApiRequest<{ rails?: Rail[] }>(transport, {
    method: "GET",
    path: "/api/v1/supported/payment-rails",
    query: { currency, direction: "offramp" },
  });
  return Array.isArray(data?.rails) ? data.rails : [];
}

/**
 * Fetches one page of institutions on a rail.
 *
 * @param transport API host.
 * @param filter.rail Rail slug (required by the API).
 * @param filter.currency Fiat currency code.
 * @param filter.search Optional name or slug fragment to match.
 * @param filter.institutionId Optional exact institution slug.
 * @returns Up to `INSTITUTIONS_PAGE_LIMIT` institutions and the total the filter matches.
 * @throws PartnerApiError when the API refuses the request.
 */
async function listInstitutions(
  transport: PartnerApiTransport,
  filter: { rail: string; currency: string; search?: string; institutionId?: string }
): Promise<InstitutionPage> {
  const data = await partnerApiRequest<{ institutions?: Institution[]; pagination?: { total?: number } }>(transport, {
    method: "GET",
    path: "/api/v1/supported/institutions",
    query: {
      rail: filter.rail,
      currency: filter.currency,
      search: filter.search,
      institution_id: filter.institutionId,
      limit: INSTITUTIONS_PAGE_LIMIT,
    },
  });
  const institutions = Array.isArray(data?.institutions) ? data.institutions : [];
  return { institutions, total: data?.pagination?.total ?? institutions.length };
}

/**
 * Collects the institutions a person could mean on one rail.
 *
 * A rail that fits in one page is returned whole. A larger rail returns its first page plus the
 * matches of each search term, because the API offers no way to fetch more than one page per request
 * and paging thousands of banks to match one name would cost dozens of requests.
 *
 * @param transport API host.
 * @param rail The rail to list.
 * @param currency Fiat currency code.
 * @param searchTerms Words that may name an institution. Ignored for rails that fit in one page.
 * @returns Institutions payable on this rail, without duplicates, first page first.
 * @throws PartnerApiError when the API refuses a request.
 */
async function listSelectableInstitutions(
  transport: PartnerApiTransport,
  rail: Rail,
  currency: string,
  searchTerms: string[]
): Promise<Institution[]> {
  const firstPage = await listInstitutions(transport, { rail: rail.slug, currency });
  const pages = [firstPage];
  if (firstPage.total > firstPage.institutions.length) {
    const uniqueTerms = [...new Set(searchTerms)];
    pages.push(
      ...(await Promise.all(uniqueTerms.map((search) => listInstitutions(transport, { rail: rail.slug, currency, search }))))
    );
  }

  const bySlug = new Map<string, Institution>();
  for (const institution of pages.flatMap((page) => page.institutions)) {
    if (!bySlug.has(institution.id) && selectRailFields(rail, institution)) {
      bySlug.set(institution.id, institution);
    }
  }
  return [...bySlug.values()];
}

/**
 * Merges per-rail institution lists into one method list, joining an institution's rails.
 *
 * @param rails Rails, aligned by index with `institutionsByRail`.
 * @param institutionsByRail Institutions payable on each rail.
 * @param currency Fiat currency code the lists were queried for.
 * @returns One method per institution slug, in first-seen order, each with every rail it appeared on.
 */
function mergeMethodsAcrossRails(rails: Rail[], institutionsByRail: Institution[][], currency: string): PaymentMethodInfo[] {
  const methods = new Map<string, PaymentMethodInfo>();
  rails.forEach((rail, index) => {
    for (const institution of institutionsByRail[index]) {
      const network = toNetworkInfo(rail, institution, currency);
      const existing = methods.get(institution.id);
      if (existing) {
        existing.networks.push(network);
      } else {
        methods.set(institution.id, toMethodInfo(institution, [network]));
      }
    }
  });
  return [...methods.values()];
}

/**
 * Tells whether a rail publishes any field that could be collected for some institution.
 *
 * @param rail Rail as returned by the API.
 * @returns False for a rail with no fields and no payable format; such a rail cannot be paid
 *   because there is nothing to save as its details.
 */
function railHasCollectableFields(rail: Rail): boolean {
  if (rail.formats?.length) {
    return rail.formats.some((format) => format.has_liquidity !== false && toFieldConfigs(format.fields).length > 0);
  }
  return toFieldConfigs(rail.fields).length > 0;
}

/**
 * Picks the field set that applies to one institution on one rail.
 *
 * A rail with formats pairs each format with institution types; the institution's type decides.
 * A format the API marks `has_liquidity: false` cannot currently be settled and is not selected.
 * A rail without formats applies its own fields to every institution.
 *
 * @param rail Rail as returned by the API.
 * @param institution Institution as returned by the API.
 * @returns The format id (absent for a rail without formats) and its fields, or `undefined` when
 *   the institution cannot be paid on this rail.
 */
function selectRailFields(rail: Rail, institution: Institution): { formatId?: string; fields: PaymentFieldConfig[] } | undefined {
  if (rail.formats?.length) {
    const format = rail.formats.find(
      (entry) => entry.has_liquidity !== false && (entry.institution_types ?? []).includes(institution.institution_type ?? "")
    );
    const fields = toFieldConfigs(format?.fields);
    return format && fields.length > 0 ? { formatId: format.id, fields } : undefined;
  }
  const fields = toFieldConfigs(rail.fields);
  return fields.length > 0 ? { fields } : undefined;
}

/**
 * Converts API field definitions to `PaymentFieldConfig`, dropping the institution pseudo-field.
 *
 * @param fields Field definitions from a rail or one of its formats.
 * @returns Collectable fields in the API's order. Empty when none are given.
 */
function toFieldConfigs(fields: RawField[] | undefined): PaymentFieldConfig[] {
  return (fields ?? [])
    .filter((field) => field.key !== INSTITUTION_FIELD_KEY)
    .map((field) => ({
      field: field.key,
      label: field.label || field.key,
      placeholder: field.placeholder || "",
      type: field.type || "text",
      required: field.required === true,
      pattern: field.pattern || undefined,
      options: field.options?.length ? field.options : undefined,
    }));
}

/**
 * Describes a rail as one of an institution's payout networks.
 *
 * @param rail Rail as returned by the API.
 * @param institution Institution as listed on that rail; supplies the rail's numeric id.
 * @param currency Fiat currency the listing was queried for.
 * @returns Network info with the rail's slug and name. `id` is 0 when the API reports none.
 */
function toNetworkInfo(rail: Rail, institution: Institution, currency: string): PaymentNetworkInfo {
  return {
    id: institution.payment_network_id ?? 0,
    name: rail.name,
    slug: rail.slug,
    fiatCurrencyCode: currency,
  };
}

/**
 * Describes an institution as a payout method.
 *
 * @param institution Institution as returned by the API.
 * @param networks Rails the institution can be paid over.
 * @returns Method info. `id` is 0 when the API reports none.
 */
function toMethodInfo(institution: Institution, networks: PaymentNetworkInfo[]): PaymentMethodInfo {
  return {
    id: institution.payment_method_id ?? 0,
    name: institution.name,
    slug: institution.id,
    type: institution.type || "",
    typeSlug: institution.institution_type || "",
    networks,
  };
}

/**
 * Normalizes a typed value the way the rails' patterns expect it.
 *
 * @param field Field key.
 * @param value Trimmed value.
 * @returns IBAN, SWIFT and IFSC codes without spaces and upper-cased; a Revtag without its leading
 *   `@`; any other value unchanged.
 */
function normalizeFieldValue(field: string, value: string): string {
  switch (field) {
    case "iban":
    case "swift_code":
    case "ifsc_code":
      return value.replace(/\s+/g, "").toUpperCase();
    case "revtag":
      return value.replace(/^@/, "");
    default:
      return value;
  }
}

/**
 * Tests a value against a rail-published pattern.
 *
 * @param value Normalized, non-empty value.
 * @param pattern Regular expression source from the API, or `undefined`.
 * @returns True when there is no pattern, the pattern cannot be compiled, or the value matches.
 */
function matchesPattern(value: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch {
    return true;
  }
  return expression.test(value);
}
