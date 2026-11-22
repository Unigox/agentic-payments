import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentCatalogue, validatePaymentDetailInput } from "./payment-catalogue.ts";
import type { PaymentFieldConfig } from "./payment-catalogue.ts";

const API_URL = "https://api.example.test";

/** A rail as the fake API serves it. Mirrors the live `/supported/payment-rails` shape. */
const SEPA_RAIL = {
  slug: "iban-sepa",
  name: "European Transfer (SEPA)",
  fields: [
    { key: "full_name", label: "Full Name", type: "text", required: true, pattern: "^[a-zA-Z\\s'-]{2,50}$" },
    { key: "iban", label: "IBAN", type: "text", required: true, pattern: "^[A-Z]{2}\\d{2}[A-Z0-9]{1,30}$" },
  ],
};
const REVTAG_RAIL = {
  slug: "revolut-username",
  name: "Revolut Username",
  fields: [{ key: "revtag", label: "Revtag", type: "text", required: true, pattern: "^[a-zA-Z0-9_-]+$" }],
};
const EMPTY_RAIL = { slug: "bizum", name: "Bizum", fields: [] };
const PESALINK_RAIL = {
  slug: "pesalink",
  name: "Pesalink",
  fields: [{ key: "account_number", label: "Account Number", required: true }],
  formats: [
    {
      id: "mobile-money",
      institution_types: ["mobile-money", "mobile-wallets"],
      has_liquidity: true,
      fields: [{ key: "phone_number", label: "Phone Number", type: "tel", required: true, pattern: "^\\+254\\d{9}$" }],
    },
    {
      id: "banks",
      institution_types: ["digital-banks", "traditional-banks"],
      has_liquidity: true,
      fields: [{ key: "account_number", label: "Account Number", required: true }],
    },
    { id: "mpesa-paybill", institution_types: ["paybill"], has_liquidity: false, fields: [{ key: "paybill", label: "Paybill", required: true }] },
  ],
};

/**
 * Builds a fake `fetch` for the two catalogue endpoints and records the query of every call.
 *
 * @param rails Rails to serve for any currency.
 * @param institutions Institutions per rail slug. A rail's first page is its first
 *   `pageSize` entries; `search` matches a case-insensitive name fragment; `institution_id` matches
 *   the slug exactly.
 * @param pageSize How many institutions an unfiltered page returns.
 * @returns The fake `fetch` and the recorded `"<path>?<query>"` strings.
 */
function createCatalogueFetch(
  rails: unknown[],
  institutions: Record<string, Array<Record<string, unknown>>>,
  pageSize = 100
): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/supported/payment-rails") {
      return new Response(JSON.stringify({ success: true, data: { rails } }), { status: 200 });
    }
    const all = institutions[url.searchParams.get("rail") ?? ""] ?? [];
    const search = url.searchParams.get("search")?.toLowerCase();
    const institutionId = url.searchParams.get("institution_id");
    const matched = institutionId
      ? all.filter((entry) => entry.id === institutionId)
      : search
        ? all.filter((entry) => String(entry.name).toLowerCase().includes(search))
        : all;
    return new Response(
      JSON.stringify({ success: true, data: { institutions: matched.slice(0, pageSize), pagination: { total: matched.length } } }),
      { status: 200 }
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const REVOLUT_ON_SEPA = { id: "revolut", name: "Revolut", type: "BANK", institution_type: "digital-banks", payment_method_id: 2, payment_network_id: 3 };
const REVOLUT_ON_REVTAG = { ...REVOLUT_ON_SEPA, payment_network_id: 47 };

test("methods are merged across rails and rails without fields are left out", async () => {
  const { fetchImpl, requests } = createCatalogueFetch([SEPA_RAIL, REVTAG_RAIL, EMPTY_RAIL], {
    "iban-sepa": [REVOLUT_ON_SEPA, { id: "n26", name: "N26", type: "BANK", institution_type: "digital-banks", payment_method_id: 123, payment_network_id: 3 }],
    "revolut-username": [REVOLUT_ON_REVTAG],
    bizum: [{ id: "bizum", name: "Bizum", institution_type: "mobile-wallets" }],
  });
  const catalogue = createPaymentCatalogue({ apiUrl: API_URL, fetchImpl });

  const data = await catalogue.getPaymentMethodsForCurrency("EUR");

  assert.deepEqual(data.paymentMethods.map((method) => method.slug), ["revolut", "n26"]);
  assert.deepEqual(data.paymentMethods[0].networks.map((network) => [network.slug, network.id]), [
    ["iban-sepa", 3],
    ["revolut-username", 47],
  ]);
  assert.equal(requests.some((request) => request.includes("rail=bizum")), false);
  assert.ok(requests[0].includes("currency=EUR") && requests[0].includes("direction=offramp"));
});

test("a rail larger than one page is searched for each term instead of being paged", async () => {
  const banks = Array.from({ length: 5 }, (_, index) => ({ id: `bank-${index}`, name: `Bank ${index}`, institution_type: "traditional-banks", payment_method_id: 100 + index, payment_network_id: 3 }));
  const kuda = { id: "kuda-bank", name: "Kuda Bank", institution_type: "digital-banks", payment_method_id: 900, payment_network_id: 3 };
  const { fetchImpl, requests } = createCatalogueFetch([SEPA_RAIL], { "iban-sepa": [...banks, kuda] }, 3);
  const catalogue = createPaymentCatalogue({ apiUrl: API_URL, fetchImpl });

  const withoutTerms = await catalogue.getPaymentMethodsForCurrency("EUR");
  const withTerms = await catalogue.getPaymentMethodsForCurrency("EUR", ["kuda", "kuda"]);

  assert.deepEqual(withoutTerms.paymentMethods.map((method) => method.slug), ["bank-0", "bank-1", "bank-2"]);
  assert.deepEqual(withTerms.paymentMethods.map((method) => method.slug), ["bank-0", "bank-1", "bank-2", "kuda-bank"]);
  assert.equal(requests.filter((request) => request.includes("search=kuda")).length, 1);
});

test("an institution is offered only on rails that have a payable format for its type", async () => {
  const { fetchImpl } = createCatalogueFetch([PESALINK_RAIL], {
    pesalink: [
      { id: "m-pesa", name: "M-PESA", institution_type: "mobile-money", payment_method_id: 5, payment_network_id: 9 },
      { id: "kcb", name: "KCB", institution_type: "traditional-banks", payment_method_id: 6, payment_network_id: 9 },
      { id: "mpesa-paybill", name: "M-PESA Paybill", institution_type: "paybill", payment_method_id: 7, payment_network_id: 9 },
    ],
  });
  const catalogue = createPaymentCatalogue({ apiUrl: API_URL, fetchImpl });

  const data = await catalogue.getPaymentMethodsForCurrency("KES");

  assert.deepEqual(data.paymentMethods.map((method) => method.slug), ["m-pesa", "kcb"]);
});

test("field config follows the format that matches the institution type", async () => {
  const { fetchImpl } = createCatalogueFetch([PESALINK_RAIL], {
    pesalink: [{ id: "m-pesa", name: "M-PESA", institution_type: "mobile-money", payment_method_id: 5, payment_network_id: 9 }],
  });
  const catalogue = createPaymentCatalogue({ apiUrl: API_URL, fetchImpl });

  const config = await catalogue.getPaymentMethodFieldConfig({ currency: "KES", methodSlug: "m-pesa", networkSlug: "pesalink" });

  assert.equal(config.selectedFormatId, "mobile-money");
  assert.deepEqual(config.fields.map((field) => field.field), ["phone_number"]);
  assert.equal(config.method.name, "M-PESA");
  assert.equal(config.network.slug, "pesalink");
});

test("field config drops the institution pseudo-field and reports unknown rails and institutions", async () => {
  const swift = {
    slug: "swift-iban",
    name: "SWIFT",
    fields: [
      { key: "institution_id", label: "Bank", required: true },
      { key: "swift_code", label: "SWIFT Code", required: true, pattern: "^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$" },
    ],
  };
  const { fetchImpl } = createCatalogueFetch([swift], { "swift-iban": [{ id: "hsbc", name: "HSBC", institution_type: "traditional-banks" }] });
  const catalogue = createPaymentCatalogue({ apiUrl: API_URL, fetchImpl });

  const config = await catalogue.getPaymentMethodFieldConfig({ currency: "USD", methodSlug: "hsbc", networkSlug: "swift-iban" });

  assert.deepEqual(config.fields.map((field) => field.field), ["swift_code"]);
  assert.equal(config.selectedFormatId, undefined);
  await assert.rejects(catalogue.getPaymentMethodFieldConfig({ currency: "USD", methodSlug: "hsbc", networkSlug: "ach" }), /not offered/);
  await assert.rejects(catalogue.getPaymentMethodFieldConfig({ currency: "USD", methodSlug: "unknown", networkSlug: "swift-iban" }), /not listed/);
});

test("validation normalizes values, requires required fields and applies the rail's pattern", () => {
  const fields: PaymentFieldConfig[] = [
    { field: "iban", label: "IBAN", placeholder: "", type: "text", required: true, pattern: "^[A-Z]{2}\\d{2}[A-Z0-9]{1,30}$" },
    { field: "full_name", label: "Full Name", placeholder: "", type: "text", required: true },
    { field: "revtag", label: "Revtag", placeholder: "", type: "text", required: false, pattern: "^[a-zA-Z0-9_-]+$" },
    { field: "note", label: "Note", placeholder: "", type: "text", required: false, pattern: "([unclosed" },
  ];

  const valid = validatePaymentDetailInput({ iban: " ee38 2200 2210 2014 5685 ", full_name: "John Doe", revtag: "@john", note: "anything" }, fields);
  const invalid = validatePaymentDetailInput({ iban: "not-an-iban" }, fields);

  assert.equal(valid.valid, true);
  assert.deepEqual(valid.normalizedDetails, { iban: "EE382200221020145685", full_name: "John Doe", revtag: "john", note: "anything" });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors, [
    { field: "iban", message: "That doesn't look like a valid IBAN" },
    { field: "full_name", message: "Full Name is required" },
  ]);
});
