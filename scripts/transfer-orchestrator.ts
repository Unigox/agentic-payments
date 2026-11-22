#!/usr/bin/env -S node --experimental-strip-types
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { PartnerApiClient } from "./partner-api-client.ts";
import { loadPartnerApiConfigFromEnv } from "./partner-api-config.ts";
import { PartnerExecutionClient } from "./partner-execution-client.ts";
import { createPaymentCatalogue, validatePaymentDetailInput as defaultValidatePaymentDetailInput } from "./payment-catalogue.ts";
import type {
  CurrencyPaymentData,
  PaymentCatalogue,
  PaymentFieldConfig,
  PaymentFieldValidationResult,
  PaymentMethodInfo,
  PaymentNetworkInfo,
  ResolvedPaymentMethodFieldConfig,
} from "./payment-catalogue.ts";
import { TransferExecutionError } from "./transfer-execution.ts";
import type {
  AgenticPaymentsSettings,
  InitiatorTradeSummary,
  KycVerificationData,
  PartnerPaymentDetailsDiffData,
  PaymentDetail,
  PreflightQuote,
  SettlementTrade,
  TradeRequest,
  TransferExecutionClient,
  WalletBalance,
  WalletBalanceAsset,
} from "./transfer-execution.ts";
import {
  DEFAULT_POLL_INTERVAL_MS,
  createInitialSettlementState,
  noteDeferredPlaceholder,
  noteReceiptNotReceived,
  parseReceiptDecision,
  pollSettlementSnapshot,
  refreshSettlementSnapshot,
} from "./settlement-monitor.ts";
import type {
  SettlementMonitorState,
  SettlementMonitorOptions,
  SettlementPhase,
  SettlementSnapshot,
} from "./settlement-monitor.ts";
import {
  DEFAULT_CONTACTS_FILE,
  SKILL_DIR,
  loadContacts,
  normalizeContactKey,
  normalizeLookupValue,
  saveContacts,
  resolveContact,
  resolveContactQuery,
  upsertContactPaymentMethod,
} from "./contact-store.ts";
import type { ContactMatch, ContactRecord, ContactResolution, ContactStoreData, StoredPaymentMethod } from "./contact-store.ts";

export type { TransferExecutionClient } from "./transfer-execution.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SETTINGS_FILE = path.join(SKILL_DIR, "settings.json");

/** What the person asked for: send money now, or only save a recipient for later. */
export type TransferGoal = "transfer" | "save_contact_only";

/** Where the conversation is waiting. Persisted with the session between turns. */
export type TransferStage =
  | "resolving"
  | "awaiting_setup"
  | "awaiting_recipient_mode"
  | "awaiting_recipient_name"
  | "awaiting_saved_recipient_confirmation"
  | "awaiting_currency"
  | "awaiting_payment_method"
  | "awaiting_payment_network"
  | "awaiting_payment_details"
  | "awaiting_save_contact_decision"
  | "awaiting_amount"
  | "awaiting_kyc_full_name"
  | "awaiting_kyc_country"
  | "awaiting_kyc_completion"
  | "awaiting_confirmation"
  | "awaiting_balance_resolution"
  | "awaiting_match_status"
  | "awaiting_new_price_confirmation"
  | "awaiting_no_match_resolution"
  | "awaiting_partner_payment_details_input"
  | "awaiting_trade_settlement"
  | "awaiting_receipt_confirmation"
  | "awaiting_release_completion"
  | "awaiting_manual_settlement_followup"
  | "completed"
  | "blocked"
  | "cancelled";

export interface TransferTurn {
  text?: string;
  imagePath?: string;
  option?: string;
  fields?: Record<string, string>;
}

export interface TransferFlowEvent {
  type:
    | "contact_saved"
    | "contact_updated"
    | "payment_detail_ensured"
    | "trade_request_created"
    | "trade_matched"
    | "trade_price_changed"
    | "trade_price_change_confirmed"
    | "trade_price_change_cancelled"
    | "escrow_funding_submitted"
    | "escrow_refund_authorized"
    | "trade_pending"
    | "blocked_missing_auth"
    | "blocked_insufficient_balance"
    | "blocked_no_vendor_match"
    | "balance_checked"
    | "settlement_monitor_started"
    | "settlement_status_changed"
    | "receipt_confirmation_requested"
    | "receipt_confirmation_reminder"
    | "receipt_confirmation_timeout"
    | "receipt_confirmed"
    | "receipt_not_received"
    | "settlement_placeholder_deferred"
    | "settlement_completed"
    | "settlement_refunded_or_cancelled";
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Collaborators and timings of one flow run. Created by the turn runner, the MCP server or a test;
 * consumed by `startTransferFlow` and `advanceTransferFlow`. Every field is optional: an omitted
 * collaborator is built from the environment, an omitted timing uses the flow's default.
 */
export interface TransferFlowDeps {
  /** Contacts file to read and write. Defaults to the skill's `contacts.json`. */
  contactsFilePath?: string;
  /** Settings file to read. Defaults to the skill's `settings.json`. */
  settingsFilePath?: string;
  /** How long to wait for a provider to accept a placed transfer, in milliseconds. */
  waitForMatchTimeoutMs?: number;
  /** How long one turn keeps polling settlement, in milliseconds. */
  waitForSettlementTimeoutMs?: number;
  /** How long to keep polling after funding escrow before handing back to the person, in milliseconds. */
  receiptConfirmationHandoffTimeoutMs?: number;
  /** Pause between settlement and match reads, in milliseconds. */
  settlementPollIntervalMs?: number;
  /** Time before a receipt-confirmation reminder is due, in milliseconds. */
  receiptReminderMs?: number;
  /** Time before a receipt confirmation counts as overdue, in milliseconds. */
  receiptTimeoutMs?: number;
  /** Pause between reads while waiting for a KYC link, in milliseconds. */
  kycVerificationPollIntervalMs?: number;
  /** How long to wait for a KYC link, in milliseconds. */
  kycVerificationPollTimeoutMs?: number;
  /** Clock. Defaults to the system clock. */
  now?: () => Date;
  /** Timer. Defaults to a real one. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether stored credentials are usable. Defaults to what the environment holds. */
  authState?: AuthState;
  /** Backend to use for this run. Takes precedence over `clientFactory` and the environment. */
  client?: TransferExecutionClient;
  /** Builds the backend on first use. Takes precedence over the environment. */
  clientFactory?: () => Promise<TransferExecutionClient>;
  /** Lists payout methods for a currency; `searchTerms` are words that may name an institution. */
  getPaymentMethodsForCurrency?: (currency: string, searchTerms?: string[]) => Promise<CurrencyPaymentData>;
  /** Resolves the fields to collect for one institution on one rail. */
  getPaymentMethodFieldConfig?: (params: { currency: string; methodSlug: string; networkSlug: string }) => Promise<ResolvedPaymentMethodFieldConfig>;
  /** Validates collected payout fields against a rail's rules. */
  validatePaymentDetailInput?: (details: Record<string, string>, fields: PaymentFieldConfig[]) => PaymentFieldValidationResult;
}

/**
 * Whether this installation can act without asking for credentials.
 * Produced by `detectAuthState` from the environment (or supplied by a test) and read once per
 * session by `advanceTransferFlow`.
 */
export interface AuthState {
  /** True when the Partner API key, wallet key, node URL and sender email are all configured. */
  hasReplayableAuth: boolean;
  /** Names of the environment settings still missing. Empty or absent when none are. */
  missingSettings?: string[];
  /** Name to address the sender by, when already known. */
  username?: string;
}

interface ResolvedAuthState extends AuthState {
  balanceUsd?: number;
  walletBalance?: WalletBalance;
}

export interface AssetCoverageState {
  assetCode: string;
  balanceUsd: number;
  requiredUsd: number;
  shortfallUsd: number;
  coversTransfer: boolean;
  quote?: PreflightQuote;
}

export interface ExecutionPreflightState {
  balanceUsd: number;
  amount: number;
  currency: string;
  checkedAt: string;
  paymentDetailsId?: string;
  quote?: PreflightQuote;
  walletBalanceAssets?: WalletBalanceAsset[];
  assetCoverage?: AssetCoverageState[];
  selectedAssetCode?: string;
  sellAssetBalanceUsd?: number;
  sellAssetRequiredUsd?: number;
  aggregateBalanceEnoughButSingleAssetInsufficient?: boolean;
}

export interface SelectedPaymentMethod {
  methodId: number;
  methodSlug: string;
  methodName: string;
  networkId: number;
  networkSlug: string;
  networkName: string;
  selectedFormatId?: string;
}

export interface DetailCollectionState {
  index: number;
  lastError?: string;
}

interface PartnerFieldToComplete {
  fieldKey: string;
  label: string;
  required: boolean;
  currentValue?: string;
  expectedPattern?: string;
  example?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
}

interface PartnerDetailCollectionState {
  tradeId: string;
  tradeRequestId: string;
  paymentDetailsId: string;
  partner: string;
  index: number;
  fields: PartnerFieldToComplete[];
  values: Record<string, string>;
}

interface OutstandingTradeReminderState {
  tradeId: string;
  phase: SettlementPhase;
  recipient: string;
  fiatAmount?: number;
  fiatCurrencyCode?: string;
}

interface PendingSavedRecipientConfirmationState {
  source: "local" | "remote";
  query: string;
  matchedBy: "exact" | "partial" | "fuzzy";
  match: ContactMatch;
}

export interface TransferSession {
  id: string;
  goal: TransferGoal;
  status: "active" | "completed" | "blocked" | "cancelled";
  stage: TransferStage;
  startedAt: string;
  updatedAt: string;
  recipientMode?: "saved" | "new";
  recipientQuery?: string;
  contactKey?: string;
  remoteSavedContact?: ContactRecord;
  pendingSavedRecipientConfirmation?: PendingSavedRecipientConfirmationState;
  recipientName?: string;
  aliases?: string[];
  currency?: string;
  amount?: number;
  payment?: SelectedPaymentMethod;
  details: Record<string, string>;
  detailCollection: DetailCollectionState;
  saveContactDecision?: "pending" | "yes" | "no";
  contactSaveAction?: "create" | "update";
  contactExists: boolean;
  contactStale: boolean;
  auth: {
    checked: boolean;
    available: boolean;
    missingSettings?: string[];
    username?: string;
    kycStatus?: string;
    kycCountryCode?: string;
    kycFullName?: string;
    kycVerificationUrl?: string;
    kycVerificationSecondsLeft?: number;
    balanceUsd?: number;
    walletBalance?: WalletBalance;
    startupSnapshotShown?: boolean;
    outstandingTradeReminderShown?: boolean;
    outstandingTradeReminder?: string;
    outstandingTrade?: OutstandingTradeReminderState;
  };
  execution: {
    confirmed: boolean;
    preflight?: ExecutionPreflightState;
    paymentDetailsId?: string;
    tradeRequestId?: string;
    tradeId?: string;
    tradeRequestStatus?: string;
    tradeStatus?: string;
    pendingPriceChange?: {
      originalFiatAmount?: number;
      originalCryptoAmount?: number;
      newFiatAmount?: number;
      newCryptoAmount?: number;
      vendorOfferRate?: number;
      fiatCurrencyCode?: string;
      cryptoCurrencyCode?: string;
      paymentMethodName?: string;
      paymentNetworkName?: string;
    };
    partnerDetailCollection?: PartnerDetailCollectionState;
    settlement?: SettlementMonitorState;
    lastError?: string;
  };
  lastPrompt?: string;
  notes: string[];
}

export interface TransferFlowResult {
  session: TransferSession;
  reply: string;
  options?: string[];
  done: boolean;
  events: TransferFlowEvent[];
}

interface ParsedHints {
  goal?: TransferGoal;
  recipient?: string;
  currency?: string;
  amount?: number;
  savedOrNew?: "saved" | "new";
  changeCurrency?: string;
  changeAmount?: number;
  changeRecipient?: string;
  changeMethod?: boolean;
  goBack?: boolean;
  checkStatus?: boolean;
  cancel?: boolean;
  saveContactDecision?: "yes" | "no";
  confirm?: boolean;
}

const CURRENCY_SYNONYMS: Record<string, string> = {
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  "€": "EUR",
  usd: "USD",
  dollar: "USD",
  dollars: "USD",
  "$": "USD",
  gbp: "GBP",
  pound: "GBP",
  pounds: "GBP",
  "£": "GBP",
  ngn: "NGN",
  naira: "NGN",
  kes: "KES",
  ksh: "KES",
  ghs: "GHS",
  cedi: "GHS",
  cedis: "GHS",
  inr: "INR",
  rupee: "INR",
  rupees: "INR",
};

const AFFIRMATIVE_RE = /^(yes|y|save it|save|update it)$/i;
const CONFIRM_RE = /^(confirm|confirmed|proceed|go ahead|send it|do it|retry|continue)$/i;
const NO_RE = /^(no|n|don'?t|not now|skip save)$/i;
const SKIP_RE = /^(skip|none|leave it blank|not needed)$/i;
const GENERIC_SELECTION_TOKENS = new Set([
  "account",
  "accounts",
  "actually",
  "bank",
  "banks",
  "change",
  "correct",
  "different",
  "digital",
  "do",
  "for",
  "funds",
  "iban",
  "instead",
  "is",
  "make",
  "method",
  "methods",
  "money",
  "network",
  "networks",
  "no",
  "not",
  "now",
  "payment",
  "payments",
  "please",
  "provider",
  "receive",
  "route",
  "send",
  "the",
  "traditional",
  "transfer",
  "transfers",
  "use",
  "via",
  "wallet",
  "wallets",
  "wrong",
]);
const KYC_VERIFIED_STATUSES = new Set(["VERIFIED", "APPROVED", "verified", "approved"]);
const KYC_ACTIVE_STATUSES = new Set(["initial", "pending", "in_progress"]);
const DEFAULT_KYC_VERIFICATION_POLL_INTERVAL_MS = 1_000;
// The frontend keeps polling /kyc until the verification URL appears.
// In chat we still need a ceiling, but 15s was too short and caused Cinnamon
// to give up before the provider URL became available.
const DEFAULT_KYC_VERIFICATION_POLL_TIMEOUT_MS = 60_000;
const COMMON_COUNTRY_CODES: Record<string, string> = {
  estonia: "EE",
  thailand: "TH",
  india: "IN",
  kenya: "KE",
  nigeria: "NG",
  ghana: "GH",
  philippines: "PH",
  uganda: "UG",
  tanzania: "TZ",
  rwanda: "RW",
  unitedstates: "US",
  "united states": "US",
  usa: "US",
  uk: "GB",
  "united kingdom": "GB",
  britain: "GB",
  england: "GB",
  belgium: "BE",
  netherlands: "NL",
  france: "FR",
  germany: "DE",
  spain: "ES",
  italy: "IT",
  portugal: "PT",
  ireland: "IE",
  poland: "PL",
  sweden: "SE",
  norway: "NO",
  finland: "FI",
  denmark: "DK",
  uae: "AE",
  "united arab emirates": "AE",
  singapore: "SG",
  malaysia: "MY",
  indonesia: "ID",
  vietnam: "VN",
  australia: "AU",
  canada: "CA",
};

function nowIso(deps: TransferFlowDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString();
}

function normalizeTurn(turn: TransferTurn | string | undefined): TransferTurn {
  if (typeof turn === "string") return { text: turn };
  return turn || {};
}

function cleanText(text: string | undefined): string {
  return (text || "").trim();
}

function normalizeMatchValue(value: string | undefined | null): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isUserKycVerified(status: string | undefined): boolean {
  return Boolean(status && KYC_VERIFIED_STATUSES.has(status));
}

function buildKycFullName(firstName: string | undefined, lastName: string | undefined): string | undefined {
  const fullName = `${(firstName || "").trim()} ${(lastName || "").trim()}`.trim();
  return fullName || undefined;
}

function resolveCountryCode(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  if (/^[A-Za-z]{2}$/.test(value)) {
    return value.toUpperCase();
  }
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compact = normalized.replace(/\s+/g, "");
  return COMMON_COUNTRY_CODES[normalized] || COMMON_COUNTRY_CODES[compact];
}

const KYC_NON_NAME_TOKENS = new Set([
  "i",
  "im",
  "i'm",
  "wanna",
  "want",
  "to",
  "do",
  "start",
  "continue",
  "complete",
  "platform",
  "website",
  "app",
  "link",
  "verification",
  "verify",
  "kyc",
  "country",
  "legal",
  "name",
  "saved",
  "payment",
  "details",
  "recipient",
  "bank",
  "iban",
  "please",
  "can",
  "you",
  "give",
  "me",
  "my",
  "the",
  "on",
]);

function looksLikePlausibleLegalName(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  if (!/^[A-Za-z][A-Za-z'’. -]*(?:\s+[A-Za-z][A-Za-z'’. -]*)+$/.test(value)) {
    return false;
  }
  const tokens = value.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  return !tokens.some((token) => KYC_NON_NAME_TOKENS.has(token));
}

function hasKycIntent(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  return /\b(kyc|verification|verify identity|identity check|do kyc|start kyc|complete kyc|kyc link|verification link)\b/i.test(value);
}

function asksIfKycIsRequired(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  return /\b(do i need(?: to do)? kyc|is kyc required|will i need kyc|when do i need kyc|do we need kyc)\b/i.test(value);
}

function asksIfKycCanBeDoneEarly(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  return /\b(can i do kyc earlier|can i do kyc early|can i complete kyc earlier|can i complete kyc early|can i do it earlier|can i do it early|before i need kyc|ahead of time|in advance)\b/i.test(value);
}

function wantsToStartKyc(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  return /\b(i wanna do kyc|i want to do kyc|start kyc|begin kyc|complete kyc|do kyc on the platform|open kyc|launch kyc)\b/i.test(value);
}

function wantsKycLink(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  return /\b(give me the kyc link|send me the kyc link|open the kyc link|get the kyc link|give me the verification link|send me the verification link)\b/i.test(value);
}

function parseKycIdentityInput(text: string | undefined): { fullName?: string; countryCode?: string } {
  const value = cleanText(text);
  if (!value) return {};

  const combined = value.match(
    /(?:my\s+)?(?:full\s+legal\s+name|legal\s+name|name)\s+is\s+(.+?)\s+(?:and|,)\s+(?:my\s+)?country\s+is\s+(.+)$/i
  );
  if (combined) {
    const fullName = combined[1]?.trim() || undefined;
    return {
      fullName: looksLikePlausibleLegalName(fullName) ? fullName : undefined,
      countryCode: resolveCountryCode(combined[2]),
    };
  }

  // Accept a natural one-line reply like "Alex Grape, Estonia" while KYC is collecting
  // identity details. Require a comma so we do not steal unrelated free-text turns.
  const commaSeparated = value.match(/^(.+?),\s*([^,]+)$/);
  if (commaSeparated) {
    const fullName = commaSeparated[1]?.trim() || undefined;
    const countryCode = resolveCountryCode(commaSeparated[2]);
    if (fullName && countryCode && looksLikePlausibleLegalName(fullName)) {
      return {
        fullName,
        countryCode,
      };
    }
  }

  const fullNameMatch = value.match(/(?:my\s+)?(?:full\s+legal\s+name|legal\s+name|name)\s+is\s+(.+)$/i);
  const countryMatch = value.match(/(?:my\s+)?country\s+is\s+(.+)$/i);
  const explicitFullName = fullNameMatch?.[1]?.trim() || undefined;

  return {
    fullName: looksLikePlausibleLegalName(explicitFullName) ? explicitFullName : undefined,
    countryCode: resolveCountryCode(countryMatch?.[1]),
  };
}

const DETAIL_LABELS: Record<string, string> = {
  full_name: "Full name",
  iban: "IBAN",
  bic: "BIC",
  swift: "SWIFT",
  phone: "Phone",
  email: "Email",
  bank_name: "Bank name",
  bank_code: "Bank code",
  account_number: "Account number",
  account_name: "Account name",
  username: "Username",
  tag: "Tag",
  handle: "Handle",
  wallet_address: "Wallet address",
  holder_city: "Holder city",
  holder_postal_code: "Postal code",
  holder_street: "Street address",
  country: "Country",
  country_code: "Country",
};

function formatDetailLabel(field: string): string {
  const normalized = field.trim().toLowerCase();
  const known = DETAIL_LABELS[normalized];
  if (known) return known;

  const titleCased = normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.length <= 4 ? part.toUpperCase() : `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
    .join(" ");

  return titleCased || field;
}

function buildHumanDetailBlock(details: Record<string, string>): string | undefined {
  const entries = Object.entries(details).filter(([, value]) => value != null && String(value).trim().length > 0);
  if (!entries.length) return undefined;
  return [
    "Recipient details:",
    ...entries.map(([field, value]) => `• ${formatDetailLabel(field)}: ${value}`),
  ].join("\n");
}

function parseCurrencyToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const trimmed = token.trim();
  const normalized = trimmed.toLowerCase();
  if (CURRENCY_SYNONYMS[normalized]) return CURRENCY_SYNONYMS[normalized];
  if (/^[A-Z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  return undefined;
}

function parseAmountAndCurrency(text: string | undefined): { amount?: number; currency?: string } {
  const value = cleanText(text);
  if (!value) return {};

  const symbolMatch = value.match(/(€|\$|£)\s*(\d+(?:[.,]\d+)?)/i);
  if (symbolMatch) {
    return {
      amount: Number(symbolMatch[2].replace(/,/g, "")),
      currency: parseCurrencyToken(symbolMatch[1]),
    };
  }

  const amountFirst = value.match(/(\d+(?:[.,]\d+)?)\s*(eur|euro|euros|usd|dollar|dollars|gbp|pound|pounds|ngn|naira|kes|ksh|ghs|cedi|cedis|inr|rupee|rupees)\b/i);
  if (amountFirst) {
    return {
      amount: Number(amountFirst[1].replace(/,/g, "")),
      currency: parseCurrencyToken(amountFirst[2]),
    };
  }

  const bareAmount = value.match(/(?:amount|send|transfer|pay)?\s*(\d+(?:[.,]\d+)?)(?!\w)/i);
  if (bareAmount) {
    return { amount: Number(bareAmount[1].replace(/,/g, "")) };
  }

  return {};
}

function parseStandaloneCurrency(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  if (/^[A-Za-z$€£]{1,10}$/.test(value.replace(/\s+/g, ""))) {
    return parseCurrencyToken(value);
  }
  const match = value.match(/\b(eur|euro|euros|usd|dollar|dollars|gbp|pound|pounds|ngn|naira|kes|ksh|ghs|cedi|cedis|inr|rupee|rupees)\b/i);
  return parseCurrencyToken(match?.[1]);
}

function parseRecipient(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  const toMatch = value.match(/\b(?:to|for)\s+([a-z0-9][a-z0-9 .,'@_-]{1,60})$/i);
  if (toMatch) {
    const candidate = toMatch[1].trim();
    if (!/\b(transfer|later|wallet|currency|method|status|contact)\b/i.test(candidate) && !/^make\b/i.test(candidate)) {
      return candidate;
    }
  }

  const lower = value.toLowerCase();
  const looksLikeInstruction = /\b(send|transfer|pay|make|want|contact|recipient|currency|method|wallet|status|saved|new)\b/.test(lower);
  if (looksLikeInstruction) return undefined;

  if (/^[A-Za-z][A-Za-z .,'_-]{1,60}$/.test(value)) return value.trim();
  return undefined;
}

function parseSavedContactRecipient(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  const patterns = [
    /\b(?:saved contact|existing contact|someone saved)\s+(?:named\s+)?([a-z0-9][a-z0-9 .,'@_-]{1,60})$/i,
    /\b(?:payment details|saved details|saved payout details|payout details)\s+saved(?:\s+for)?\s+([a-z0-9][a-z0-9 .,'@_-]{1,60})$/i,
    /\b(?:have|has)\s+([a-z0-9][a-z0-9 .,'@_-]{1,60}?)'?s\s+(?:payment details|saved details|saved payout details|payout details)\s+saved\b/i,
  ];
  const candidate = patterns
    .map((pattern) => value.match(pattern)?.[1]?.trim().replace(/[!?.,]+$/g, ""))
    .find((match): match is string => Boolean(match));
  if (!candidate) return undefined;
  if (/\b(currency|amount|method|wallet|status)\b/i.test(candidate)) return undefined;
  return candidate;
}

function hasSavedRecipientLookupIntent(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  return /\b(saved contact|existing contact|someone saved|payment details saved|saved payment details|saved payout details|saved details|payout details saved)\b/i.test(value);
}

function parseIntentHints(text: string | undefined): ParsedHints {
  const value = cleanText(text);
  if (!value) return {};
  const lower = value.toLowerCase();
  const amountCurrency = parseAmountAndCurrency(value);

  const hints: ParsedHints = {
    ...(amountCurrency.amount ? { amount: amountCurrency.amount } : {}),
    ...(amountCurrency.currency ? { currency: amountCurrency.currency } : {}),
  };

  if (/(?:\bsave\b|\badd\b).*(?:contact|recipient)|contact only|for later/.test(lower)) {
    hints.goal = "save_contact_only";
  }
  if (/make a transfer|send money|send|transfer|pay /.test(lower) && !hints.goal) {
    hints.goal = "transfer";
  }
  if (hasSavedRecipientLookupIntent(value)) {
    hints.savedOrNew = "saved";
  }
  if (/new recipient|new contact|someone new/.test(lower)) {
    hints.savedOrNew = "new";
  }
  const recipient = parseRecipient(value) || (hints.savedOrNew === "saved" ? parseSavedContactRecipient(value) : undefined);
  if (recipient) hints.recipient = recipient;

  const standaloneCurrency = parseStandaloneCurrency(value);
  if (!hints.currency && standaloneCurrency) hints.currency = standaloneCurrency;

  const changeCurrency = value.match(/change currency(?: to)?\s+([A-Za-z$€£]{2,10})/i);
  if (changeCurrency) hints.changeCurrency = parseCurrencyToken(changeCurrency[1]);

  const changeAmount = value.match(/change amount(?: to)?\s*(€|\$|£)?\s*(\d+(?:[.,]\d+)?)(?:\s*([A-Za-z]{3}))?/i);
  if (changeAmount) {
    hints.changeAmount = Number(changeAmount[2].replace(/,/g, ""));
    hints.changeCurrency = hints.changeCurrency || parseCurrencyToken(changeAmount[1] || changeAmount[3]);
  }

  if (/\b(status|check status|what'?s the status|update)\b/.test(lower)) {
    hints.checkStatus = true;
  }
  if (/^(cancel|stop|nevermind|never mind)$/i.test(value)) {
    hints.cancel = true;
  }
  if (/\b(go back|undo|previous step|back up|step back|redo)\b/.test(lower)) {
    hints.goBack = true;
  }
  if (/\b(change (?:payment )?method|different (?:payment )?method|switch (?:payment )?method|try (?:a )?different (?:way|method|option)|another (?:payment )?method|different provider|change provider)\b/.test(lower)) {
    hints.changeMethod = true;
  }
  const changeRecipientMatch = value.match(/\b(?:change|switch|different)\s+(?:recipient|person|payee)\s*(?:to\s+)?(.+)?/i);
  if (changeRecipientMatch) {
    hints.changeRecipient = changeRecipientMatch[1]?.trim() || "";
  }
  if (/\b(send to someone else|pay someone else|different recipient|different person)\b/.test(lower)) {
    hints.changeRecipient = hints.changeRecipient ?? "";
  }
  if (CONFIRM_RE.test(value)) {
    hints.confirm = true;
  }
  if (AFFIRMATIVE_RE.test(value)) {
    hints.saveContactDecision = "yes";
  } else if (NO_RE.test(value)) {
    hints.saveContactDecision = "no";
  }

  return hints;
}

function createSession(goal: TransferGoal, deps: TransferFlowDeps): TransferSession {
  const timestamp = nowIso(deps);
  return {
    id: `transfer-${Date.now()}`,
    goal,
    status: "active",
    stage: "resolving",
    startedAt: timestamp,
    updatedAt: timestamp,
    details: {},
    detailCollection: { index: 0 },
    contactExists: false,
    contactStale: false,
    auth: {
      checked: false,
      available: false,
      startupSnapshotShown: false,
      outstandingTradeReminderShown: false,
    },
    execution: {
      confirmed: false,
    },
    notes: [],
  };
}

function withUpdate(session: TransferSession, deps: TransferFlowDeps): TransferSession {
  session.updatedAt = nowIso(deps);
  return session;
}

function buildStartupAuthSnapshot(session: TransferSession): string | undefined {
  const parts: string[] = [];
  const senderLine = buildSenderLine(session.auth.username);
  if (senderLine) parts.push(senderLine);
  const balanceLine = buildWalletBalanceLine(session.auth.walletBalance, session.auth.balanceUsd);
  if (balanceLine) {
    parts.push(balanceLine);
  }
  if (session.auth.outstandingTradeReminder) {
    parts.push(session.auth.outstandingTradeReminder);
  }
  return parts.length ? parts.join(" ") : undefined;
}

function clearPendingSavedRecipientConfirmation(session: TransferSession): void {
  session.pendingSavedRecipientConfirmation = undefined;
}

function isExplicitReceiptResponse(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  if (/^(yes|no)$/i.test(value)) return false;
  return /\b(receiv(?:e|ed)|arriv(?:e|ed)|got|money|funds|payment|paid|not yet|didn'?t|did not|hasn'?t|have not)\b/i.test(value);
}

function shouldDoubleConfirmSavedRecipient(resolution: ContactResolution, query: string): boolean {
  if (!resolution.match) return false;
  return normalizeLookupValue(query) !== normalizeLookupValue(resolution.match.contact.name);
}

function buildSavedRecipientConfirmationPrompt(pending: PendingSavedRecipientConfirmationState): string {
  const route = getSingleStoredPaymentSetup(pending.match.contact);
  const routeLine = route ? ` (${summarizeStoredPaymentRoute(route.currency, route.method)})` : "";
  const sourceLine = pending.source === "remote" ? "saved UNIGOX payout details" : "saved contact";
  return `I think you mean ${sourceLine} for ${pending.match.contact.name}${routeLine}. Should I use that saved recipient?`;
}

function startSavedRecipientConfirmation(
  session: TransferSession,
  resolution: ContactResolution,
  source: "local" | "remote",
  query: string
): string | undefined {
  if (!resolution.match) return undefined;
  session.pendingSavedRecipientConfirmation = {
    source,
    query,
    matchedBy: resolution.matchedBy || "fuzzy",
    match: resolution.match,
  };
  session.stage = "awaiting_saved_recipient_confirmation";
  return buildSavedRecipientConfirmationPrompt(session.pendingSavedRecipientConfirmation);
}

function acceptPendingSavedRecipientConfirmation(session: TransferSession): string | undefined {
  const pending = session.pendingSavedRecipientConfirmation;
  if (!pending) return undefined;

  const pendingResolution: ContactResolution = {
    match: pending.match,
    ambiguous: [],
    matchedBy: pending.matchedBy,
  };
  const note = pending.source === "remote"
    ? `Okay — I’ll use saved UNIGOX payout details for ${pending.match.contact.name}.`
    : `Okay — I’ll use the saved contact ${pending.match.contact.name}.`;
  applyResolvedSavedRecipient(session, pendingResolution, pending.source, pending.query);
  session.recipientQuery = pending.match.contact.name;
  clearPendingSavedRecipientConfirmation(session);
  session.stage = "resolving";
  return note;
}

function clearOutstandingTradeReminder(session: TransferSession): void {
  session.auth.outstandingTradeReminder = undefined;
  session.auth.outstandingTrade = undefined;
  session.auth.outstandingTradeReminderShown = true;
}

function buildTransferContinuationPrompt(session: TransferSession): string | undefined {
  if (session.goal !== "transfer") return undefined;

  if (session.recipientName && session.currency && !session.amount) {
    return `How much ${session.currency} should I send to ${session.recipientName} now?`;
  }

  if (session.recipientName && !session.currency) {
    return `Which currency should ${session.recipientName} receive?`;
  }

  if (!session.recipientName) {
    return "Who do you want to send money to?";
  }

  return undefined;
}

function decorateStartupReply(session: TransferSession, message: string): string {
  if (session.goal !== "transfer" || !session.auth.available || session.auth.startupSnapshotShown) return message;

  const snapshot = buildStartupAuthSnapshot(session);
  if (!snapshot) return message;

  const snapshotParts: string[] = [];
  if (!/sending as/i.test(message)) {
    const senderLine = buildSenderLine(session.auth.username);
    if (senderLine) snapshotParts.push(senderLine);
  }
  if (!/Current wallet balance:/i.test(message)) {
    const balanceLine = buildWalletBalanceLine(session.auth.walletBalance, session.auth.balanceUsd);
    if (balanceLine) {
      snapshotParts.push(balanceLine);
    }
  }
  if (session.auth.outstandingTradeReminder && !message.includes(session.auth.outstandingTradeReminder)) {
    snapshotParts.push(session.auth.outstandingTradeReminder);
  }

  session.auth.startupSnapshotShown = true;
  session.auth.outstandingTradeReminderShown = true;
  if (!snapshotParts.length) return message;
  return `${snapshotParts.join(" ")} ${message}`;
}

function reply(session: TransferSession, message: string, options?: string[], events: TransferFlowEvent[] = []): TransferFlowResult {
  const finalMessage = decorateStartupReply(session, message);
  session.lastPrompt = finalMessage;
  return {
    session,
    reply: finalMessage,
    options,
    done: session.status === "completed" || session.status === "cancelled",
    events,
  };
}

export function loadSendMoneySettings(filePath = DEFAULT_SETTINGS_FILE): AgenticPaymentsSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const tradePartner = ["licensed", "p2p", "all"].includes(parsed.tradePartner)
      ? parsed.tradePartner
      : "licensed";
    return { tradePartner };
  } catch {
    return { tradePartner: "licensed" };
  }
}

/**
 * Reports whether this installation holds everything needed to send without asking for credentials.
 *
 * @returns `hasReplayableAuth` is true when every required Partner API setting is present;
 *   `missingSettings` names the ones that are not. Reads the environment and the skill's `.env` files.
 */
export function detectAuthState(): AuthState {
  const { missingSettings } = loadPartnerApiConfigFromEnv();
  return { hasReplayableAuth: missingSettings.length === 0, missingSettings };
}

/**
 * Returns the backend for this run.
 *
 * @param deps Flow collaborators. An injected `client` wins, then `clientFactory`, then a Partner
 *   API client built from the environment.
 * @returns The transfer execution client.
 * @throws Error naming the missing settings when nothing is injected and the environment is incomplete.
 */
async function getExecutionClient(deps: TransferFlowDeps, _session?: TransferSession): Promise<TransferExecutionClient> {
  if (deps.client) return deps.client;
  if (deps.clientFactory) return deps.clientFactory();
  const { config, missingSettings } = loadPartnerApiConfigFromEnv();
  if (!config) {
    throw new Error(`UNIGOX Partner API settings are missing: ${missingSettings.join(", ")}`);
  }
  return new PartnerExecutionClient(new PartnerApiClient(config), {
    matchPollIntervalMs: deps.settlementPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: deps.sleep,
  });
}

/**
 * Returns the payout method catalogue for this run.
 *
 * @param deps Flow collaborators. Injected catalogue functions win; otherwise the public Partner API
 *   catalogue of the configured host is used, which needs no API key.
 * @returns The two catalogue operations.
 */
function resolvePaymentCatalogue(deps: TransferFlowDeps): PaymentCatalogue {
  if (deps.getPaymentMethodsForCurrency && deps.getPaymentMethodFieldConfig) {
    return {
      getPaymentMethodsForCurrency: deps.getPaymentMethodsForCurrency,
      getPaymentMethodFieldConfig: deps.getPaymentMethodFieldConfig,
    };
  }
  const catalogue = createPaymentCatalogue({ apiUrl: loadPartnerApiConfigFromEnv().apiUrl });
  return {
    getPaymentMethodsForCurrency: deps.getPaymentMethodsForCurrency ?? catalogue.getPaymentMethodsForCurrency,
    getPaymentMethodFieldConfig: deps.getPaymentMethodFieldConfig ?? catalogue.getPaymentMethodFieldConfig,
  };
}

function clearExecutionPreflight(session: TransferSession): void {
  session.execution.preflight = undefined;
}

function clearBalanceSnapshot(session: TransferSession): void {
  session.auth.balanceUsd = undefined;
  session.auth.walletBalance = undefined;
}

function invalidateBalanceState(session: TransferSession): void {
  clearBalanceSnapshot(session);
  clearExecutionPreflight(session);
}

/**
 * Stops the flow until the Partner API settings are configured, and says what is missing.
 *
 * This is the one reply that names environment settings: setting them is the person's task here.
 * It never includes a setting's value.
 *
 * @param session Current session. Moves to `awaiting_setup` with status `blocked`.
 * @param deps Flow collaborators.
 * @returns The setup reply with a `blocked_missing_auth` event.
 */
function replyWithSetupInstructions(session: TransferSession, deps: TransferFlowDeps): TransferFlowResult {
  session.status = "blocked";
  session.stage = "awaiting_setup";
  const missing = session.auth.missingSettings?.length
    ? ` Missing settings: ${session.auth.missingSettings.join(", ")}.`
    : "";
  const prompt = [
    "This skill is not connected to UNIGOX yet, so I can't send money.",
    `It needs a UNIGOX Partner API key, the partner wallet key, an XAI node address and the sender's email.${missing}`,
    "Add them to the skill's .env file as described in docs/authentication.md, then send your request again.",
    "Please don't paste keys into this chat.",
  ].join(" ");
  return reply(withUpdate(session, deps), prompt, undefined, [{ type: "blocked_missing_auth", message: prompt }]);
}

/**
 * Builds the line that tells the person which UNIGOX sender this installation sends for.
 *
 * @param sender The sender's display name, which is their email on the Partner API.
 * @returns One sentence, or `undefined` when the sender is not known yet.
 */
function buildSenderLine(sender: string | undefined): string | undefined {
  return sender ? `You're sending as ${sender} from the UNIGOX partner wallet.` : undefined;
}

function getInitiatorTradeRecipientName(trade: InitiatorTradeSummary | undefined): string | undefined {
  const details = trade?.initiator_payment_details?.details;
  if (!details || typeof details !== "object") return undefined;
  const candidates = [
    (details as Record<string, unknown>).full_name,
    (details as Record<string, unknown>).name,
  ];
  for (const candidate of candidates) {
    const value = cleanText(typeof candidate === "string" ? candidate : undefined);
    if (value) return value;
  }
  return undefined;
}

function getInitiatorTradeActionPhase(trade: InitiatorTradeSummary | undefined): SettlementPhase | undefined {
  if (!trade?.status) return undefined;
  if (trade.status === "trade_created" && trade.partner_short_name && trade.partner_details_checked_at == null) {
    return "awaiting_partner_payment_details";
  }
  if (trade.payment_request === true && trade.status === "awaiting_escrow_funding_by_seller" && !trade.initiator_payment_details) {
    return "awaiting_buyer_payment_details";
  }
  switch (trade.status) {
    case "trade_created":
    case "awaiting_escrow_funding_by_seller":
      return "awaiting_escrow_funding";
    case "fiat_payment_proof_submitted_by_buyer":
    case "fiat_payment_proof_accepted_by_system":
      return "awaiting_receipt_confirmation";
    default:
      return undefined;
  }
}

function pickOutstandingActionTrade(trades: InitiatorTradeSummary[]): InitiatorTradeSummary | undefined {
  const candidates = trades
    .map((trade) => ({ trade, phase: getInitiatorTradeActionPhase(trade) }))
    .filter((entry): entry is { trade: InitiatorTradeSummary; phase: SettlementPhase } => !!entry.phase);

  if (!candidates.length) return undefined;

  const phasePriority: Record<SettlementPhase, number> = {
    awaiting_receipt_confirmation: 0,
    awaiting_partner_payment_details: 1,
    awaiting_buyer_payment_details: 2,
    awaiting_escrow_funding: 3,
    matching: 4,
    waiting_for_fiat: 5,
    receipt_confirmed_release_started: 6,
    completed: 7,
    refunded_or_cancelled: 8,
    deferred: 9,
  };

  candidates.sort((a, b) => {
    const priorityDelta = (phasePriority[a.phase] ?? 99) - (phasePriority[b.phase] ?? 99);
    if (priorityDelta !== 0) return priorityDelta;
    const aTime = Date.parse(a.trade.status_changed_at || "") || 0;
    const bTime = Date.parse(b.trade.status_changed_at || "") || 0;
    return bTime - aTime;
  });

  return candidates[0]?.trade;
}

function buildOutstandingTradeReminderState(trade: InitiatorTradeSummary | undefined): OutstandingTradeReminderState | undefined {
  if (!trade?.id) return undefined;
  const phase = getInitiatorTradeActionPhase(trade);
  const recipient = getInitiatorTradeRecipientName(trade);
  if (!phase || !recipient) return undefined;
  return {
    tradeId: trade.id,
    phase,
    recipient,
    fiatAmount: trade.fiat_amount ?? undefined,
    fiatCurrencyCode: trade.fiat_currency_code ?? undefined,
  };
}

function buildOutstandingTradeReminder(trade: InitiatorTradeSummary | undefined): string | undefined {
  const phase = getInitiatorTradeActionPhase(trade);
  if (!trade || !phase) return undefined;

  const recipient = getInitiatorTradeRecipientName(trade) || "the recipient";
  const fiatAmount = typeof trade.fiat_amount === "number" && trade.fiat_currency_code
    ? `${formatFixed(trade.fiat_amount, 2)} ${trade.fiat_currency_code}`
    : "that transfer";

  switch (phase) {
    case "awaiting_receipt_confirmation":
      return `By the way, your earlier ${fiatAmount} transfer to ${recipient} may already have arrived or still be on the way from the counterparty bank. Did ${recipient} receive it already?`;
    case "awaiting_partner_payment_details":
    case "awaiting_buyer_payment_details":
      return `By the way, your earlier ${fiatAmount} transfer to ${recipient} still needs one more payout detail before it can continue.`;
    case "awaiting_escrow_funding":
      return `By the way, your earlier ${fiatAmount} transfer to ${recipient} is matched and still needs to be secured before it can continue.`;
    default:
      return undefined;
  }
}

function formatFixed(value: number, digits = 2): string {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatQuoteAmount(value: number, currency: string, digits = 4): string {
  return `${formatFixed(value, digits)} ${currency}`;
}

function formatRate(value: number, baseCurrency: string, quoteCurrency: string): string {
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return `1 ${baseCurrency} ≈ ${formatFixed(value, digits)} ${quoteCurrency}`;
}

function formatUsdAmount(value: number): string {
  return value.toFixed(2);
}

const SELLABLE_ASSET_ORDER = ["USDC", "USDT"] as const;

/**
 * How long one turn waits for a provider to accept a placed transfer, in milliseconds, unless the
 * caller sets `waitForMatchTimeoutMs`. Carried over from the previous client, which waited two minutes.
 */
const DEFAULT_WAIT_FOR_MATCH_TIMEOUT_MS = 120_000;

/** How the person funds the partner wallet. Source: "Funding your wallet" guide (My Wallet on unigox.com). */
const FUND_PARTNER_WALLET_PROMPT = "Add USDC or USDT to the partner wallet in My Wallet on unigox.com, then tell me to recheck the balance. You can also change the amount.";

/** Choices offered while a transfer waits for the partner wallet to be funded. */
const BALANCE_RESOLUTION_OPTIONS = ["recheck balance", "change amount"] as const;

function getWalletBalanceAssets(balance: WalletBalance | undefined): WalletBalanceAsset[] {
  if (!balance) return [];

  const preferred = balance.assets?.length
    ? balance.assets
    : [
        { assetCode: "USDC", amount: balance.usdc },
        { assetCode: "USDT", amount: balance.usdt },
      ];

  const byAsset = new Map<string, number>();
  for (const entry of preferred) {
    if (!entry?.assetCode) continue;
    byAsset.set(entry.assetCode.toUpperCase(), Number(entry.amount || 0));
  }

  if (!byAsset.has("USDC")) byAsset.set("USDC", Number(balance.usdc || 0));
  if (!byAsset.has("USDT")) byAsset.set("USDT", Number(balance.usdt || 0));

  const order = new Map<string, number>(SELLABLE_ASSET_ORDER.map((asset, index) => [asset, index]));
  return Array.from(byAsset.entries())
    .map(([assetCode, amount]) => ({ assetCode, amount }))
    .sort((a, b) => (order.get(a.assetCode) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.assetCode) ?? Number.MAX_SAFE_INTEGER) || a.assetCode.localeCompare(b.assetCode));
}

function buildWalletBalanceLine(balance: WalletBalance | undefined, fallbackTotalUsd?: number): string | undefined {
  if (!balance && typeof fallbackTotalUsd !== "number") return undefined;
  const assets = getWalletBalanceAssets(balance);
  const totalUsd = typeof balance?.totalUsd === "number"
    ? balance.totalUsd
    : typeof fallbackTotalUsd === "number"
      ? fallbackTotalUsd
      : assets.reduce((sum, entry) => sum + entry.amount, 0);
  const assetSummary = assets.length
    ? assets.map((entry) => `${entry.assetCode}: ${formatUsdAmount(entry.amount)} USD`).join(", ")
    : undefined;
  return assetSummary
    ? `Current wallet balance: ${formatUsdAmount(totalUsd)} USD total (${assetSummary}).`
    : `Current wallet balance: ${formatUsdAmount(totalUsd)} USD.`;
}

function getSelectedAssetCoverage(preflight: ExecutionPreflightState | undefined): AssetCoverageState | undefined {
  if (!preflight?.assetCoverage?.length) return undefined;
  return preflight.assetCoverage.find((entry) => entry.assetCode === preflight.selectedAssetCode);
}

function buildAssetCoverageLine(preflight: ExecutionPreflightState | undefined): string | undefined {
  if (!preflight?.assetCoverage?.length) return undefined;
  const selected = getSelectedAssetCoverage(preflight);
  if (selected) {
    return `One SELL trade must be covered by a single asset. This transfer is currently coverable with ${selected.assetCode}.`;
  }
  if (!preflight.aggregateBalanceEnoughButSingleAssetInsufficient) return undefined;
  const coverage = preflight.assetCoverage
    .map((entry) => `${entry.assetCode}: ${formatUsdAmount(entry.balanceUsd)} available, needs about ${formatUsdAmount(entry.requiredUsd)}`)
    .join("; ");
  return `Your total wallet balance is high enough in aggregate, but one SELL trade must be funded by a single asset, not a combined USDC + USDT balance. Coverage right now: ${coverage}.`;
}

function buildPreflightQuoteSummary(preflight: ExecutionPreflightState | undefined): string | undefined {
  const quote = preflight?.quote;
  if (!quote) return undefined;
  const route = [quote.paymentMethodName, quote.paymentNetworkName].filter(Boolean).join(" / ");
  const feePart = quote.feeCryptoAmount > 0 ? ` (includes ~${formatQuoteAmount(quote.feeCryptoAmount, quote.cryptoCurrencyCode)})` : "";
  const routePart = route ? ` via ${route}` : "";
  return `Current best-offer estimate: ${formatQuoteAmount(quote.totalCryptoAmount, quote.cryptoCurrencyCode)} total to deliver ${formatFixed(quote.fiatAmount, 2)} ${quote.fiatCurrencyCode}${feePart} at ${formatRate(quote.vendorOfferRate, quote.cryptoCurrencyCode, quote.fiatCurrencyCode)}${routePart}.`;
}

function buildPreflightQuoteCaveat(preflight: ExecutionPreflightState | undefined): string | undefined {
  if (!preflight?.quote) return undefined;
  return "This is a live estimate from the current best offer, not a locked quote, so the final rate / required amount can still change when the trade request is created and matched.";
}

function getRequiredBalanceUsd(preflight: ExecutionPreflightState | undefined): number | undefined {
  if (!preflight) return undefined;
  return preflight.sellAssetRequiredUsd ?? preflight.quote?.totalCryptoAmount ?? preflight.amount;
}

function getTopUpShortfallUsd(preflight: ExecutionPreflightState | undefined): number | undefined {
  const required = getRequiredBalanceUsd(preflight);
  if (required === undefined) return undefined;
  const balance = preflight?.sellAssetBalanceUsd ?? preflight?.balanceUsd;
  if (balance === undefined) return undefined;
  return Math.max(required - balance, 0);
}

function buildTopUpShortfallLine(preflight: ExecutionPreflightState | undefined): string | undefined {
  const shortfall = getTopUpShortfallUsd(preflight);
  if (shortfall === undefined || shortfall <= 0) return undefined;
  if (preflight?.assetCoverage?.length) {
    return `You need about ${formatUsdAmount(shortfall)} USD more in one asset before I can place the trade.`;
  }
  return `You need about ${formatUsdAmount(shortfall)} USD more in the wallet before I can place the trade.`;
}

function compareAssetCoverage(a: AssetCoverageState, b: AssetCoverageState): number {
  if (a.coversTransfer !== b.coversTransfer) return a.coversTransfer ? -1 : 1;
  if (a.shortfallUsd !== b.shortfallUsd) return a.shortfallUsd - b.shortfallUsd;
  if (a.requiredUsd !== b.requiredUsd) return a.requiredUsd - b.requiredUsd;
  return (SELLABLE_ASSET_ORDER.indexOf(a.assetCode as typeof SELLABLE_ASSET_ORDER[number]) === -1 ? Number.MAX_SAFE_INTEGER : SELLABLE_ASSET_ORDER.indexOf(a.assetCode as typeof SELLABLE_ASSET_ORDER[number]))
    - (SELLABLE_ASSET_ORDER.indexOf(b.assetCode as typeof SELLABLE_ASSET_ORDER[number]) === -1 ? Number.MAX_SAFE_INTEGER : SELLABLE_ASSET_ORDER.indexOf(b.assetCode as typeof SELLABLE_ASSET_ORDER[number]));
}

async function buildAssetCoverageState(params: {
  client: TransferExecutionClient;
  balance: WalletBalance;
  amount: number;
  currency: string;
  paymentMethodSlug?: string;
  paymentNetworkSlug?: string;
  tradePartner: AgenticPaymentsSettings["tradePartner"];
}): Promise<{
  assetCoverage: AssetCoverageState[];
  selected?: AssetCoverageState;
  best?: AssetCoverageState;
  quote?: PreflightQuote;
  selectedAssetCode?: string;
  sellAssetBalanceUsd?: number;
  sellAssetRequiredUsd?: number;
  aggregateBalanceEnoughButSingleAssetInsufficient: boolean;
}> {
  const assets = getWalletBalanceAssets(params.balance)
    .filter((entry) => SELLABLE_ASSET_ORDER.includes(entry.assetCode as typeof SELLABLE_ASSET_ORDER[number]));

  const assetCoverage = await Promise.all(assets.map(async (asset) => {
    let quote: PreflightQuote | undefined;
    if (params.client.getPreflightQuote) {
      try {
        quote = await params.client.getPreflightQuote({
          cryptoCurrencyCode: asset.assetCode,
          fiatCurrencyCode: params.currency,
          fiatAmount: params.amount,
          paymentMethodSlug: params.paymentMethodSlug,
          paymentNetworkSlug: params.paymentNetworkSlug,
          tradePartner: params.tradePartner,
        });
      } catch {
        // Asset quote lookup is a UX improvement; fall back to rough amount coverage.
      }
    }

    const requiredUsd = quote?.totalCryptoAmount ?? params.amount;
    const shortfallUsd = Math.max(requiredUsd - asset.amount, 0);
    return {
      assetCode: asset.assetCode,
      balanceUsd: asset.amount,
      requiredUsd,
      shortfallUsd,
      coversTransfer: shortfallUsd <= 0,
      quote,
    } satisfies AssetCoverageState;
  }));

  const ordered = [...assetCoverage].sort(compareAssetCoverage);
  const selected = ordered.find((entry) => entry.coversTransfer);
  const best = ordered[0];
  const requiredForAggregate = best?.requiredUsd ?? params.amount;
  return {
    assetCoverage: ordered,
    selected,
    best,
    quote: selected?.quote ?? best?.quote,
    selectedAssetCode: selected?.assetCode,
    sellAssetBalanceUsd: selected?.balanceUsd ?? best?.balanceUsd,
    sellAssetRequiredUsd: selected?.requiredUsd ?? best?.requiredUsd,
    aggregateBalanceEnoughButSingleAssetInsufficient: Boolean(!selected && params.balance.totalUsd >= requiredForAggregate),
  };
}

function wantsBalanceRecheck(text: string | undefined): boolean {
  return /^(recheck|check|refresh|retry|continue|done|funded|topped up|balance updated|try again)(?:\s+balance)?$/i.test(cleanText(text));
}

async function maybeHydrateAuthIdentity(
  session: TransferSession,
  deps: TransferFlowDeps,
  client?: TransferExecutionClient
): Promise<void> {
  if (!session.auth.available) return;
  const executionClient = client || await getExecutionClient(deps, session);
  if (!executionClient.getProfile) return;
  try {
    const profile = await executionClient.getProfile();
    if (profile?.username) {
      session.auth.username = profile.username;
    }
    const fullName = buildKycFullName(profile.first_name, profile.last_name);
    if (fullName) {
      session.auth.kycFullName = fullName;
    }
    if (profile.kyc_country_code) {
      session.auth.kycCountryCode = profile.kyc_country_code.toUpperCase();
    }
    if (profile.id_verification_status) {
      session.auth.kycStatus = profile.id_verification_status;
    }
  } catch {
    // Username is a nice UX enhancement, not a hard blocker.
  }
}

async function maybeHydrateStartupAuthStatus(
  session: TransferSession,
  deps: TransferFlowDeps,
  client?: TransferExecutionClient
): Promise<void> {
  if (!session.auth.available) return;

  let executionClient: TransferExecutionClient;
  try {
    executionClient = client || await getExecutionClient(deps, session);
  } catch {
    return;
  }

  await maybeHydrateAuthIdentity(session, deps, executionClient);

  if (typeof session.auth.balanceUsd === "number" && session.auth.walletBalance) return;
  try {
    const balance = await executionClient.getWalletBalance();
    session.auth.balanceUsd = balance.totalUsd;
    session.auth.walletBalance = balance;
  } catch {
    // Early balance surfacing improves UX but should not block the flow.
  }

  if (!session.execution.tradeRequestId && !session.auth.outstandingTradeReminderShown && !session.auth.outstandingTradeReminder && executionClient.listInitiatorTrades) {
    try {
      const trades = await executionClient.listInitiatorTrades("action_required");
      const outstanding = pickOutstandingActionTrade(trades);
      session.auth.outstandingTrade = buildOutstandingTradeReminderState(outstanding);
      session.auth.outstandingTradeReminder = buildOutstandingTradeReminder(outstanding);
    } catch {
      // Startup reminders are helpful, but should never block the main send flow.
    }
  }
}

function resetPaymentSelection(session: TransferSession): void {
  session.payment = undefined;
  session.details = {};
  session.detailCollection = { index: 0 };
  session.saveContactDecision = undefined;
  session.contactSaveAction = session.contactExists ? "update" : "create";
  session.execution.confirmed = false;
  session.execution.paymentDetailsId = undefined;
  clearExecutionPreflight(session);
}

function setCurrency(session: TransferSession, currency: string): void {
  session.currency = currency.toUpperCase();
  resetPaymentSelection(session);
}

function looksLikeTopUpCompletion(text: string): boolean {
  return /\b(i added more|added more|top(?: |-)?up(?:ped)?|funded|sent funds|balance updated|check again|try again|try now|wallet funded|i deposited|deposited)\b/i.test(cleanText(text));
}

function summarizePayment(session: TransferSession): string {
  if (!session.payment) return "payment method pending";
  return `${session.payment.methodName} via ${session.payment.networkName}`;
}

function buildConfirmationMessage(session: TransferSession): string {
  const balanceLine = typeof session.execution.preflight?.balanceUsd === "number"
    ? buildWalletBalanceLine({
        usdc: session.execution.preflight.walletBalanceAssets?.find((entry) => entry.assetCode === "USDC")?.amount || 0,
        usdt: session.execution.preflight.walletBalanceAssets?.find((entry) => entry.assetCode === "USDT")?.amount || 0,
        totalUsd: session.execution.preflight.balanceUsd,
        assets: session.execution.preflight.walletBalanceAssets,
      }, session.execution.preflight.balanceUsd)
    : undefined;
  const displayDetails = isEurSepaIban(session)
    ? Object.fromEntries(Object.entries(session.details).filter(([k]) => k !== "bank_name"))
    : session.details;
  const detailBlock = buildHumanDetailBlock(displayDetails);
  return [
    buildSenderLine(session.auth.username),
    balanceLine,
    buildPreflightQuoteSummary(session.execution.preflight),
    buildAssetCoverageLine(session.execution.preflight),
    buildPreflightQuoteCaveat(session.execution.preflight),
    `Send ${session.amount} ${session.currency} to ${session.recipientName} via ${summarizePayment(session)}?`,
    detailBlock,
    "Reply 'confirm' to place the trade, or tell me what to change.",
  ].filter(Boolean).join("\n\n");
}



/**
 * Explains that the sender must be verified before this transfer, and how.
 *
 * @param session Current session; its amount and currency are named when known.
 * @returns The explanation with the three steps the person goes through.
 */
function buildKycRequirementMessage(session: TransferSession): string {
  return [
    `To continue with this ${session.amount ? `${session.amount} ${session.currency}` : "transfer"}, UNIGOX needs KYC first.`,
    "UNIGOX requires the sender's identity to be verified before every transfer, whatever the amount.",
    "The steps are simple:",
    "1. You give me your full legal name and country.",
    "2. I give you a secure link to the verification page.",
    "3. Once UNIGOX approves it, I continue the transfer.",
  ].join(" ");
}

function buildKycCountryPrompt(session: TransferSession): string {
  return [
    buildKycRequirementMessage(session),
    "Which country should I use for KYC?",
    "Send the country name or the 2-letter country code, for example EE.",
  ].join(" ");
}

/**
 * Answers "do I need KYC?" for the current sender.
 *
 * @param session Current session with the sender's last known verification status.
 * @returns One sentence: already verified, or verification is required before any transfer.
 */
function buildKycEligibilityMessage(session: TransferSession): string {
  if (isUserKycVerified(session.auth.kycStatus)) {
    return "The sender is already verified on UNIGOX, so there is no KYC step in this flow.";
  }
  return "UNIGOX requires the sender's identity to be verified before any transfer, whatever the amount. I can start that with you now.";
}

function buildCurrentKycStepHint(session: TransferSession): string | undefined {
  if (session.stage === "awaiting_kyc_full_name") {
    return "To continue right now, send the full legal name I should use for the verification.";
  }
  if (session.stage === "awaiting_kyc_country") {
    return "To continue right now, send the country name or the 2-letter country code I should use for the verification.";
  }
  if (session.stage === "awaiting_kyc_completion") {
    if (session.auth.kycVerificationUrl) {
      return `The live verification link is ready here: ${session.auth.kycVerificationUrl}`;
    }
    return "The KYC session is already in progress. If the live link has not appeared yet, message me again and I’ll re-check it immediately.";
  }
  return undefined;
}

/**
 * Opens a reply about a verification that is still in progress.
 *
 * @param session Current session; its amount and currency are named when known.
 * @returns One sentence saying the transfer waits for verification.
 */
function buildKycPendingMessage(session: TransferSession): string {
  return `To continue with this ${session.amount ? `${session.amount} ${session.currency}` : "transfer"}, UNIGOX needs KYC first.`;
}

function buildKycVerificationLinkMessage(session: TransferSession, data: KycVerificationData): string {
  const link = data.verification_url || session.auth.kycVerificationUrl;
  const status = data.status || session.auth.kycStatus;
  const statusLine = link
    ? "The verification link is ready."
    : status && KYC_ACTIVE_STATUSES.has(status)
      ? "I’ve started the verification."
      : "UNIGOX has started the verification.";
  return [
    buildKycPendingMessage(session),
    statusLine,
    link
      ? `Open this link and complete the checks on the verification site: ${link}`
      : "UNIGOX has started the verification, but the secure link has not appeared yet. This can take a little longer on the provider side. Message me again and I’ll re-check immediately.",
    "Once UNIGOX shows the verification as approved, message me here and I’ll continue the transfer.",
  ].filter(Boolean).join(" ");
}

function mergeKycVerificationData(
  initial: KycVerificationData | undefined,
  refreshed: KycVerificationData | undefined
): KycVerificationData {
  return {
    ...(initial || {}),
    ...(refreshed || {}),
    status: refreshed?.status || initial?.status,
    verification_url: refreshed?.verification_url || initial?.verification_url,
    verification_seconds_left:
      typeof refreshed?.verification_seconds_left === "number"
        ? refreshed.verification_seconds_left
        : initial?.verification_seconds_left,
    max_attempts_reached:
      typeof refreshed?.max_attempts_reached === "boolean"
        ? refreshed.max_attempts_reached
        : initial?.max_attempts_reached,
    error_key: refreshed?.error_key || initial?.error_key,
    provider_messages:
      (Array.isArray(refreshed?.provider_messages) && refreshed.provider_messages.length > 0)
        ? refreshed.provider_messages
        : initial?.provider_messages,
  };
}

function applyKycVerificationSnapshot(session: TransferSession, data: KycVerificationData | undefined): void {
  if (!data) return;
  if (data.status) {
    // Do not let a stale active verification session downgrade an account that
    // UNIGOX already reports as fully verified in the profile.
    if (!(isUserKycVerified(session.auth.kycStatus) && !isUserKycVerified(data.status))) {
      session.auth.kycStatus = data.status;
    }
  }
  if (typeof data.verification_seconds_left === "number") {
    session.auth.kycVerificationSecondsLeft = data.verification_seconds_left;
  }
  if (data.verification_url) {
    session.auth.kycVerificationUrl = data.verification_url;
  }
}

function kycVerificationNeedsAttention(status: string | undefined): boolean {
  return Boolean(status && KYC_ACTIVE_STATUSES.has(status));
}

function transferFlowSleep(deps: TransferFlowDeps, ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (deps.sleep) {
    return deps.sleep(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForKycVerificationLink(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient,
  initial: KycVerificationData
): Promise<KycVerificationData> {
  let resolved = initial;
  if (!client.getKycVerificationStatus) {
    return resolved;
  }

  const timeoutMs = deps.kycVerificationPollTimeoutMs ?? DEFAULT_KYC_VERIFICATION_POLL_TIMEOUT_MS;
  const intervalMs = deps.kycVerificationPollIntervalMs ?? DEFAULT_KYC_VERIFICATION_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (!resolved.verification_url && kycVerificationNeedsAttention(resolved.status) && Date.now() < deadline) {
    await transferFlowSleep(deps, intervalMs);
    try {
      const refreshed = await client.getKycVerificationStatus();
      resolved = mergeKycVerificationData(resolved, refreshed);
    } catch {
      break;
    }
  }

  return resolved;
}

async function startKycVerificationFlow(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient
): Promise<TransferFlowResult> {
  session.status = "blocked";
  session.execution.confirmed = false;

  const existingVerificationResult = await maybeResumeExistingKycVerification(session, deps, client);
  if (existingVerificationResult) {
    return existingVerificationResult;
  }

  if (!session.auth.kycFullName) {
    session.stage = "awaiting_kyc_full_name";
    return reply(
      withUpdate(session, deps),
      `${buildKycRequirementMessage(session)} First, what full legal name should I use for the verification?`
    );
  }

  if (!session.auth.kycCountryCode) {
    session.stage = "awaiting_kyc_country";
    return reply(withUpdate(session, deps), buildKycCountryPrompt(session));
  }

  if (!client.initializeKycVerification) {
    session.stage = "awaiting_kyc_completion";
    return reply(
      withUpdate(session, deps),
      `${buildKycRequirementMessage(session)} I can’t start the KYC link automatically in this environment right now, but once UNIGOX marks your account as verified, message me here and I’ll continue the transfer.`
    );
  }

  const verification = await client.initializeKycVerification({
    fullName: session.auth.kycFullName,
    country: session.auth.kycCountryCode,
  });
  let resolvedVerification = verification;
  if (client.getKycVerificationStatus) {
    try {
      const refreshedVerification = await client.getKycVerificationStatus();
      resolvedVerification = mergeKycVerificationData(verification, refreshedVerification);
    } catch {
      // Fall back to the initialization response if the immediate refetch fails.
    }
  }
  if (!resolvedVerification.verification_url && kycVerificationNeedsAttention(resolvedVerification.status)) {
    resolvedVerification = await waitForKycVerificationLink(session, deps, client, resolvedVerification);
  }
  applyKycVerificationSnapshot(session, resolvedVerification);
  session.stage = "awaiting_kyc_completion";
  return reply(withUpdate(session, deps), buildKycVerificationLinkMessage(session, resolvedVerification));
}

async function maybeEnsureKycReady(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient
): Promise<{ blockedResult?: TransferFlowResult }> {
  await maybeHydrateAuthIdentity(session, deps, client);
  if (isUserKycVerified(session.auth.kycStatus)) {
    return {};
  }

  if (client.getKycVerificationStatus) {
    try {
      let verification = await client.getKycVerificationStatus();
      if (!verification.verification_url && kycVerificationNeedsAttention(verification.status)) {
        verification = await waitForKycVerificationLink(session, deps, client, verification);
      }
      applyKycVerificationSnapshot(session, verification);
      if (isUserKycVerified(session.auth.kycStatus)) {
        return {};
      }
      if (kycVerificationNeedsAttention(verification.status)) {
        session.status = "blocked";
        session.execution.confirmed = false;
        session.stage = "awaiting_kyc_completion";
        return {
          blockedResult: reply(
            withUpdate(session, deps),
            buildKycVerificationLinkMessage(session, verification)
          ),
        };
      }
    } catch {
      // If the verification status lookup fails, fall through to the guided KYC prompts.
    }
  }

  return {
    blockedResult: await startKycVerificationFlow(session, deps, client),
  };
}

async function maybeResumeExistingKycVerification(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient
): Promise<TransferFlowResult | undefined> {
  if (!client.getKycVerificationStatus) {
    return undefined;
  }

  try {
    let verification = await client.getKycVerificationStatus();
    if (!verification.verification_url && kycVerificationNeedsAttention(verification.status)) {
      verification = await waitForKycVerificationLink(session, deps, client, verification);
    }
    applyKycVerificationSnapshot(session, verification);

    if (isUserKycVerified(session.auth.kycStatus)) {
      return undefined;
    }

    if (kycVerificationNeedsAttention(verification.status)) {
      session.status = "blocked";
      session.execution.confirmed = false;
      session.stage = "awaiting_kyc_completion";
      return reply(withUpdate(session, deps), buildKycVerificationLinkMessage(session, verification));
    }
  } catch {
    // Fall back to normal prompt collection if the verification lookup fails.
  }

  return undefined;
}

function capturePendingPriceChange(session: TransferSession, tradeRequest: TradeRequest): void {
  session.execution.pendingPriceChange = {
    originalFiatAmount: session.execution.preflight?.quote?.fiatAmount || session.amount,
    originalCryptoAmount: session.execution.preflight?.quote?.totalCryptoAmount,
    newFiatAmount: tradeRequest.fiat_amount,
    newCryptoAmount: tradeRequest.total_crypto_amount,
    vendorOfferRate: tradeRequest.vendor_offer_rate,
    fiatCurrencyCode: tradeRequest.fiat_currency_code || session.currency,
    cryptoCurrencyCode: tradeRequest.crypto_currency_code || session.execution.preflight?.quote?.cryptoCurrencyCode,
    paymentMethodName: tradeRequest.payment_method_name || session.payment?.methodName,
    paymentNetworkName: tradeRequest.payment_network_name || session.payment?.networkName,
  };
}

function clearPendingPriceChange(session: TransferSession): void {
  delete session.execution.pendingPriceChange;
}

function buildNewPriceConfirmationMessage(session: TransferSession, tradeRequest?: TradeRequest): string {
  const priceChange = tradeRequest
    ? {
        originalFiatAmount: session.execution.preflight?.quote?.fiatAmount || session.amount,
        originalCryptoAmount: session.execution.preflight?.quote?.totalCryptoAmount,
        newFiatAmount: tradeRequest.fiat_amount,
        newCryptoAmount: tradeRequest.total_crypto_amount,
        vendorOfferRate: tradeRequest.vendor_offer_rate,
        fiatCurrencyCode: tradeRequest.fiat_currency_code || session.currency,
        cryptoCurrencyCode: tradeRequest.crypto_currency_code || session.execution.preflight?.quote?.cryptoCurrencyCode,
        paymentMethodName: tradeRequest.payment_method_name || session.payment?.methodName,
        paymentNetworkName: tradeRequest.payment_network_name || session.payment?.networkName,
      }
    : session.execution.pendingPriceChange;

  const fiatCode = priceChange?.fiatCurrencyCode || session.currency || "EUR";
  const cryptoCode = priceChange?.cryptoCurrencyCode || session.execution.preflight?.quote?.cryptoCurrencyCode || "USDT";
  const newFiat = typeof priceChange?.newFiatAmount === "number"
    ? formatQuoteAmount(priceChange.newFiatAmount, fiatCode, 2)
    : undefined;
  const newCrypto = typeof priceChange?.newCryptoAmount === "number"
    ? formatQuoteAmount(priceChange.newCryptoAmount, cryptoCode, 6)
    : undefined;
  const originalFiat = typeof priceChange?.originalFiatAmount === "number"
    ? formatQuoteAmount(priceChange.originalFiatAmount, fiatCode, 2)
    : undefined;
  const originalCrypto = typeof priceChange?.originalCryptoAmount === "number"
    ? formatQuoteAmount(priceChange.originalCryptoAmount, cryptoCode, 6)
    : undefined;
  const route = priceChange?.paymentMethodName && priceChange?.paymentNetworkName
    ? `${priceChange.paymentMethodName}, ${priceChange.paymentNetworkName}`
    : summarizePayment(session);
  const rateLine = typeof priceChange?.vendorOfferRate === "number"
    ? `Current live rate: ${formatRate(priceChange.vendorOfferRate, cryptoCode, fiatCode)}.`
    : undefined;

  return [
    "The original quote is no longer available.",
    newCrypto && newFiat ? `Right now this counterparty can do ${newCrypto} for ${newFiat} via ${route}.` : undefined,
    originalFiat && originalCrypto ? `Your original target was ${originalFiat} for about ${originalCrypto}.` : undefined,
    rateLine,
    "I have not funded escrow.",
    "Reply 'confirm new price' to accept this updated quote, or 'cancel' to stop this request.",
  ].filter(Boolean).join(" ");
}

async function continueFromMatchedTradeRequest(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient,
  matched: TradeRequest,
  events: TransferFlowEvent[],
  sellAssetCode: string,
  quotedCryptoAmount: number
): Promise<TransferFlowResult> {
  session.execution.tradeRequestStatus = matched.status;
  session.execution.tradeId = matched.trade?.id;
  session.execution.tradeStatus = matched.trade?.status;
  clearPendingPriceChange(session);
  session.execution.settlement = createInitialSettlementState({
    tradeRequestId: matched.id,
    tradeRequestStatus: matched.status,
    tradeId: matched.trade?.id,
    tradeStatus: matched.trade?.status,
  });

  events.push({
    type: "trade_matched",
    message: `Trade request #${matched.id} matched${matched.trade?.id ? ` with trade #${matched.trade.id}` : ""}.`,
    data: { tradeRequestId: matched.id, tradeId: matched.trade?.id, tradeStatus: matched.trade?.status },
  });

  let tradeSnapshot = matched.trade?.id && client.getTrade ? await client.getTrade(matched.trade.id) : undefined;

  if (tradeSnapshot?.status) {
    session.execution.tradeStatus = tradeSnapshot.status;
    session.execution.settlement = createInitialSettlementState({
      tradeRequestId: matched.id,
      tradeRequestStatus: matched.status,
      tradeId: matched.trade?.id,
      tradeStatus: tradeSnapshot.status,
    });
  }

  const preEscrowAdvance = await maybeAdvanceMatchedTradePreEscrow(
    session,
    deps,
    client,
    matched,
    tradeSnapshot,
    events,
    sellAssetCode,
    quotedCryptoAmount
  );
  if (preEscrowAdvance.blockedResult) {
    return preEscrowAdvance.blockedResult;
  }
  tradeSnapshot = preEscrowAdvance.tradeSnapshot;

  events.push({
    type: "settlement_monitor_started",
    message: `Started post-match settlement monitoring for trade request #${matched.id}.`,
    data: { tradeRequestId: matched.id, tradeId: matched.trade?.id },
  });

  const settlement = await refreshSettlementForSession(
    session,
    deps,
    "poll",
    preEscrowAdvance.escrowJustFunded ? settlementReceiptHandoffOptions(deps) : {}
  );
  if (settlement) {
    events.push(...settlement.events.map(mapSettlementEvent));
    if (settlement.phase === "completed") {
      events.push({
        type: "settlement_completed",
        message: `Trade #${settlement.state.tradeId} reached escrow release.`,
        data: { tradeId: settlement.state.tradeId, tradeStatus: settlement.state.tradeStatus },
      });
    } else if (settlement.phase === "refunded_or_cancelled") {
      events.push({
        type: "settlement_refunded_or_cancelled",
        message: `Trade #${settlement.state.tradeId} ended without release.`,
        data: { tradeId: settlement.state.tradeId, tradeStatus: settlement.state.tradeStatus },
      });
    }
    return reply(withUpdate(session, deps), settlement.prompt, settlement.options, events);
  }

  session.stage = "awaiting_trade_settlement";
  session.status = "active";
  return reply(
    withUpdate(session, deps),
    matched.trade?.id
      ? "I found a counterparty and started securing the transfer. I’ll keep monitoring it automatically and I’ll come back only if I need one more detail or a payout confirmation from you."
      : "I’ve started the transfer and I’m waiting for the next settlement update. I’ll keep watching it automatically.",
    ["status"],
    events
  );
}

function buildSavePrompt(session: TransferSession): string {
  if (session.goal === "save_contact_only") {
    return `Save ${session.recipientName} for ${session.currency} with ${summarizePayment(session)}? Reply yes or no.`;
  }
  if (session.contactSaveAction === "update") {
    return `Do you want me to update ${session.recipientName}'s saved ${session.currency} payout details for ${summarizePayment(session)}? Reply yes or no.`;
  }
  return `Do you want me to save ${session.recipientName} as a contact for future ${session.currency} transfers? Reply yes or no.`;
}

function prependReplyContext(result: TransferFlowResult, prefix?: string): TransferFlowResult {
  if (!prefix) return result;
  result.reply = `${prefix} ${result.reply}`;
  result.session.lastPrompt = result.reply;
  return result;
}

function addReplyNote(existing: string | undefined, note: string | undefined): string | undefined {
  if (!note) return existing;
  if (existing?.includes(note)) return existing;
  return existing ? `${existing} ${note}` : note;
}

function applyResolvedSavedRecipient(
  session: TransferSession,
  resolution: ReturnType<typeof resolveContactQuery>,
  source: "local" | "remote",
  query: string
): string | undefined {
  if (!resolution.match) return undefined;
  const queryDiffersFromSavedName = normalizeLookupValue(query) !== normalizeLookupValue(resolution.match.contact.name);
  session.contactKey = source === "local" ? resolution.match.key : undefined;
  session.remoteSavedContact = source === "remote" ? resolution.match.contact : undefined;
  session.recipientName = resolution.match.contact.name;
  session.aliases = resolution.match.contact.aliases || [];
  session.contactExists = true;
  session.contactStale = false;
  session.recipientMode = "saved";
  session.contactSaveAction = undefined;
  return queryDiffersFromSavedName || resolution.matchedBy === "partial"
    ? source === "remote"
      ? `I found saved UNIGOX payout details for ${session.recipientName}.`
      : `I found saved contact ${session.recipientName}.`
    : undefined;
}

function summarizeStoredPaymentRoute(currency: string, payment: StoredPaymentMethod): string {
  const methodName = payment.method?.trim();
  const networkName = payment.network?.trim();
  const route = networkName && methodName && normalizeLookupValue(networkName) !== normalizeLookupValue(methodName)
    ? `${methodName} / ${networkName}`
    : networkName || methodName || "saved payout route";
  return `${currency.toUpperCase()} via ${route}`;
}

function getSingleStoredPaymentSetup(contact: ContactRecord | undefined): { currency: string; method: StoredPaymentMethod } | undefined {
  const entries = Object.entries(contact?.paymentMethods || {});
  if (entries.length !== 1) return undefined;
  const [currency, method] = entries[0];
  return { currency, method };
}

function getPaymentDetailRecipientName(detail: PaymentDetail): string | undefined {
  const candidates = [
    detail.details?.full_name,
    detail.details?.name,
  ];
  for (const candidate of candidates) {
    const value = cleanText(candidate);
    if (value) return value;
  }
  return undefined;
}

/**
 * Describes payout details saved with the backend as a contact's stored payment method.
 *
 * @param detail Saved details as the backend lists them.
 * @returns The stored method, identified by institution and rail slug, or `undefined` when the
 *   backend reports no institution or rail for the details. Numeric ids are 0 because the backend
 *   does not report them for saved details; the flow matches by slug.
 */
function toStoredPaymentMethod(detail: PaymentDetail): StoredPaymentMethod | undefined {
  if (!detail.payment_method?.slug || !detail.payment_network?.slug) return undefined;
  return {
    method: cleanText(detail.payment_method.name) || detail.payment_method.slug,
    methodId: 0,
    methodSlug: detail.payment_method.slug,
    networkId: 0,
    network: cleanText(detail.payment_network.name) || detail.payment_network.slug,
    networkSlug: detail.payment_network.slug,
    details: { ...(detail.details || {}) },
  };
}

function buildRemoteSavedContactStore(details: PaymentDetail[]): ContactStoreData {
  const store: ContactStoreData = {
    contacts: {},
    _meta: { lastUpdated: "" },
  };

  for (const detail of details) {
    const name = getPaymentDetailRecipientName(detail);
    const paymentMethod = toStoredPaymentMethod(detail);
    if (!name || !paymentMethod || !detail.fiat_currency_code) continue;
    upsertContactPaymentMethod(store, {
      key: normalizeContactKey(name),
      name,
      aliases: [],
      currency: detail.fiat_currency_code,
      method: paymentMethod,
    });
  }

  return store;
}

async function resolveSavedRecipientQuery(
  session: TransferSession,
  deps: TransferFlowDeps
): Promise<{ resolution: ReturnType<typeof resolveContactQuery>; source: "local" | "remote" }> {
  const store = loadContacts(deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
  const localResolution = resolveContactQuery(store, session.recipientQuery);
  if (localResolution.match || localResolution.ambiguous.length) {
    return { resolution: localResolution, source: "local" };
  }

  try {
    const client = await getExecutionClient(deps, session);
    if (!client.listPaymentDetails) {
      return { resolution: localResolution, source: "local" };
    }
    const remoteResolution = resolveContactQuery(
      buildRemoteSavedContactStore(await client.listPaymentDetails()),
      session.recipientQuery
    );
    if (remoteResolution.match || remoteResolution.ambiguous.length) {
      return { resolution: remoteResolution, source: "remote" };
    }
  } catch {
    // Fall back to local resolution if the remote saved-payment lookup fails.
  }

  return { resolution: localResolution, source: "local" };
}

function getResolvedSavedContact(session: TransferSession, deps: TransferFlowDeps): ContactRecord | undefined {
  if (session.remoteSavedContact) return session.remoteSavedContact;
  const store = loadContacts(deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
  return session.contactKey ? store.contacts[session.contactKey] : resolveContact(store, session.recipientName)?.contact;
}

function buildSavedContactDisambiguation(query: string, matches: ContactMatch[]): string {
  return `I found multiple saved contacts matching '${query}': ${matches.map((match) => match.contact.name).join(", ")}. Which one do you mean?`;
}

function isBankLikeMethod(method: PaymentMethodInfo): boolean {
  const haystack = [method.name, method.type, method.slug, method.typeSlug].join(" ").toLowerCase();
  return /bank|iban|sepa|wise|revolut/.test(haystack);
}

/** EUR + SEPA/IBAN route — bank_name is redundant because SEPA always clears via the IBAN. */
function isEurSepaIban(session: TransferSession): boolean {
  if (session.currency?.toUpperCase() !== "EUR") return false;
  const haystack = [
    session.payment?.networkName,
    session.payment?.networkSlug,
    session.payment?.methodName,
    session.payment?.methodSlug,
  ].filter(Boolean).join(" ").toLowerCase();
  return /sepa|iban/.test(haystack);
}

function buildPaymentMethodPrompt(session: TransferSession, currencyData: CurrencyPaymentData, ambiguity?: string): string {
  const suggestions = currencyData.paymentMethods.slice(0, 6).map((method) => method.name);
  const bankLikeExamples = currencyData.paymentMethods.filter(isBankLikeMethod).slice(0, 4).map((method) => method.name);
  const guidance = bankLikeExamples.length
    ? `Start with the provider / bank first (for example ${bankLikeExamples.join(", ")}). If that provider has multiple routes, I'll ask the next clarification separately — for example username/tag vs SEPA / bank account.`
    : "Tell me the payout method first and I'll collect the exact details step by step.";
  return [
    `Which payout method should ${session.recipientName} receive in ${session.currency}?`,
    ambiguity,
    `Available examples for ${session.currency}: ${suggestions.join(", ")}.`,
    guidance,
  ].filter(Boolean).join(" ");
}

function buildPaymentNetworkPrompt(method: PaymentMethodInfo, currency: string): string {
  const networkNames = method.networks.map((network) => network.name).join(", ");
  const clarification = isBankLikeMethod(method)
    ? "If you're unsure, tell me whether the recipient uses a username/tag or a bank account / IBAN and I'll guide the next step."
    : "I'll ask for the route-specific details right after you choose one.";
  return `${method.name} has multiple payout routes for ${currency}: ${networkNames}. Which one should I use? ${clarification}`;
}

function currentFieldPrompt(field: PaymentFieldConfig, session?: TransferSession): string {
  const optional = field.required ? "" : " Optional — you can say 'skip'.";
  if (field.field === "bank_name") {
    return `Which bank should receive this payout? Please provide the bank name.${optional}`.trim();
  }
  if (field.field === "iban") {
    const sepaNote = session && isEurSepaIban(session)
      ? " This is a SEPA IBAN transfer."
      : "";
    return `Please provide the recipient's IBAN for this payout.${sepaNote}${optional}`.trim();
  }
  const hint = field.placeholder ? ` ${field.placeholder}.` : "";
  const choices = field.options?.length ? ` Options: ${field.options.map((option) => option.name).join(", ")}.` : "";
  return `Please provide ${field.label || field.field}.${hint}${choices}${optional}`.trim();
}

async function resolveFieldConfig(session: TransferSession, deps: TransferFlowDeps): Promise<ResolvedPaymentMethodFieldConfig> {
  if (!session.currency || !session.payment) {
    throw new Error("Cannot resolve field config without currency and payment selection");
  }
  return resolvePaymentCatalogue(deps).getPaymentMethodFieldConfig({
    currency: session.currency,
    methodSlug: session.payment.methodSlug,
    networkSlug: session.payment.networkSlug,
  });
}

async function validateStoredContactSelection(
  session: TransferSession,
  contact: ContactRecord,
  deps: TransferFlowDeps
): Promise<{ valid: boolean; errors: string[] }> {
  if (!session.currency) return { valid: false, errors: ["Currency missing"] };
  const savedMethod = contact.paymentMethods?.[session.currency];
  if (!savedMethod) return { valid: false, errors: ["No saved method"] };

  session.payment = {
    methodId: savedMethod.methodId,
    methodSlug: savedMethod.methodSlug || "",
    methodName: savedMethod.method,
    networkId: savedMethod.networkId,
    networkSlug: savedMethod.networkSlug || "",
    networkName: savedMethod.network || "",
    selectedFormatId: savedMethod.selectedFormatId,
  };
  session.details = { ...savedMethod.details };

  const config = await resolveFieldConfig(session, deps);
  session.payment.methodSlug = session.payment.methodSlug || config.method.slug;
  session.payment.networkSlug = session.payment.networkSlug || config.network.slug;
  session.payment.networkName = session.payment.networkName || config.network.name;
  session.payment.selectedFormatId = config.selectedFormatId;

  const validate = deps.validatePaymentDetailInput || defaultValidatePaymentDetailInput;
  const result = validate(session.details, config.fields);
  if (result.valid) {
    session.details = { ...result.normalizedDetails };
    session.detailCollection.index = config.fields.length;
    session.contactStale = false;
    return { valid: true, errors: [] };
  }

  session.details = { ...session.details, ...result.normalizedDetails };
  session.detailCollection.index = Math.max(0, config.fields.findIndex((field) => result.errors.some((error) => error.field === field.field)));
  session.detailCollection.lastError = result.errors[0]?.message;
  session.contactStale = true;
  session.contactSaveAction = "update";
  return { valid: false, errors: result.errors.map((error) => error.message) };
}

function chooseMethod(methods: PaymentMethodInfo[], query: string): { method?: PaymentMethodInfo; ambiguous: PaymentMethodInfo[] } {
  const normalizedQuery = normalizeMatchValue(query);
  if (!normalizedQuery) return { ambiguous: [] };

  const exact = methods.find((method) =>
    normalizeMatchValue(method.slug) === normalizedQuery ||
    normalizeMatchValue(method.name) === normalizedQuery
  );
  if (exact) return { method: exact, ambiguous: [] };

  const partial = methods.filter((method) => {
    const haystacks = [method.slug, method.name, method.typeSlug, method.type].map((value) => normalizeMatchValue(value));
    return haystacks.some((haystack) => haystack.includes(normalizedQuery));
  });

  if (partial.length === 1) return { method: partial[0], ambiguous: [] };
  return { ambiguous: partial.slice(0, 6) };
}

function chooseNetwork(networks: PaymentNetworkInfo[], query: string): PaymentNetworkInfo | undefined {
  const normalizedQuery = normalizeMatchValue(query);
  return networks.find((network) =>
    normalizeMatchValue(network.slug) === normalizedQuery ||
    normalizeMatchValue(network.name) === normalizedQuery
  ) || networks.find((network) => normalizeMatchValue(network.name).includes(normalizedQuery));
}

function tokenizeSelectionTerms(value: string | undefined, ignored: Set<string> = new Set()): string[] {
  return normalizeMatchValue(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !GENERIC_SELECTION_TOKENS.has(token) && !ignored.has(token));
}

function scoreSelectionMention(query: string, candidates: string[], ignored: Set<string> = new Set()): number {
  const normalizedQuery = normalizeMatchValue(query);
  if (!normalizedQuery) return 0;

  let bestScore = 0;
  const queryTokens = new Set(tokenizeSelectionTerms(normalizedQuery));
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeMatchValue(candidate);
    if (!normalizedCandidate) continue;
    if (normalizedQuery === normalizedCandidate) return 1000;
    if (normalizedQuery.includes(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 500 + normalizedCandidate.split(" ").length);
    }
    const overlap = tokenizeSelectionTerms(normalizedCandidate, ignored).filter((token) => queryTokens.has(token)).length;
    if (overlap > 0) {
      bestScore = Math.max(bestScore, overlap * 10);
    }
  }

  return bestScore;
}

function chooseMentionedMethod(methods: PaymentMethodInfo[], query: string): { method?: PaymentMethodInfo; ambiguous: PaymentMethodInfo[] } {
  const direct = chooseMethod(methods, query);
  if (direct.method) return direct;

  const scored = methods
    .map((method) => ({
      method,
      score: scoreSelectionMention(query, [method.name, method.slug]),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!scored.length) return { ambiguous: [] };
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return { method: scored[0].method, ambiguous: [] };
  }
  return { ambiguous: scored.filter((entry) => entry.score === scored[0].score).slice(0, 6).map((entry) => entry.method) };
}

function chooseMentionedNetwork(
  networks: PaymentNetworkInfo[],
  query: string,
  method?: PaymentMethodInfo
): PaymentNetworkInfo | undefined {
  const direct = chooseNetwork(networks, query);
  if (direct) return direct;

  const ignoredMethodTerms = new Set([
    ...tokenizeSelectionTerms(method?.name),
    ...tokenizeSelectionTerms(method?.slug),
  ]);
  const scored = networks
    .map((network) => ({
      network,
      score: scoreSelectionMention(query, [network.name, network.slug], ignoredMethodTerms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!scored.length) return undefined;
  if (scored.length === 1 || scored[0].score > scored[1].score) return scored[0].network;
  return undefined;
}

function buildPaymentRouteChangeMessage(method: PaymentMethodInfo, network: PaymentNetworkInfo): string {
  return `Okay — I'll use ${method.name} via ${network.name} instead.`;
}

function settlementMonitorOptions(
  deps: TransferFlowDeps,
  overrides: Partial<SettlementMonitorOptions> = {}
): SettlementMonitorOptions {
  return {
    now: deps.now,
    pollIntervalMs: deps.settlementPollIntervalMs,
    timeoutMs: deps.waitForSettlementTimeoutMs,
    receiptReminderMs: deps.receiptReminderMs,
    receiptTimeoutMs: deps.receiptTimeoutMs,
    ...overrides,
  };
}

function settlementReceiptHandoffOptions(deps: TransferFlowDeps): Partial<SettlementMonitorOptions> {
  return {
    timeoutMs: deps.receiptConfirmationHandoffTimeoutMs
      ?? Math.max(deps.waitForSettlementTimeoutMs ?? 15_000, 60_000),
    continuePollingWhilePhases: ["waiting_for_fiat"],
  };
}

function ensureSettlementState(session: TransferSession): SettlementMonitorState | undefined {
  if (!session.execution.tradeRequestId) return undefined;
  if (!session.execution.settlement) {
    session.execution.settlement = createInitialSettlementState({
      tradeRequestId: session.execution.tradeRequestId,
      tradeRequestStatus: session.execution.tradeRequestStatus,
      tradeId: session.execution.tradeId,
      tradeStatus: session.execution.tradeStatus,
    });
  }
  return session.execution.settlement;
}

function mapSettlementPhaseToStage(phase: SettlementPhase): TransferStage {
  switch (phase) {
    case "awaiting_partner_payment_details":
    case "awaiting_buyer_payment_details":
    case "awaiting_escrow_funding":
    case "waiting_for_fiat":
      return "awaiting_trade_settlement";
    case "awaiting_receipt_confirmation":
      return "awaiting_receipt_confirmation";
    case "receipt_confirmed_release_started":
      return "awaiting_release_completion";
    case "deferred":
      return "awaiting_manual_settlement_followup";
    case "completed":
    case "refunded_or_cancelled":
      return "completed";
    case "matching":
    default:
      return "awaiting_match_status";
  }
}

function tradeCanFundEscrow(trade?: SettlementTrade, fallbackStatus?: string): boolean {
  if (trade?.possible_actions?.includes("action_fund_escrow")) return true;
  return (trade?.status || fallbackStatus) === "awaiting_escrow_funding_by_seller";
}

function tradeNeedsPartnerPaymentDetails(trade?: SettlementTrade): boolean {
  return !!(
    trade
    && trade.status === "trade_created"
    && trade.partner_short_name
    && trade.partner_details_checked_at == null
  );
}

function tradeNeedsBuyerPaymentDetails(trade?: SettlementTrade): boolean {
  return !!(
    trade
    && trade.payment_request === true
    && trade.status === "awaiting_escrow_funding_by_seller"
    && !trade.initiator_payment_details
  );
}

function formatPartnerFieldLabel(name: string): string {
  return name.replace(/_/g, " ").trim();
}

function getPartnerFieldKey(field: {
  internal_field_name?: string;
  partner_field_name: string;
}): string {
  return field.internal_field_name || field.partner_field_name;
}

function buildPartnerFieldsToComplete(diff: PartnerPaymentDetailsDiffData): PartnerFieldToComplete[] {
  const missing = diff.differences?.missing_fields || [];
  const invalid = diff.differences?.invalid_fields || [];
  return [
    ...missing.map((field) => ({
      fieldKey: getPartnerFieldKey(field),
      label: sentenceCase(formatPartnerFieldLabel(getPartnerFieldKey(field))),
      required: field.required ?? true,
      expectedPattern: field.expected_pattern,
      example: field.example,
      hint: field.hint,
      options: field.options,
    })),
    ...invalid.map((field) => ({
      fieldKey: getPartnerFieldKey(field),
      label: sentenceCase(formatPartnerFieldLabel(getPartnerFieldKey(field))),
      required: true,
      currentValue: field.current_value,
      expectedPattern: field.expected_pattern,
      example: field.example,
      hint: field.hint,
      options: field.options,
    })),
  ];
}

function summarizePartnerFieldNames(diff: PartnerPaymentDetailsDiffData): string[] {
  const missing = diff.differences?.missing_fields || [];
  const invalid = diff.differences?.invalid_fields || [];
  const labels = [
    ...missing.filter((field) => field.required).map((field) => formatPartnerFieldLabel(field.partner_field_name)),
    ...invalid.map((field) => formatPartnerFieldLabel(field.partner_field_name)),
  ];
  return [...new Set(labels)];
}

function partnerDiffCanAutoResolve(diff: PartnerPaymentDetailsDiffData): boolean {
  const missing = diff.differences?.missing_fields || [];
  const invalid = diff.differences?.invalid_fields || [];
  return invalid.length === 0 && missing.every((field) => !field.required);
}

function buildPartnerFieldReplyHint(field: PartnerFieldToComplete): string {
  switch (field.fieldKey) {
    case "holder_city":
      return "Just send me the city name.";
    case "holder_postal_code":
      return "Just send me the postal code.";
    case "holder_street":
      return "Just send me the street address.";
    default:
      return `Just send me the ${field.label.toLowerCase()}.`;
  }
}

function buildPartnerFieldPrompt(state: PartnerDetailCollectionState): string {
  const field = state.fields[state.index];
  if (!field) {
    return "UNIGOX still needs one more payout detail before I can secure this transfer.";
  }

  const parts = [
    `UNIGOX needs one more payout detail before I can secure this transfer: ${field.label}.`,
  ];

  if (field.currentValue) parts.push(`Current value on file: ${field.currentValue}.`);
  if (field.hint) parts.push(field.hint);
  if (field.example) parts.push(`Example: ${field.example}.`);
  if (field.options?.length) {
    parts.push(`Allowed options: ${field.options.map((option) => option.label || option.value).join(", ")}.`);
  }

  parts.push(buildPartnerFieldReplyHint(field));
  return parts.join(" ");
}

function maybeConsumePartnerFieldValue(
  turn: TransferTurn,
  field: PartnerFieldToComplete
): string | undefined {
  if (!turn.fields) return undefined;
  const direct = turn.fields[field.fieldKey];
  if (typeof direct === "string") return direct;
  const alias = Object.entries(turn.fields).find(([key]) => normalizeMatchValue(key) === normalizeMatchValue(field.fieldKey));
  return typeof alias?.[1] === "string" ? alias[1] : undefined;
}

function validatePartnerFieldValue(field: PartnerFieldToComplete, rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) {
    return field.required ? `${field.label} is required.` : undefined;
  }

  if (field.options?.length) {
    const match = field.options.find((option) => normalizeMatchValue(option.value) === normalizeMatchValue(value) || normalizeMatchValue(option.label) === normalizeMatchValue(value));
    if (!match) {
      return `Please use one of the allowed ${field.label.toLowerCase()} options.`;
    }
  }

  if (field.expectedPattern) {
    try {
      const regex = new RegExp(field.expectedPattern);
      if (!regex.test(value)) {
        return field.example
          ? `${field.label} has the wrong format. Example: ${field.example}.`
          : `${field.label} has the wrong format.`;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function resolveMatchedFundingAmount(
  currentTrade: SettlementTrade | undefined,
  matched: TradeRequest,
  session: TransferSession,
  quotedCryptoAmount: number
): string {
  const candidates = [
    currentTrade?.total_crypto_amount,
    matched.total_crypto_amount,
    session.execution.preflight?.quote?.totalCryptoAmount,
    quotedCryptoAmount,
  ];

  for (const candidate of candidates) {
    const amount = Number(candidate);
    if (Number.isFinite(amount) && amount > 0) {
      return String(amount);
    }
  }

  return String(quotedCryptoAmount);
}

/**
 * Funds a matched trade's escrow from the paying wallet and re-reads the trade.
 *
 * @param params.session Current session. On success its trade status and settlement state follow
 *   the funded trade; on an uncovered wallet it stays in `awaiting_trade_settlement`.
 * @param params.deps Flow collaborators.
 * @param params.client Backend; must provide `fundTradeEscrow`.
 * @param params.tradeId Trade to fund.
 * @param params.tradeRequestId Request the trade belongs to.
 * @param params.tradeRequestStatus Last known request status, kept in the settlement state.
 * @param params.assetCode Asset being spent, for the event and the reply.
 * @param params.amount Crypto amount being funded, in whole units, for the event.
 * @param params.events Events gathered so far in this turn; the funding event is appended.
 * @returns `trade` is the re-read trade (absent when the backend cannot re-read it).
 *   `blockedResult` is set instead when the wallet cannot cover the trade: nothing was moved and
 *   the reply tells the person to fund the wallet and ask for status.
 * @throws Whatever the backend throws for any other funding failure.
 */
async function fundMatchedTradeEscrow(params: {
  session: TransferSession;
  deps: TransferFlowDeps;
  client: TransferExecutionClient;
  tradeId: string;
  tradeRequestId: string;
  tradeRequestStatus?: string;
  assetCode: string;
  amount: string;
  events: TransferFlowEvent[];
}): Promise<{ trade?: SettlementTrade; blockedResult?: TransferFlowResult }> {
  const { session, deps, client, tradeId, tradeRequestId, events } = params;
  try {
    await client.fundTradeEscrow!(tradeId);
  } catch (error) {
    if (!(error instanceof TransferExecutionError) || error.reason !== "insufficient_balance") throw error;
    session.execution.lastError = error.message;
    session.stage = "awaiting_trade_settlement";
    session.status = "active";
    events.push({ type: "blocked_insufficient_balance", message: "The partner wallet could not cover the trade at funding time.", data: { tradeId } });
    return {
      blockedResult: reply(
        withUpdate(session, deps),
        `A provider accepted this transfer, but the partner wallet does not hold enough ${params.assetCode} to fund it, so nothing has left the wallet. Add funds in My Wallet on unigox.com, then ask me for status and I'll fund it.`,
        ["status"],
        events
      ),
    };
  }

  events.push({
    type: "escrow_funding_submitted",
    message: `Authorized ${params.amount} ${params.assetCode} into escrow for trade #${tradeId}.`,
    data: { tradeId, tradeRequestId, assetCode: params.assetCode, amount: params.amount },
  });

  const fundedTrade = client.getTrade ? await client.getTrade(tradeId) : undefined;
  if (fundedTrade) {
    session.execution.tradeStatus = fundedTrade.status;
    session.execution.settlement = createInitialSettlementState({
      tradeRequestId,
      tradeRequestStatus: params.tradeRequestStatus,
      tradeId: fundedTrade.id,
      tradeStatus: fundedTrade.status,
    });
  }
  return { trade: fundedTrade };
}

async function maybeAdvanceMatchedTradePreEscrow(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient,
  matched: TradeRequest,
  tradeSnapshot: SettlementTrade | undefined,
  events: TransferFlowEvent[],
  sellAssetCode: string,
  quotedCryptoAmount: number
): Promise<{ tradeSnapshot?: SettlementTrade; blockedResult?: TransferFlowResult; escrowJustFunded?: boolean }> {
  let currentTrade = tradeSnapshot;
  let escrowJustFunded = false;

  if (currentTrade?.id && tradeNeedsPartnerPaymentDetails(currentTrade)) {
    if (!client.getPartnerPaymentDetailsDiff || !client.revalidateTradePaymentDetails) {
      session.stage = "awaiting_trade_settlement";
      session.status = "active";
      return {
        blockedResult: reply(
          withUpdate(session, deps),
          "UNIGOX still needs to confirm the payout route before I can secure this transfer, and this setup cannot resolve that step automatically yet.",
          ["status"],
          events
        ),
      };
    }

    const diff = await client.getPartnerPaymentDetailsDiff(currentTrade.id);
    const fieldsToComplete = buildPartnerFieldsToComplete(diff);
    if (fieldsToComplete.length > 0) {
      session.execution.partnerDetailCollection = {
        tradeId: currentTrade.id,
        tradeRequestId: matched.id,
        paymentDetailsId: diff.payment_details_id || session.execution.paymentDetailsId || "",
        partner: currentTrade.partner_short_name || "",
        index: 0,
        fields: fieldsToComplete,
        values: {},
      };
      session.stage = "awaiting_partner_payment_details_input";
      session.status = "active";
      return {
        blockedResult: reply(
          withUpdate(session, deps),
          buildPartnerFieldPrompt(session.execution.partnerDetailCollection),
          ["status"],
          [
            ...events,
            {
              type: "settlement_status_changed",
              message: `UNIGOX needs additional payout details before escrow funding on trade #${currentTrade.id}.`,
              data: {
                tradeId: currentTrade.id,
                tradeRequestId: matched.id,
                fields: fieldsToComplete.map((field) => field.fieldKey),
              },
            },
          ]
        ),
      };
    }

    const revalidated = await client.revalidateTradePaymentDetails(currentTrade.id);
    const refreshedTrade = client.getTrade
      ? await client.getTrade(revalidated?.trade?.id || currentTrade.id)
      : currentTrade;
    if (refreshedTrade) {
      currentTrade = refreshedTrade;
    }

    session.execution.tradeStatus = currentTrade?.status || session.execution.tradeStatus;
    session.execution.settlement = createInitialSettlementState({
      tradeRequestId: matched.id,
      tradeRequestStatus: matched.status,
      tradeId: currentTrade?.id || matched.trade?.id,
      tradeStatus: currentTrade?.status,
    });

    events.push({
      type: "settlement_status_changed",
      message: `Rechecked the payout route with UNIGOX for trade #${currentTrade?.id || matched.trade?.id}.`,
      data: { tradeId: currentTrade?.id || matched.trade?.id, tradeRequestId: matched.id, tradeStatus: currentTrade?.status },
    });

    if (currentTrade && tradeNeedsPartnerPaymentDetails(currentTrade)) {
      session.stage = "awaiting_trade_settlement";
      session.status = "active";
      return {
        blockedResult: reply(
          withUpdate(session, deps),
          "UNIGOX still wants one more payout detail before I can secure this transfer, so I’m keeping the trade on hold for now.",
          ["status"],
          events
        ),
      };
    }
  }

  const matchedAssetCode = (session.execution.preflight?.selectedAssetCode
    || session.execution.preflight?.quote?.cryptoCurrencyCode
    || sellAssetCode) as "USDC" | "USDT";
  const matchedFundingAmount = resolveMatchedFundingAmount(currentTrade, matched, session, quotedCryptoAmount);

  if (
    matched.trade?.id
    && tradeCanFundEscrow(currentTrade, matched.trade?.status)
    && client.fundTradeEscrow
    && !tradeNeedsPartnerPaymentDetails(currentTrade)
    && !tradeNeedsBuyerPaymentDetails(currentTrade)
  ) {
    const funding = await fundMatchedTradeEscrow({
      session,
      deps,
      client,
      tradeId: matched.trade.id,
      tradeRequestId: matched.id,
      tradeRequestStatus: matched.status,
      assetCode: matchedAssetCode,
      amount: matchedFundingAmount,
      events,
    });
    if (funding.blockedResult) return { blockedResult: funding.blockedResult };
    currentTrade = funding.trade ?? currentTrade;
    escrowJustFunded = true;
  }

  return { tradeSnapshot: currentTrade, escrowJustFunded };
}

function mapSettlementEvent(event: SettlementSnapshot["events"][number]): TransferFlowEvent {
  switch (event.type) {
    case "status_changed":
      return { type: "settlement_status_changed", message: event.message, data: event.data };
    case "receipt_confirmation_requested":
      return { type: "receipt_confirmation_requested", message: event.message, data: event.data };
    case "receipt_confirmation_reminder":
      return { type: "receipt_confirmation_reminder", message: event.message, data: event.data };
    case "receipt_confirmation_timeout":
      return { type: "receipt_confirmation_timeout", message: event.message, data: event.data };
    case "receipt_not_received":
      return { type: "receipt_not_received", message: event.message, data: event.data };
    case "deferred_placeholder":
      return { type: "settlement_placeholder_deferred", message: event.message, data: event.data };
    default:
      return { type: "settlement_status_changed", message: event.message, data: event.data };
  }
}

function applySettlementSnapshotToSession(session: TransferSession, snapshot: SettlementSnapshot): void {
  session.execution.tradeRequestId = snapshot.state.tradeRequestId;
  session.execution.tradeRequestStatus = snapshot.state.tradeRequestStatus;
  session.execution.tradeId = snapshot.state.tradeId;
  session.execution.tradeStatus = snapshot.state.tradeStatus;
  session.execution.settlement = snapshot.state;
  session.stage = mapSettlementPhaseToStage(snapshot.phase);

  if (snapshot.phase === "completed" || snapshot.phase === "refunded_or_cancelled") {
    session.status = "completed";
  } else {
    session.status = "active";
  }
}

async function refreshSettlementForSession(
  session: TransferSession,
  deps: TransferFlowDeps,
  mode: "refresh" | "poll" = "refresh",
  overrides: Partial<SettlementMonitorOptions> = {}
): Promise<SettlementSnapshot | undefined> {
  const state = ensureSettlementState(session);
  if (!state) return undefined;
  const client = await getExecutionClient(deps, session);
  const options = settlementMonitorOptions(deps, overrides);
  let snapshot = mode === "poll"
    ? await pollSettlementSnapshot(state, client, options)
    : await refreshSettlementSnapshot(state, client, options);
  snapshot = await authorizeOwedRefund(session, client, snapshot, options);
  applySettlementSnapshotToSession(session, snapshot);
  return snapshot;
}

/**
 * Signs the refund of a stopped trade whose crypto is still in escrow, then re-reads the trade.
 *
 * The refund can only go back to the paying wallet, so no decision is needed from the person.
 *
 * @param session Current session; a refused signature is recorded in `execution.lastError`.
 * @param client Backend.
 * @param snapshot Settlement snapshot just taken.
 * @param options Monitor options to use for the re-read.
 * @returns The original snapshot when no refund is owed or the signature was refused; otherwise a
 *   fresh snapshot whose prompt says the refund was signed.
 */
async function authorizeOwedRefund(
  session: TransferSession,
  client: TransferExecutionClient,
  snapshot: SettlementSnapshot,
  options: SettlementMonitorOptions
): Promise<SettlementSnapshot> {
  const tradeId = snapshot.state.tradeId;
  if (!tradeId || !client.authorizeRefund || !snapshot.trade?.possible_actions?.includes("action_authorize_refund")) {
    return snapshot;
  }
  try {
    await client.authorizeRefund(tradeId);
  } catch (error) {
    session.execution.lastError = error instanceof Error ? error.message : String(error);
    return snapshot;
  }
  const refreshed = await refreshSettlementSnapshot(snapshot.state, client, options);
  return {
    ...refreshed,
    prompt: "This transfer ended without a payout. I signed the refund, so the funds are on their way back to the partner wallet. Ask me for status to check that they arrived.",
    options: ["status"],
    events: [
      ...snapshot.events,
      { type: "status_changed", message: `Authorized the escrow refund for trade #${tradeId}.`, data: { tradeId } },
      ...refreshed.events,
    ],
  };
}

function settlementStageActive(session: TransferSession): boolean {
  return [
    "awaiting_trade_settlement",
    "awaiting_receipt_confirmation",
    "awaiting_release_completion",
    "awaiting_manual_settlement_followup",
  ].includes(session.stage);
}

function settlementDecisionStageActive(session: TransferSession): boolean {
  return [
    "awaiting_trade_settlement",
    "awaiting_receipt_confirmation",
    "awaiting_manual_settlement_followup",
  ].includes(session.stage);
}

/**
 * Handles a reply while the transfer waits for the partner wallet to be funded.
 *
 * @param session Current session, in `awaiting_balance_resolution`.
 * @param turn The person's reply: a recheck request, a new amount, or anything else.
 * @param deps Flow collaborators.
 * @returns `undefined` when the session is not waiting on the balance or the reply is neither a
 *   recheck nor an amount; otherwise the confirmation prompt, or the balance block again.
 */
async function maybeHandleBalanceResolutionTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (session.stage !== "awaiting_balance_resolution") return undefined;

  const hints = parseIntentHints(turn.text);
  if (hints.changeAmount || hints.changeCurrency) return undefined;

  const selectionText = turn.option || turn.text;
  const parsed = parseAmountAndCurrency(selectionText);
  const wantsRefresh = wantsBalanceRecheck(selectionText) || looksLikeTopUpCompletion(selectionText || "") || Boolean(parsed.amount);
  if (!wantsRefresh) return undefined;

  if (parsed.amount) {
    session.amount = parsed.amount;
    session.execution.confirmed = false;
  }
  if (parsed.currency && parsed.currency !== session.currency) {
    setCurrency(session, parsed.currency);
  } else {
    invalidateBalanceState(session);
  }
  const client = await getExecutionClient(deps, session);
  const preflight = await ensureExecutionPreflight(session, deps, client);
  if (preflight.blockedResult) return preflight.blockedResult;

  session.status = "active";
  session.stage = "awaiting_confirmation";
  return reply(withUpdate(session, deps), buildConfirmationMessage(session), undefined, preflight.events);
}

async function maybeHandlePartnerPaymentDetailsTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (session.stage !== "awaiting_partner_payment_details_input") return undefined;
  const collection = session.execution.partnerDetailCollection;
  if (!collection) return undefined;

  let consumedText = false;
  while (collection.index < collection.fields.length) {
    const field = collection.fields[collection.index];
    const structuredValue = maybeConsumePartnerFieldValue(turn, field);
    const textValue = !consumedText ? cleanText(turn.text) : "";
    const provided = structuredValue ?? (textValue || undefined);

    if (!provided) {
      return reply(withUpdate(session, deps), buildPartnerFieldPrompt(collection), ["status"]);
    }

    if (!structuredValue) consumedText = true;

    const validationError = validatePartnerFieldValue(field, provided);
    if (validationError) {
      return reply(withUpdate(session, deps), `${validationError} ${buildPartnerFieldPrompt(collection)}`, ["status"]);
    }

    collection.values[field.fieldKey] = provided.trim();
    collection.index += 1;
  }

  const client = await getExecutionClient(deps, session);
  if (!client.createOrUpdatePartnerPaymentDetails || !client.revalidateTradePaymentDetails) {
    session.stage = "awaiting_trade_settlement";
    session.status = "active";
    return reply(
      withUpdate(session, deps),
      "I captured the extra payout details, but this setup cannot push them back into UNIGOX automatically yet.",
      ["status"]
    );
  }

  await client.createOrUpdatePartnerPaymentDetails({
    internalDetailsId: collection.paymentDetailsId,
    partner: collection.partner,
    details: collection.values,
  });

  const revalidated = await client.revalidateTradePaymentDetails(collection.tradeId);
  let currentTrade = client.getTrade
    ? await client.getTrade(revalidated?.trade?.id || collection.tradeId)
    : undefined;
  let escrowJustFunded = false;

  session.execution.partnerDetailCollection = undefined;
  session.execution.tradeId = currentTrade?.id || collection.tradeId;
  session.execution.tradeStatus = currentTrade?.status || session.execution.tradeStatus;
  session.execution.settlement = createInitialSettlementState({
    tradeRequestId: collection.tradeRequestId,
    tradeRequestStatus: session.execution.tradeRequestStatus,
    tradeId: currentTrade?.id || collection.tradeId,
    tradeStatus: currentTrade?.status,
  });

  const events: TransferFlowEvent[] = [{
    type: "settlement_status_changed",
    message: `Updated the payout details UNIGOX needed for trade #${collection.tradeId}.`,
    data: { tradeId: collection.tradeId, tradeRequestId: collection.tradeRequestId, details: collection.values },
  }];

  if (currentTrade && tradeNeedsPartnerPaymentDetails(currentTrade)) {
    const diff = client.getPartnerPaymentDetailsDiff
      ? await client.getPartnerPaymentDetailsDiff(collection.tradeId)
      : undefined;
    const nextFields = diff ? buildPartnerFieldsToComplete(diff) : [];
    if (diff && nextFields.length > 0) {
      session.execution.partnerDetailCollection = {
        tradeId: collection.tradeId,
        tradeRequestId: collection.tradeRequestId,
        paymentDetailsId: diff.payment_details_id || collection.paymentDetailsId,
        partner: collection.partner,
        index: 0,
        fields: nextFields,
        values: {},
      };
      session.stage = "awaiting_partner_payment_details_input";
      return reply(
        withUpdate(session, deps),
        buildPartnerFieldPrompt(session.execution.partnerDetailCollection),
        ["status"],
        events
      );
    }

    session.stage = "awaiting_trade_settlement";
    return reply(
      withUpdate(session, deps),
      "UNIGOX still wants one more payout detail before I can secure this transfer, so I’m keeping the trade on hold for now.",
      ["status"],
      events
    );
  }

  const matchedAssetCode = (session.execution.preflight?.selectedAssetCode
    || session.execution.preflight?.quote?.cryptoCurrencyCode
    || "USDC") as "USDC" | "USDT";
  const matchedFundingAmount = resolveMatchedFundingAmount(
    currentTrade,
    {
      id: collection.tradeRequestId,
      status: session.execution.tradeRequestStatus || "accepted_by_vendor",
      trade: currentTrade ? { id: currentTrade.id, status: currentTrade.status } : undefined,
      total_crypto_amount: currentTrade?.total_crypto_amount,
    },
    session,
    session.execution.preflight?.quote?.totalCryptoAmount || session.amount || 0
  );

  if (
    currentTrade?.id
    && tradeCanFundEscrow(currentTrade, currentTrade.status)
    && client.fundTradeEscrow
    && !tradeNeedsBuyerPaymentDetails(currentTrade)
  ) {
    const funding = await fundMatchedTradeEscrow({
      session,
      deps,
      client,
      tradeId: currentTrade.id,
      tradeRequestId: collection.tradeRequestId,
      tradeRequestStatus: session.execution.tradeRequestStatus,
      assetCode: matchedAssetCode,
      amount: matchedFundingAmount,
      events,
    });
    if (funding.blockedResult) return funding.blockedResult;
    currentTrade = funding.trade ?? currentTrade;
    escrowJustFunded = true;
  }

  const snapshot = await refreshSettlementForSession(
    session,
    deps,
    escrowJustFunded ? "poll" : "refresh",
    escrowJustFunded ? settlementReceiptHandoffOptions(deps) : {}
  );
  if (snapshot) {
    return reply(withUpdate(session, deps), snapshot.prompt, snapshot.options, [...events, ...snapshot.events.map(mapSettlementEvent)]);
  }

  session.stage = "awaiting_trade_settlement";
  return reply(withUpdate(session, deps), "I updated the payout details and I’m continuing the transfer.", ["status"], events);
}

async function maybeHandleSettlementTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (!settlementDecisionStageActive(session) || !session.execution.tradeRequestId) return undefined;

  const decision = parseReceiptDecision(turn.option || turn.text);
  if (!decision) return undefined;

  const snapshot = await refreshSettlementForSession(session, deps, "refresh");
  const events = snapshot ? snapshot.events.map(mapSettlementEvent) : [];

  if (session.status === "completed") {
    return reply(withUpdate(session, deps), snapshot?.prompt || "This trade is already settled.", snapshot?.options, events);
  }

  if (decision === "received") {
    if (!session.execution.tradeId) {
      const deferred = noteDeferredPlaceholder(session.execution.settlement || {}, "trade_id_missing_for_confirm_receipt");
      session.execution.settlement = deferred.state;
      session.stage = "awaiting_manual_settlement_followup";
      return reply(withUpdate(session, deps), deferred.prompt, deferred.options, [...events, ...deferred.events.map(mapSettlementEvent)]);
    }

    const client = await getExecutionClient(deps, session);
    if (!client.confirmFiatReceived) {
      const deferred = noteDeferredPlaceholder(session.execution.settlement || {}, "confirm_fiat_received_integration_missing");
      session.execution.settlement = deferred.state;
      session.stage = "awaiting_manual_settlement_followup";
      return reply(withUpdate(session, deps), deferred.prompt, deferred.options, [...events, ...deferred.events.map(mapSettlementEvent)]);
    }

    try {
      const confirmedTrade = await client.confirmFiatReceived(session.execution.tradeId);
      if (confirmedTrade?.status) {
        session.execution.tradeStatus = confirmedTrade.status;
        if (session.execution.settlement) session.execution.settlement.tradeStatus = confirmedTrade.status;
      }
      const afterConfirm = await refreshSettlementForSession(session, deps, "refresh");
      const followUpEvents = afterConfirm ? afterConfirm.events.map(mapSettlementEvent) : [];
      const replyText = afterConfirm?.prompt || `Trade #${session.execution.tradeId} receipt confirmed. Escrow release should now be in progress.`;
      return reply(
        withUpdate(session, deps),
        replyText,
        afterConfirm?.options,
        [
          ...events,
          { type: "receipt_confirmed", message: `Confirmed fiat receipt for trade #${session.execution.tradeId}.`, data: { tradeId: session.execution.tradeId } },
          ...followUpEvents,
        ]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const deferred = noteDeferredPlaceholder(session.execution.settlement || {}, `confirm_fiat_received_failed:${message}`);
      session.execution.lastError = message;
      session.execution.settlement = deferred.state;
      session.stage = "awaiting_manual_settlement_followup";
      return reply(
        withUpdate(session, deps),
        `${deferred.prompt} Confirmation attempt failed: ${message}`,
        deferred.options,
        [...events, ...deferred.events.map(mapSettlementEvent)]
      );
    }
  }

  if (decision === "not_received") {
    const notReceived = noteReceiptNotReceived(session.execution.settlement || {}, "user_reported_not_received");
    session.execution.settlement = notReceived.state;
    session.stage = "awaiting_manual_settlement_followup";
    session.status = "active";
    return reply(withUpdate(session, deps), notReceived.prompt, notReceived.options, [...events, ...notReceived.events.map(mapSettlementEvent)]);
  }

  const deferred = noteDeferredPlaceholder(session.execution.settlement || {}, "unsupported_post_match_response");
  session.execution.settlement = deferred.state;
  session.stage = "awaiting_manual_settlement_followup";
  session.status = "active";
  return reply(withUpdate(session, deps), deferred.prompt, deferred.options, [...events, ...deferred.events.map(mapSettlementEvent)]);
}

async function maybeHandleKycTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (!["awaiting_kyc_full_name", "awaiting_kyc_country", "awaiting_kyc_completion"].includes(session.stage)) {
    return undefined;
  }

  const client = await getExecutionClient(deps, session);
  const existingVerificationResult = await maybeResumeExistingKycVerification(session, deps, client);
  if (existingVerificationResult) {
    return existingVerificationResult;
  }
  const text = cleanText(turn.text || turn.option);
  const savedRecipientLookupIntent = hasSavedRecipientLookupIntent(text);
  const savedRecipientLookupQuery = parseSavedContactRecipient(text) || cleanText(session.recipientQuery || session.recipientName);
  const explicitKycIntent = hasKycIntent(text);
  const parsedIdentity = parseKycIdentityInput(text);

  if (savedRecipientLookupIntent) {
    const recipientLine = savedRecipientLookupQuery
      ? ` I can check saved payout details for ${savedRecipientLookupQuery} right after that.`
      : " I can check saved payout details right after that.";
    if (session.stage === "awaiting_kyc_full_name") {
      return reply(
        withUpdate(session, deps),
        `${buildKycRequirementMessage(session)} First, what full legal name should I use for the verification?${recipientLine}`
      );
    }
    if (session.stage === "awaiting_kyc_country") {
      return reply(
        withUpdate(session, deps),
        `${buildKycCountryPrompt(session)}${recipientLine}`
      );
    }
    return reply(
      withUpdate(session, deps),
      `I still need UNIGOX to mark your KYC as approved before I can continue. Once that is done, message me here and I’ll resume the transfer.${recipientLine}`
    );
  }

  if (session.stage === "awaiting_kyc_full_name") {
    const fullName = parsedIdentity.fullName || (looksLikePlausibleLegalName(text) ? text?.trim() : undefined);
    if (!fullName) {
      const prefix = explicitKycIntent ? "I can do that. " : "";
      return reply(
        withUpdate(session, deps),
        `${prefix}${buildKycRequirementMessage(session)} First, what full legal name should I use for the verification?`
      );
    }
    session.auth.kycFullName = fullName;
    if (!session.auth.kycCountryCode && parsedIdentity.countryCode) {
      session.auth.kycCountryCode = parsedIdentity.countryCode;
    }
    return startKycVerificationFlow(session, deps, client);
  }

  if (session.stage === "awaiting_kyc_country") {
    if (!session.auth.kycFullName && parsedIdentity.fullName) {
      session.auth.kycFullName = parsedIdentity.fullName;
    }
    const countryCode = parsedIdentity.countryCode || resolveCountryCode(text);
    if (!countryCode) {
      const prefix = explicitKycIntent ? "I can do that. " : "";
      return reply(withUpdate(session, deps), `${prefix}${buildKycCountryPrompt(session)}`);
    }
    session.auth.kycCountryCode = countryCode;
    return startKycVerificationFlow(session, deps, client);
  }

  if (!client.getKycVerificationStatus) {
    return reply(
      withUpdate(session, deps),
      "I still need UNIGOX to mark your KYC as approved before I can continue. Once that is done, message me here and I’ll resume the transfer."
    );
  }

  let verification = await client.getKycVerificationStatus();
  if (!verification.verification_url && kycVerificationNeedsAttention(verification.status)) {
    verification = await waitForKycVerificationLink(session, deps, client, verification);
  }
  applyKycVerificationSnapshot(session, verification);

  if (isUserKycVerified(session.auth.kycStatus)) {
    session.status = "active";
    session.stage = "resolving";
    session.execution.confirmed = false;
    clearExecutionPreflight(session);
    const refreshedPreflight = await ensureExecutionPreflight(session, deps, client);
    if (refreshedPreflight.blockedResult) {
      return refreshedPreflight.blockedResult;
    }
    session.stage = "awaiting_confirmation";
    return reply(
      withUpdate(session, deps),
      `KYC is approved now. ${buildConfirmationMessage(session)}`
    );
  }


  if (kycVerificationNeedsAttention(verification.status)) {
    return reply(withUpdate(session, deps), buildKycVerificationLinkMessage(session, verification));
  }

  if (verification.status === "failed" || verification.status === "expired") {
    session.auth.kycVerificationUrl = undefined;
    session.auth.kycVerificationSecondsLeft = undefined;
    return startKycVerificationFlow(session, deps, client);
  }

  return startKycVerificationFlow(session, deps, client);
}

async function maybeHandleKycInfoTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  const text = cleanText(turn.text || turn.option);
  if (!text || !hasKycIntent(text)) {
    return undefined;
  }

  const needsQuestion = asksIfKycIsRequired(text);
  const earlyQuestion = asksIfKycCanBeDoneEarly(text);
  const wantsStart = wantsToStartKyc(text) || wantsKycLink(text);
  if (!needsQuestion && !earlyQuestion && !wantsStart) {
    return undefined;
  }

  const kycStageActive = ["awaiting_kyc_full_name", "awaiting_kyc_country", "awaiting_kyc_completion"].includes(session.stage);
  if (wantsStart && kycStageActive) {
    return undefined;
  }

  let client: TransferExecutionClient | undefined;
  if (session.auth.available) {
    client = await getExecutionClient(deps, session);
    await maybeHydrateAuthIdentity(session, deps, client);
  }

  if (wantsStart) {
    if (!session.auth.available || !client) {
      return replyWithSetupInstructions(session, deps);
    }

    if (isUserKycVerified(session.auth.kycStatus)) {
      return reply(withUpdate(session, deps), buildKycEligibilityMessage(session));
    }

    session.status = "blocked";
    session.execution.confirmed = false;
    const intro = buildKycEligibilityMessage(session);

    if (!session.auth.kycFullName) {
      session.stage = "awaiting_kyc_full_name";
      return reply(
        withUpdate(session, deps),
        `${intro} First, what full legal name should I use for the verification?`
      );
    }

    if (!session.auth.kycCountryCode) {
      session.stage = "awaiting_kyc_country";
      return reply(
        withUpdate(session, deps),
        `${intro} Which country should I use for KYC? Send the country name or the 2-letter country code, for example EE.`
      );
    }

    return prependReplyContext(await startKycVerificationFlow(session, deps, client), intro);
  }

  const currentStepHint = buildCurrentKycStepHint(session);
  const earlyLine = earlyQuestion && !isUserKycVerified(session.auth.kycStatus)
    ? " You can do it right away, before sending anything. Say `I want to do KYC` or `give me the KYC link` and I’ll start it here."
    : "";
  const signInLine = !session.auth.available
    ? " To check your exact status or start KYC from here, this skill's UNIGOX settings need to be configured first."
    : "";
  const stepLine = currentStepHint ? ` ${currentStepHint}` : "";
  return reply(withUpdate(session, deps), `${buildKycEligibilityMessage(session)}${earlyLine}${signInLine}${stepLine}`);
}

async function maybeHandleOutstandingTradeReminderTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  const outstanding = session.auth.outstandingTrade;
  if (!outstanding || !session.auth.outstandingTradeReminderShown) return undefined;
  if (outstanding.phase !== "awaiting_receipt_confirmation") return undefined;

  const decision = parseReceiptDecision(turn.option || turn.text);
  if (!decision || decision === "other") return undefined;

  const amountLabel = outstanding.fiatAmount && outstanding.fiatCurrencyCode
    ? `${formatFixed(outstanding.fiatAmount, 2)} ${outstanding.fiatCurrencyCode}`
    : "that earlier transfer";
  const continuation = buildTransferContinuationPrompt(session);

  if (decision === "not_received") {
    clearOutstandingTradeReminder(session);
    return reply(
      withUpdate(session, deps),
      continuation
        ? `Okay, I won't confirm receipt for ${amountLabel} to ${outstanding.recipient} yet. ${continuation}`
        : `Okay, I won't confirm receipt for ${amountLabel} to ${outstanding.recipient} yet.`,
    );
  }

  const client = await getExecutionClient(deps, session);
  if (!client.confirmFiatReceived) {
    return reply(
      withUpdate(session, deps),
      `I still need the signed confirm-payment step for ${amountLabel} to ${outstanding.recipient}, and this setup cannot execute it automatically yet.`,
    );
  }

  try {
    await client.confirmFiatReceived(outstanding.tradeId);
    clearOutstandingTradeReminder(session);
    return reply(
      withUpdate(session, deps),
      continuation
        ? `I confirmed receipt for ${amountLabel} to ${outstanding.recipient}. Escrow release should now be in progress. ${continuation}`
        : `I confirmed receipt for ${amountLabel} to ${outstanding.recipient}. Escrow release should now be in progress.`,
      undefined,
      [{
        type: "receipt_confirmed",
        message: `Confirmed fiat receipt for earlier trade #${outstanding.tradeId}.`,
        data: { tradeId: outstanding.tradeId, source: "startup_reminder" },
      }]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply(
      withUpdate(session, deps),
      `I tried to confirm receipt for ${amountLabel} to ${outstanding.recipient}, but the signed confirm-payment step failed: ${message}`,
    );
  }
}

/**
 * Handles the answer to "the live price is higher than you approved".
 *
 * Nothing was placed when the question was asked, so confirming approves the new crypto cost and
 * places the transfer again, and cancelling only drops the offer.
 *
 * @param session Current session, in `awaiting_new_price_confirmation` with a pending price change.
 * @param turn The person's reply.
 * @param deps Flow collaborators.
 * @returns `undefined` when the session is not waiting for this answer; otherwise the next reply.
 */
async function maybeHandlePendingPriceChangeTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  const pending = session.execution.pendingPriceChange;
  if (session.stage !== "awaiting_new_price_confirmation" || !pending) return undefined;

  const responseText = cleanText(turn.option || turn.text);
  const wantsConfirm = /^(confirm(?: new price)?|accept(?: new price)?|go ahead|proceed|continue)$/i.test(responseText);
  const wantsCancel = /^(cancel|stop|reject(?: new price)?|decline)$/i.test(responseText);

  if (wantsCancel) {
    clearPendingPriceChange(session);
    session.execution.confirmed = false;
    session.stage = "awaiting_no_match_resolution";
    session.status = "active";
    return reply(
      withUpdate(session, deps),
      "Okay, I dropped that updated price and nothing was sent. If you want, I can retry the transfer, change the method, or change the currency.",
      ["retry", "change method", "change currency", "change amount"],
      [{ type: "trade_price_change_cancelled", message: "The person declined the updated price." }]
    );
  }

  if (!wantsConfirm || typeof pending.newCryptoAmount !== "number" || !session.execution.preflight?.quote) {
    return reply(withUpdate(session, deps), buildNewPriceConfirmationMessage(session), ["confirm new price", "cancel"]);
  }

  session.execution.preflight.quote.totalCryptoAmount = pending.newCryptoAmount;
  if (typeof pending.vendorOfferRate === "number") {
    session.execution.preflight.quote.vendorOfferRate = pending.vendorOfferRate;
  }
  clearPendingPriceChange(session);
  session.execution.confirmed = true;
  const result = await handleExecution(session, deps);
  result.events = [
    { type: "trade_price_change_confirmed", message: "The person approved the updated price.", data: { approvedCryptoAmount: pending.newCryptoAmount } },
    ...result.events,
  ];
  return result;
}

async function maybeHandleStatusRequest(session: TransferSession, hints: ParsedHints, deps: TransferFlowDeps): Promise<TransferFlowResult | undefined> {
  if (!hints.checkStatus || !session.execution.tradeRequestId) return undefined;

  const client = await getExecutionClient(deps, session);
  const snapshot = await refreshSettlementForSession(session, deps, "refresh");
  if (snapshot) {
    const events = snapshot.events.map(mapSettlementEvent);
    if (
      snapshot.phase === "awaiting_partner_payment_details"
      || snapshot.phase === "awaiting_escrow_funding"
    ) {
      const tradeRequest = snapshot.tradeRequest || (client.getTradeRequest ? await client.getTradeRequest(session.execution.tradeRequestId) : undefined);
      if (tradeRequest) {
        const advanceEvents = [...events];
        const advanceResult = await maybeAdvanceMatchedTradePreEscrow(
          session,
          deps,
          client,
          tradeRequest,
          snapshot.trade,
          advanceEvents,
          session.execution.preflight?.selectedAssetCode
            || session.execution.preflight?.quote?.cryptoCurrencyCode
            || "USDC",
          session.execution.preflight?.quote?.totalCryptoAmount || session.amount || 0
        );
        if (advanceResult.blockedResult) {
          return advanceResult.blockedResult;
        }
        if (advanceResult.tradeSnapshot?.status && advanceResult.tradeSnapshot.status !== snapshot.trade?.status) {
          const followUp = await refreshSettlementForSession(session, deps, "refresh");
          if (followUp) {
            const followUpEvents = followUp.events.map(mapSettlementEvent);
            return reply(withUpdate(session, deps), followUp.prompt, followUp.options, [...advanceEvents, ...followUpEvents]);
          }
        }
      }
    }
    if (snapshot.phase === "completed") {
      events.push({
        type: "settlement_completed",
        message: `Trade #${snapshot.state.tradeId} reached escrow release.`,
        data: { tradeId: snapshot.state.tradeId, tradeStatus: snapshot.state.tradeStatus },
      });
    } else if (snapshot.phase === "refunded_or_cancelled") {
      events.push({
        type: "settlement_refunded_or_cancelled",
        message: `Trade #${snapshot.state.tradeId} ended without release.`,
        data: { tradeId: snapshot.state.tradeId, tradeStatus: snapshot.state.tradeStatus },
      });
    }
    return reply(withUpdate(session, deps), snapshot.prompt, snapshot.options, events);
  }

  let tradeRequest: TradeRequest | undefined;
  if (client.getTradeRequest) {
    tradeRequest = await client.getTradeRequest(session.execution.tradeRequestId);
    session.execution.tradeRequestStatus = tradeRequest.status;
    if (tradeRequest.trade?.id) session.execution.tradeId = tradeRequest.trade.id;
  }

  let tradeStatus = session.execution.tradeStatus;
  if (session.execution.tradeId && client.getTrade) {
    const trade = await client.getTrade(session.execution.tradeId);
    tradeStatus = trade?.status || tradeStatus;
    session.execution.tradeStatus = tradeStatus;
  }

  const parts = [`Trade request #${session.execution.tradeRequestId}`];
  if (tradeRequest?.status) parts.push(`request status: ${tradeRequest.status}`);
  if (session.execution.tradeId) parts.push(`trade #${session.execution.tradeId}`);
  if (tradeStatus) parts.push(`trade status: ${tradeStatus}`);
  return reply(withUpdate(session, deps), parts.join(" · "));
}

function applyHintsToSession(session: TransferSession, hints: ParsedHints): void {
  if (hints.goal) session.goal = hints.goal;
  if (hints.savedOrNew) session.recipientMode = hints.savedOrNew;
  if (hints.recipient && !session.recipientName) {
    session.recipientQuery = hints.recipient;
  }
  if (hints.currency && !session.currency) {
    session.currency = hints.currency;
  }
  if (typeof hints.amount === "number" && !session.amount) {
    session.amount = hints.amount;
  }
}

function applyMidFlowChanges(session: TransferSession, hints: ParsedHints): boolean {
  let changed = false;
  if (hints.changeCurrency) {
    setCurrency(session, hints.changeCurrency);
    changed = true;
  }
  if (typeof hints.changeAmount === "number") {
    session.amount = hints.changeAmount;
    session.execution.confirmed = false;
    invalidateBalanceState(session);
    changed = true;
  }
  return changed;
}

function maybeConsumeStructuredFieldValue(
  turn: TransferTurn,
  field: PaymentFieldConfig
): string | undefined {
  if (!turn.fields) return undefined;
  const direct = turn.fields[field.field];
  if (typeof direct === "string") return direct;
  const alias = Object.entries(turn.fields).find(([key]) => normalizeMatchValue(key) === normalizeMatchValue(field.field));
  return typeof alias?.[1] === "string" ? alias[1] : undefined;
}

async function maybeSelectPaymentMethodFromText(
  session: TransferSession,
  turn: TransferTurn,
  currencyData: CurrencyPaymentData
): Promise<{ matched?: PaymentMethodInfo; ambiguous?: PaymentMethodInfo[] }> {
  const query = cleanText(turn.option || turn.text);
  if (!query) return {};
  const result = chooseMethod(currencyData.paymentMethods, query);
  return {
    matched: result.method,
    ambiguous: result.ambiguous,
  };
}

async function saveCurrentContact(session: TransferSession, deps: TransferFlowDeps): Promise<TransferFlowEvent | undefined> {
  if (!session.currency || !session.payment || !session.recipientName) return undefined;

  const store = loadContacts(deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
  const result = upsertContactPaymentMethod(store, {
    key: session.contactKey,
    name: session.recipientName,
    aliases: session.aliases || (session.recipientQuery ? [session.recipientQuery] : []),
    currency: session.currency,
    method: {
      method: session.payment.methodName,
      methodId: session.payment.methodId,
      methodSlug: session.payment.methodSlug,
      networkId: session.payment.networkId,
      network: session.payment.networkName,
      networkSlug: session.payment.networkSlug,
      selectedFormatId: session.payment.selectedFormatId,
      details: { ...session.details },
      lastValidatedAt: new Date().toISOString(),
    },
  });
  saveContacts(store, deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
  session.contactKey = result.key;
  session.contactExists = true;
  session.contactStale = false;

  return {
    type: result.created ? "contact_saved" : "contact_updated",
    message: result.created
      ? `Saved ${session.recipientName} for future ${session.currency} transfers.`
      : `Updated ${session.recipientName}'s saved ${session.currency} payout details.`,
    data: { contactKey: result.key, currency: session.currency },
  };
}

async function promptForNextField(session: TransferSession, deps: TransferFlowDeps): Promise<TransferFlowResult> {
  const config = await resolveFieldConfig(session, deps);
  const fields = config.fields;
  while (session.detailCollection.index < fields.length) {
    const field = fields[session.detailCollection.index];
    // Skip bank_name for EUR SEPA/IBAN — it's redundant; SEPA clears via IBAN alone
    if (field.field === "bank_name" && isEurSepaIban(session)) {
      session.detailCollection.index += 1;
      continue;
    }
    if (field.required) {
      return reply(withUpdate(session, deps), currentFieldPrompt(field, session));
    }
    if (typeof session.details[field.field] === "string") {
      session.detailCollection.index += 1;
      continue;
    }
    return reply(withUpdate(session, deps), currentFieldPrompt(field, session));
  }
  return reply(withUpdate(session, deps), "Payment details captured.");
}

async function collectPaymentDetails(session: TransferSession, turn: TransferTurn, deps: TransferFlowDeps): Promise<TransferFlowResult | undefined> {
  // Escape hatch: let user change method or go back from payment details collection
  const detailText = cleanText(turn.text);
  const detailHints = parseIntentHints(detailText);
  if (detailHints.changeMethod || detailHints.goBack) {
    session.payment = undefined;
    session.details = {};
    session.detailCollection = { index: 0 };
    session.stage = "awaiting_payment_method";
    return reply(
      withUpdate(session, deps),
      "No problem. Let's pick a different payment method.",
    );
  }

  const config = await resolveFieldConfig(session, deps);
  const validate = deps.validatePaymentDetailInput || defaultValidatePaymentDetailInput;
  const fields = config.fields;
  let consumedText = false;

  while (session.detailCollection.index < fields.length) {
    const field = fields[session.detailCollection.index];

    // Skip bank_name for EUR SEPA/IBAN — SEPA clears via IBAN alone, no bank name needed
    if (field.field === "bank_name" && isEurSepaIban(session)) {
      session.detailCollection.index += 1;
      continue;
    }

    const structuredValue = maybeConsumeStructuredFieldValue(turn, field);
    const textValue = !consumedText ? cleanText(turn.text) : "";
    const provided = structuredValue ?? (textValue || undefined);

    if (!provided) {
      return reply(withUpdate(session, deps), currentFieldPrompt(field, session));
    }

    if (!structuredValue) consumedText = true;

    if (!field.required && SKIP_RE.test(provided)) {
      session.detailCollection.index += 1;
      continue;
    }

    const partialResult = validate({ [field.field]: provided }, [field]);
    if (!partialResult.valid) {
      const hadPreviousError = Boolean(session.detailCollection.lastError);
      session.detailCollection.lastError = partialResult.errors[0]?.message;
      const errorHint = hadPreviousError
        ? " You can also say 'change method' to pick a different payment option."
        : "";
      return reply(withUpdate(session, deps), `${partialResult.errors[0]?.message}. ${currentFieldPrompt(field, session)}${errorHint}`);
    }

    const normalizedValue = partialResult.normalizedDetails[field.field] ?? provided.trim();
    session.details[field.field] = normalizedValue;
    session.detailCollection.index += 1;
  }

  const effectiveFields = isEurSepaIban(session) ? fields.filter((f) => f.field !== "bank_name") : fields;
  const fullValidation = validate(session.details, effectiveFields);
  session.details = { ...session.details, ...fullValidation.normalizedDetails };
  if (!fullValidation.valid) {
    const firstError = fullValidation.errors[0];
    const fieldIndex = Math.max(0, fields.findIndex((field) => field.field === firstError.field));
    session.detailCollection.index = fieldIndex;
    session.detailCollection.lastError = firstError.message;
    return reply(withUpdate(session, deps), `${firstError.message}. ${currentFieldPrompt(fields[fieldIndex], session)}`);
  }

  session.payment = {
    ...session.payment!,
    methodSlug: session.payment?.methodSlug || config.method.slug,
    networkSlug: session.payment?.networkSlug || config.network.slug,
    networkName: session.payment?.networkName || config.network.name,
    selectedFormatId: config.selectedFormatId,
  };
  return undefined;
}

async function maybeHandlePaymentRouteCorrection(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (session.stage !== "awaiting_confirmation" || !session.currency || !session.payment) return undefined;

  const query = cleanText(turn.option || turn.text);
  if (!query || CONFIRM_RE.test(query) || /^confirm\b/i.test(query)) return undefined;

  const currencyData = await resolvePaymentCatalogue(deps).getPaymentMethodsForCurrency(
    session.currency,
    tokenizeSelectionTerms(`${query} ${session.payment.methodName}`)
  );
  const currentMethod = currencyData.paymentMethods.find((method) => method.slug === session.payment?.methodSlug);
  const selectedMethod = chooseMentionedMethod(currencyData.paymentMethods, query).method;
  const nextMethod = selectedMethod || currentMethod;
  if (!nextMethod) return undefined;

  const nextNetwork = chooseMentionedNetwork(nextMethod.networks, query, nextMethod)
    || (nextMethod.networks.length === 1 ? nextMethod.networks[0] : undefined);

  if (!nextNetwork) {
    if (!selectedMethod || selectedMethod.slug === session.payment.methodSlug) return undefined;
    session.payment = {
      methodId: nextMethod.id,
      methodSlug: nextMethod.slug,
      methodName: nextMethod.name,
      networkId: 0,
      networkSlug: "",
      networkName: "",
    };
    session.details = {};
    session.detailCollection = { index: 0 };
    session.execution.confirmed = false;
    session.execution.paymentDetailsId = undefined;
    clearExecutionPreflight(session);
    session.stage = "awaiting_payment_network";
    return reply(
      withUpdate(session, deps),
      `${nextMethod.name} has multiple payout routes. ${buildPaymentNetworkPrompt(nextMethod, session.currency)}`,
      nextMethod.networks.map((network) => network.name)
    );
  }

  if (nextMethod.slug === session.payment.methodSlug && nextNetwork.slug === session.payment.networkSlug) {
    return undefined;
  }

  const previousDetails = { ...session.details };
  session.payment = {
    methodId: nextMethod.id,
    methodSlug: nextMethod.slug,
    methodName: nextMethod.name,
    networkId: nextNetwork.id,
    networkSlug: nextNetwork.slug,
    networkName: nextNetwork.name,
  };
  session.details = {};
  session.detailCollection = { index: 0 };
  session.contactSaveAction = session.contactExists ? "update" : "create";
  session.execution.confirmed = false;
  session.execution.paymentDetailsId = undefined;
  clearExecutionPreflight(session);

  const config = await resolveFieldConfig(session, deps);
  const relevantDetails = Object.fromEntries(
    config.fields
      .map((field) => [field.field, previousDetails[field.field]])
      .filter(([, value]) => typeof value === "string" && cleanText(value).length > 0)
  ) as Record<string, string>;
  const validate = deps.validatePaymentDetailInput || defaultValidatePaymentDetailInput;
  const validation = validate(relevantDetails, config.fields);
  session.details = { ...validation.normalizedDetails };
  session.payment = {
    ...session.payment,
    methodSlug: config.method.slug,
    networkSlug: config.network.slug,
    networkName: config.network.name,
    selectedFormatId: config.selectedFormatId,
  };

  const routeChangeMessage = buildPaymentRouteChangeMessage(config.method, config.network);
  const events: TransferFlowEvent[] = [];
  if (!validation.valid) {
    const firstError = validation.errors[0];
    const fieldIndex = Math.max(0, config.fields.findIndex((field) => field.field === firstError.field));
    session.detailCollection.index = fieldIndex;
    session.detailCollection.lastError = firstError.message;
    session.stage = "awaiting_payment_details";
    return reply(
      withUpdate(session, deps),
      `${routeChangeMessage} ${firstError.message}. ${currentFieldPrompt(config.fields[fieldIndex])}`,
      undefined,
      events
    );
  }

  session.detailCollection.index = config.fields.length;
  if (session.saveContactDecision === "yes") {
    const savedEvent = await saveCurrentContact(session, deps);
    if (savedEvent) events.push(savedEvent);
  }

  const client = await getExecutionClient(deps, session);
  const preflight = await ensureExecutionPreflight(session, deps, client);
  events.push(...preflight.events);
  if (preflight.blockedResult) {
    preflight.blockedResult.reply = `${routeChangeMessage}\n\n${preflight.blockedResult.reply}`;
    preflight.blockedResult.events = [...events, ...preflight.blockedResult.events];
    return preflight.blockedResult;
  }

  session.stage = "awaiting_confirmation";
  return reply(
    withUpdate(session, deps),
    `${routeChangeMessage}\n\n${buildConfirmationMessage(session)}`,
    undefined,
    events
  );
}

/**
 * Checks, once per amount and currency, that the transfer can be paid: reads the partner wallet,
 * saves the payout details, prices the transfer per asset and picks the asset that covers it.
 *
 * @param session Current session. Its preflight, balance and saved-details id are updated.
 * @param deps Flow collaborators.
 * @param client Backend.
 * @returns Events describing what was checked. `blockedResult` is set, and the session moves to
 *   `awaiting_balance_resolution`, when no single asset covers the transfer.
 * @throws Whatever the backend throws when the balance cannot be read or the details are refused.
 */
async function ensureExecutionPreflight(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient
): Promise<{ events: TransferFlowEvent[]; blockedResult?: TransferFlowResult }> {
  const events: TransferFlowEvent[] = [];
  const amount = session.amount || 0;
  await maybeHydrateAuthIdentity(session, deps, client);

  if (session.execution.preflight && session.execution.preflight.amount === amount && session.execution.preflight.currency === session.currency) {
    return { events };
  }

  const settings = loadSendMoneySettings(deps.settingsFilePath || DEFAULT_SETTINGS_FILE);
  const balance = await client.getWalletBalance();
  session.auth.balanceUsd = balance.totalUsd;
  session.auth.walletBalance = balance;

  const paymentDetail = await client.ensurePaymentDetail({
    fiatCurrencyCode: session.currency!,
    paymentMethodSlug: session.payment!.methodSlug,
    paymentNetworkSlug: session.payment!.networkSlug,
    details: session.details,
  });
  const paymentDetailsId = paymentDetail.id;
  session.execution.paymentDetailsId = paymentDetailsId;
  events.push({
    type: "payment_detail_ensured",
    message: `Ensured payment detail #${paymentDetailsId}.`,
    data: { paymentDetailId: paymentDetailsId },
  });

  const assetCoverageState = await buildAssetCoverageState({
    client,
    balance,
    amount,
    currency: session.currency!,
    paymentMethodSlug: session.payment!.methodSlug,
    paymentNetworkSlug: session.payment!.networkSlug,
    tradePartner: settings.tradePartner,
  });
  const quote = assetCoverageState.quote;

  session.execution.preflight = {
    balanceUsd: balance.totalUsd,
    amount,
    currency: session.currency || "",
    checkedAt: nowIso(deps),
    paymentDetailsId,
    quote,
    walletBalanceAssets: getWalletBalanceAssets(balance),
    assetCoverage: assetCoverageState.assetCoverage,
    selectedAssetCode: assetCoverageState.selectedAssetCode,
    sellAssetBalanceUsd: assetCoverageState.sellAssetBalanceUsd,
    sellAssetRequiredUsd: assetCoverageState.sellAssetRequiredUsd,
    aggregateBalanceEnoughButSingleAssetInsufficient: assetCoverageState.aggregateBalanceEnoughButSingleAssetInsufficient,
  };

  const requiredBalanceUsd = getRequiredBalanceUsd(session.execution.preflight) ?? amount;
  events.push({
    type: "balance_checked",
    message: [
      buildWalletBalanceLine(balance, balance.totalUsd),
      buildPreflightQuoteSummary(session.execution.preflight),
      buildAssetCoverageLine(session.execution.preflight),
      buildTopUpShortfallLine(session.execution.preflight),
      buildPreflightQuoteCaveat(session.execution.preflight),
    ].filter(Boolean).join(" "),
    data: {
      balance: balance.totalUsd,
      amount,
      currency: session.currency,
      paymentDetailsId,
      requiredBalanceUsd,
      selectedAssetCode: session.execution.preflight.selectedAssetCode,
      quoteType: quote?.quoteType,
      vendorOfferRate: quote?.vendorOfferRate,
      totalCryptoAmount: quote?.totalCryptoAmount,
    },
  });

  if (!session.execution.preflight.selectedAssetCode) {
    session.status = "blocked";
    session.stage = "awaiting_balance_resolution";
    const message = [
      buildSenderLine(session.auth.username),
      buildWalletBalanceLine(balance, balance.totalUsd),
      buildPreflightQuoteSummary(session.execution.preflight),
      buildAssetCoverageLine(session.execution.preflight),
      buildTopUpShortfallLine(session.execution.preflight),
      quote
        ? "Until one asset covers that current estimate on its own, I will not place the transfer."
        : `Until one asset covers the requested ${amount} ${session.currency} on its own, I will not place the transfer.`,
      buildPreflightQuoteCaveat(session.execution.preflight),
      FUND_PARTNER_WALLET_PROMPT,
    ].filter(Boolean).join(" ");
    events.push({
      type: "blocked_insufficient_balance",
      message,
      data: {
        balance: balance.totalUsd,
        amount,
        requiredBalanceUsd,
        paymentDetailsId,
        selectedAssetCode: session.execution.preflight.selectedAssetCode,
      },
    });
    return {
      events,
      blockedResult: reply(withUpdate(session, deps), message, [...BALANCE_RESOLUTION_OPTIONS], events),
    };
  }

  return { events };
}

/**
 * Places the confirmed transfer and follows it until something is needed from the person.
 *
 * Runs the preflight, places the order for at most the crypto cost the person approved, waits for
 * a provider, funds the escrow and starts settlement monitoring.
 *
 * @param session Current session with recipient, method, details, amount and confirmation.
 * @param deps Flow collaborators.
 * @returns The next reply: settlement progress, a request to confirm a higher price, a balance or
 *   KYC block, or a no-match prompt.
 * @throws Whatever the backend throws for a failure the flow has no wording for.
 */
async function handleExecution(session: TransferSession, deps: TransferFlowDeps): Promise<TransferFlowResult> {
  const events: TransferFlowEvent[] = [];
  const client = await getExecutionClient(deps, session);
  const settings = loadSendMoneySettings(deps.settingsFilePath || DEFAULT_SETTINGS_FILE);
  const amount = session.amount || 0;

  const preflight = await ensureExecutionPreflight(session, deps, client);
  events.push(...preflight.events);
  if (preflight.blockedResult) {
    preflight.blockedResult.events = [...events.filter((event) => !preflight.blockedResult!.events.includes(event)), ...preflight.blockedResult.events];
    return preflight.blockedResult;
  }

  const paymentDetailsId = session.execution.preflight?.paymentDetailsId;
  if (!paymentDetailsId) {
    throw new Error("Missing payment details id for trade execution.");
  }

  const approvedCryptoAmount = session.execution.preflight?.quote?.totalCryptoAmount || amount;
  const sellAssetCode = session.execution.preflight?.selectedAssetCode || session.execution.preflight?.quote?.cryptoCurrencyCode || SELLABLE_ASSET_ORDER[0];
  let tradeRequest: TradeRequest;
  try {
    tradeRequest = await client.createTradeRequest({
      cryptoCurrencyCode: sellAssetCode,
      fiatCurrencyCode: session.currency!,
      fiatAmount: amount,
      cryptoAmount: approvedCryptoAmount,
      paymentDetailsId,
      tradePartner: settings.tradePartner,
    });
  } catch (error) {
    if (!(error instanceof TransferExecutionError)) throw error;
    session.execution.lastError = error.message;
    if (error.reason === "kyc_required") {
      session.execution.confirmed = false;
      const kycCheck = await maybeEnsureKycReady(session, deps, client);
      return kycCheck.blockedResult ?? startKycVerificationFlow(session, deps, client);
    }
    return replyToUnplacedTransfer(session, deps, error, events);
  }

  if (tradeRequest.status === "new_price_confirming_by_initiator") {
    capturePendingPriceChange(session, tradeRequest);
    session.stage = "awaiting_new_price_confirmation";
    session.status = "active";
    events.push({
      type: "trade_price_changed",
      message: "The live price is higher than the confirmed estimate; nothing was placed.",
      data: {
        newFiatAmount: tradeRequest.fiat_amount,
        newCryptoAmount: tradeRequest.total_crypto_amount,
        originalFiatAmount: session.amount,
        originalCryptoAmount: approvedCryptoAmount,
      },
    });
    return reply(
      withUpdate(session, deps),
      buildNewPriceConfirmationMessage(session, tradeRequest),
      ["confirm new price", "cancel"],
      events
    );
  }

  session.execution.tradeRequestId = tradeRequest.id;
  session.execution.tradeRequestStatus = tradeRequest.status;
  events.push({
    type: "trade_request_created",
    message: `Created trade request #${tradeRequest.id}.`,
    data: { tradeRequestId: tradeRequest.id, status: tradeRequest.status },
  });

  try {
    const matched = await client.waitForTradeMatch(tradeRequest.id, deps.waitForMatchTimeoutMs ?? DEFAULT_WAIT_FOR_MATCH_TIMEOUT_MS);
    return await continueFromMatchedTradeRequest(session, deps, client, matched, events, sellAssetCode, approvedCryptoAmount);
  } catch (error) {
    if (!(error instanceof TransferExecutionError)) throw error;
    session.execution.lastError = error.message;

    if (error.reason === "match_timeout") {
      session.status = "active";
      session.stage = "awaiting_match_status";
      events.push({
        type: "trade_pending",
        message: `Trade request #${tradeRequest.id} is still pending vendor match.`,
        data: { tradeRequestId: tradeRequest.id },
      });
      return reply(
        withUpdate(session, deps),
        "Your transfer is placed and still waiting for a provider to accept it. You can ask for status, retry later, or change the method / currency.",
        ["status", "change method", "change currency"],
        events
      );
    }
    return replyToUnplacedTransfer(session, deps, error, events);
  }
}

/**
 * Tells the person a transfer could not go ahead and what they can do next.
 *
 * @param session Current session. Moves to the stage that fits the failure.
 * @param deps Flow collaborators.
 * @param error The failure, by reason. Its message is engineering detail and is not shown.
 * @param events Events gathered so far in this turn; the failure is appended.
 * @returns The reply for the failure: recheck balance, retry at a new price, or change something.
 */
function replyToUnplacedTransfer(
  session: TransferSession,
  deps: TransferFlowDeps,
  error: TransferExecutionError,
  events: TransferFlowEvent[]
): TransferFlowResult {
  if (error.reason === "insufficient_balance") {
    invalidateBalanceState(session);
    session.execution.confirmed = false;
    session.status = "blocked";
    session.stage = "awaiting_balance_resolution";
    events.push({ type: "blocked_insufficient_balance", message: "The partner wallet could not cover the order at funding time." });
    return reply(
      withUpdate(session, deps),
      `The partner wallet no longer holds enough to fund this transfer, so nothing was sent. ${FUND_PARTNER_WALLET_PROMPT}`,
      [...BALANCE_RESOLUTION_OPTIONS],
      events
    );
  }

  session.execution.confirmed = false;
  session.status = "blocked";
  session.stage = "awaiting_no_match_resolution";
  events.push({ type: "blocked_no_vendor_match", message: `Transfer not placed: ${error.reason}.` });
  const explanation = error.reason === "price_changed"
    ? "The price moved while I was placing the transfer, so nothing was sent."
    : "No provider can take this transfer right now, so nothing was sent.";
  return reply(
    withUpdate(session, deps),
    `${explanation} You can retry, change the amount, or switch payment method / currency.`,
    ["retry", "change method", "change currency", "change amount"],
    events
  );
}

export async function startTransferFlow(turn: TransferTurn | string, deps: TransferFlowDeps = {}): Promise<TransferFlowResult> {
  const normalizedTurn = normalizeTurn(turn);
  const hints = parseIntentHints(normalizedTurn.text);
  const goal = hints.goal || "transfer";
  const session = createSession(goal, deps);
  applyHintsToSession(session, hints);
  return advanceTransferFlow(session, normalizedTurn, deps);
}

export async function advanceTransferFlow(
  inputSession: TransferSession,
  turn: TransferTurn | string,
  deps: TransferFlowDeps = {}
): Promise<TransferFlowResult> {
  const session: TransferSession = JSON.parse(JSON.stringify(inputSession));
  const normalizedTurn = normalizeTurn(turn);
  const hints = parseIntentHints(normalizedTurn.text);
  const stageAwareHints: ParsedHints = { ...hints };
  if (inputSession.stage === "awaiting_payment_details") {
    delete stageAwareHints.amount;
    delete stageAwareHints.currency;
  }
  if (["awaiting_setup", "awaiting_saved_recipient_confirmation"].includes(inputSession.stage)) {
    delete stageAwareHints.recipient;
    delete stageAwareHints.currency;
    delete stageAwareHints.amount;
    delete stageAwareHints.savedOrNew;
    delete stageAwareHints.saveContactDecision;
    delete stageAwareHints.confirm;
    delete stageAwareHints.changeAmount;
    delete stageAwareHints.changeCurrency;
  }
  if (["awaiting_kyc_full_name", "awaiting_kyc_country", "awaiting_kyc_completion"].includes(inputSession.stage)) {
    delete stageAwareHints.recipient;
    delete stageAwareHints.currency;
    delete stageAwareHints.amount;
    delete stageAwareHints.savedOrNew;
    delete stageAwareHints.saveContactDecision;
    delete stageAwareHints.confirm;
    delete stageAwareHints.changeAmount;
    delete stageAwareHints.changeCurrency;
  }
  const events: TransferFlowEvent[] = [];
  let consumedTurnForSelection = false;
  let savedContactReplyNote: string | undefined;
  let handledSavedRecipientDecision = false;

  if (hints.cancel && session.stage !== "awaiting_new_price_confirmation") {
    session.status = "cancelled";
    session.stage = "cancelled";
    return reply(withUpdate(session, deps), "Okay, I cancelled this transfer flow.");
  }

  if (session.stage === "awaiting_saved_recipient_confirmation" && session.pendingSavedRecipientConfirmation) {
    const decisionText = cleanText(normalizedTurn.option || normalizedTurn.text);
    const alternateRecipient = cleanText(stageAwareHints.recipient);
    const reminderDecision = parseReceiptDecision(decisionText);

    if (
      session.auth.outstandingTradeReminderShown
      && session.auth.outstandingTrade?.phase === "awaiting_receipt_confirmation"
      && reminderDecision
      && reminderDecision !== "other"
      && isExplicitReceiptResponse(decisionText)
    ) {
      const reminderReply = await maybeHandleOutstandingTradeReminderTurn(session, normalizedTurn, deps);
      if (reminderReply) {
        reminderReply.session.stage = "awaiting_saved_recipient_confirmation";
        reminderReply.reply = `${reminderReply.reply} ${buildSavedRecipientConfirmationPrompt(session.pendingSavedRecipientConfirmation)}`;
        reminderReply.options = ["yes", "no"];
        return reminderReply;
      }
    }

    if (AFFIRMATIVE_RE.test(decisionText) || CONFIRM_RE.test(decisionText) || /^(use (?:that|them|it)|that one)$/i.test(decisionText)) {
      savedContactReplyNote = addReplyNote(savedContactReplyNote, acceptPendingSavedRecipientConfirmation(session));
      handledSavedRecipientDecision = true;
    } else if (NO_RE.test(decisionText) || /^(different|someone else|not that|other)$/i.test(decisionText)) {
      clearPendingSavedRecipientConfirmation(session);
      session.contactKey = undefined;
      session.remoteSavedContact = undefined;
      session.recipientName = undefined;
      session.recipientQuery = undefined;
      session.aliases = [];
      session.contactExists = false;
      session.contactStale = false;
      session.recipientMode = "saved";
      session.contactSaveAction = undefined;
      session.stage = "awaiting_recipient_name";
      handledSavedRecipientDecision = true;
      return reply(withUpdate(session, deps), "Okay — what exact saved recipient name should I use?");
    } else if (
      alternateRecipient
      && normalizeLookupValue(alternateRecipient) !== normalizeLookupValue(session.pendingSavedRecipientConfirmation.match.contact.name)
    ) {
      clearPendingSavedRecipientConfirmation(session);
      session.contactKey = undefined;
      session.remoteSavedContact = undefined;
      session.recipientName = undefined;
      session.recipientQuery = alternateRecipient;
      session.aliases = [alternateRecipient];
      session.contactExists = false;
      session.contactStale = false;
      session.recipientMode = "saved";
      session.contactSaveAction = undefined;
      session.stage = "resolving";
      handledSavedRecipientDecision = true;
    } else {
      return reply(
        withUpdate(session, deps),
        buildSavedRecipientConfirmationPrompt(session.pendingSavedRecipientConfirmation),
        ["yes", "no"]
      );
    }
  }

  const statusReply = await maybeHandleStatusRequest(session, hints, deps);
  if (statusReply) return statusReply;

  const pendingPriceReply = await maybeHandlePendingPriceChangeTurn(session, normalizedTurn, deps);
  if (pendingPriceReply) return pendingPriceReply;

  const settlementReply = await maybeHandleSettlementTurn(session, normalizedTurn, deps);
  if (settlementReply) return settlementReply;

  const partnerPaymentDetailsReply = await maybeHandlePartnerPaymentDetailsTurn(session, normalizedTurn, deps);
  if (partnerPaymentDetailsReply) return partnerPaymentDetailsReply;

  if (settlementStageActive(session) && session.execution.tradeRequestId) {
    const snapshot = await refreshSettlementForSession(session, deps, "refresh");
    if (snapshot) {
      return reply(withUpdate(session, deps), snapshot.prompt, snapshot.options, snapshot.events.map(mapSettlementEvent));
    }
  }

  if (!session.auth.available) {
    const auth: ResolvedAuthState = deps.authState ?? detectAuthState();
    session.auth = {
      ...session.auth,
      checked: true,
      available: auth.hasReplayableAuth,
      missingSettings: auth.missingSettings,
      username: auth.username ?? session.auth.username,
      balanceUsd: auth.balanceUsd ?? session.auth.balanceUsd,
      walletBalance: auth.walletBalance ?? session.auth.walletBalance,
    };
    if (session.auth.available) {
      if (session.stage === "awaiting_setup") {
        session.status = "active";
        session.stage = "resolving";
      }
      if (session.goal === "transfer") {
        await maybeHydrateStartupAuthStatus(session, deps);
      }
    }
  }

  if (!handledSavedRecipientDecision) {
    const outstandingReminderReply = await maybeHandleOutstandingTradeReminderTurn(session, normalizedTurn, deps);
    if (outstandingReminderReply) return outstandingReminderReply;
  }

  const kycInfoReply = await maybeHandleKycInfoTurn(session, normalizedTurn, deps);
  if (kycInfoReply) return kycInfoReply;

  const kycReply = await maybeHandleKycTurn(session, normalizedTurn, deps);
  if (kycReply) return kycReply;

  applyHintsToSession(session, stageAwareHints);
  applyMidFlowChanges(session, hints);

  // Mid-flow recipient correction
  const RECIPIENT_CHANGEABLE_STAGES: TransferStage[] = [
    "awaiting_currency", "awaiting_amount", "awaiting_payment_method",
    "awaiting_payment_network", "awaiting_payment_details",
    "awaiting_save_contact_decision", "awaiting_confirmation",
  ];
  if (hints.changeRecipient !== undefined && RECIPIENT_CHANGEABLE_STAGES.includes(session.stage)) {
    session.recipientName = undefined;
    session.recipientQuery = undefined;
    session.contactKey = undefined;
    session.remoteSavedContact = undefined;
    session.aliases = [];
    session.contactExists = false;
    session.contactStale = false;
    session.recipientMode = undefined;
    session.contactSaveAction = undefined;
    session.currency = undefined;
    session.amount = undefined;
    session.payment = undefined;
    session.details = {};
    session.detailCollection = { index: 0 };
    session.execution.confirmed = false;
    clearExecutionPreflight(session);
    session.stage = "awaiting_recipient_name";
    if (hints.changeRecipient) {
      session.recipientQuery = hints.changeRecipient;
    }
    const prompt = hints.changeRecipient
      ? `Got it, switching recipient to ${hints.changeRecipient}. Let me look them up.`
      : "No problem. Who should I send to instead?";
    if (hints.changeRecipient) {
      session.stage = "resolving";
    }
    return reply(withUpdate(session, deps), prompt);
  }

  // Mid-flow payment method correction from any payment/details stage
  if (hints.changeMethod && ["awaiting_payment_network", "awaiting_payment_details"].includes(session.stage)) {
    session.payment = undefined;
    session.details = {};
    session.detailCollection = { index: 0 };
    session.stage = "awaiting_payment_method";
    return reply(withUpdate(session, deps), "No problem. Let's pick a different payment method.");
  }

  const paymentRouteCorrectionReply = await maybeHandlePaymentRouteCorrection(session, normalizedTurn, deps);
  if (paymentRouteCorrectionReply) return paymentRouteCorrectionReply;

  const balanceReply = await maybeHandleBalanceResolutionTurn(session, normalizedTurn, deps);
  if (balanceReply) return balanceReply;

  if (session.goal !== "save_contact_only" && !session.auth.available) {
    return replyWithSetupInstructions(session, deps);
  }

  if (!session.recipientMode && !session.recipientQuery && !session.recipientName) {
    session.stage = "awaiting_recipient_mode";
    return reply(withUpdate(session, deps), "Is this for a saved contact or a new recipient?", ["saved contact", "new recipient"]);
  }

  if (session.recipientMode === "saved" && !session.recipientQuery && !session.recipientName) {
    session.stage = "awaiting_recipient_name";
    return reply(withUpdate(session, deps), "Who do you want to send money to?");
  }

  if (session.recipientMode === "new" && !session.recipientName) {
    session.stage = "awaiting_recipient_name";
    const parsedRecipient = hints.savedOrNew ? undefined : parseRecipient(normalizedTurn.text);
    if (parsedRecipient) {
      session.recipientName = parsedRecipient;
      session.recipientQuery = parsedRecipient;
    } else {
      return reply(withUpdate(session, deps), "What is the recipient's full name?");
    }
  }

  if (session.recipientQuery && !session.recipientName) {
    const { resolution, source } = await resolveSavedRecipientQuery(session, deps);
    if (resolution.match) {
      if (shouldDoubleConfirmSavedRecipient(resolution, session.recipientQuery) && !stageAwareHints.amount) {
        return reply(
          withUpdate(session, deps),
          startSavedRecipientConfirmation(session, resolution, source, session.recipientQuery),
          ["yes", "no"]
        );
      }
      savedContactReplyNote = addReplyNote(savedContactReplyNote, applyResolvedSavedRecipient(session, resolution, source, session.recipientQuery));
    } else if (session.recipientMode === "saved") {
      session.stage = "awaiting_recipient_name";
      if (resolution.ambiguous.length) {
        return reply(
          withUpdate(session, deps),
          buildSavedContactDisambiguation(session.recipientQuery, resolution.ambiguous),
          resolution.ambiguous.map((match) => match.contact.name)
        );
      }
      return reply(withUpdate(session, deps), `I couldn't find a saved contact or saved UNIGOX payout route for '${session.recipientQuery}'. Who is the recipient?`);
    } else {
      session.remoteSavedContact = undefined;
      session.recipientName = session.recipientQuery;
      session.aliases = [session.recipientQuery];
      session.contactExists = false;
      session.recipientMode = "new";
      session.contactSaveAction = "create";
    }
  }

  const knownRecipientQuery = cleanText(session.recipientQuery || session.recipientName);
  const normalizedKnownRecipient = normalizeLookupValue(knownRecipientQuery);
  const normalizedHintedRecipient = normalizeLookupValue(hints.recipient);
  const explicitSavedRecipientLookup = stageAwareHints.savedOrNew === "saved";
  const shouldRecheckSavedRecipient = Boolean(
    session.goal === "transfer"
    && !session.contactExists
    && !session.contactKey
    && !session.remoteSavedContact
    && (
      explicitSavedRecipientLookup
      || (session.recipientQuery && !session.recipientName)
      || session.recipientMode === "saved"
      || (
        hints.recipient
        && session.stage !== "awaiting_recipient_name"
        && normalizedHintedRecipient
        && normalizedHintedRecipient === normalizedKnownRecipient
      )
    )
  );
  const recipientLookupQuery = cleanText(
    explicitSavedRecipientLookup
      ? (hints.recipient || session.recipientQuery || session.recipientName)
      : shouldRecheckSavedRecipient && hints.recipient
      ? hints.recipient
      : knownRecipientQuery
  );
  if (
    recipientLookupQuery
    && shouldRecheckSavedRecipient
  ) {
    session.recipientQuery = recipientLookupQuery;
    const { resolution, source } = await resolveSavedRecipientQuery(session, deps);
    if (resolution.match) {
      if (shouldDoubleConfirmSavedRecipient(resolution, recipientLookupQuery) && !stageAwareHints.amount) {
        return prependReplyContext(
          reply(
            withUpdate(session, deps),
            startSavedRecipientConfirmation(session, resolution, source, recipientLookupQuery),
            ["yes", "no"]
          ),
          savedContactReplyNote
        );
      }
      savedContactReplyNote = addReplyNote(savedContactReplyNote, applyResolvedSavedRecipient(session, resolution, source, recipientLookupQuery));
    } else if (resolution.ambiguous.length && (hints.recipient || session.recipientMode === "saved")) {
      session.stage = "awaiting_recipient_name";
      return reply(
        withUpdate(session, deps),
        buildSavedContactDisambiguation(recipientLookupQuery, resolution.ambiguous),
        resolution.ambiguous.map((match) => match.contact.name)
      );
    }
  }

  if (session.contactExists && !session.currency) {
    const contact = getResolvedSavedContact(session, deps);
    const singleStoredPayment = getSingleStoredPaymentSetup(contact);
    if (singleStoredPayment) {
      setCurrency(session, singleStoredPayment.currency);
      savedContactReplyNote = addReplyNote(
        savedContactReplyNote,
        `I'll start from the saved ${summarizeStoredPaymentRoute(singleStoredPayment.currency, singleStoredPayment.method)} payout route by default.`
      );
    }
  }

  if (!session.currency) {
    session.stage = "awaiting_currency";
    const maybeCurrency = parseStandaloneCurrency(normalizedTurn.text);
    if (maybeCurrency) {
      setCurrency(session, maybeCurrency);
    } else {
      return prependReplyContext(
        reply(withUpdate(session, deps), "What currency should the recipient receive? If you don't specify, I can default to EUR."),
        savedContactReplyNote
      );
    }
  }

  if (session.contactExists && !session.payment) {
    const contact = getResolvedSavedContact(session, deps);
    const singleStoredPayment = getSingleStoredPaymentSetup(contact);
    if (singleStoredPayment && singleStoredPayment.currency === session.currency) {
      savedContactReplyNote = addReplyNote(
        savedContactReplyNote,
        `I'll start from the saved ${summarizeStoredPaymentRoute(singleStoredPayment.currency, singleStoredPayment.method)} payout route by default.`
      );
    }
    if (contact?.paymentMethods?.[session.currency!]) {
      const validation = await validateStoredContactSelection(session, contact, deps);
      if (!validation.valid) {
        session.stage = "awaiting_payment_details";
        const fieldPrompt = await promptForNextField(session, deps);
        fieldPrompt.reply = `I found saved ${session.currency} details for ${session.recipientName}, but they look stale or incomplete. ${fieldPrompt.reply}`;
        return prependReplyContext(fieldPrompt, savedContactReplyNote);
      }
    }
  }

  if (!session.payment) {
    const currencyData = await resolvePaymentCatalogue(deps).getPaymentMethodsForCurrency(
      session.currency!,
      tokenizeSelectionTerms(normalizedTurn.option || normalizedTurn.text)
    );
    const selection = await maybeSelectPaymentMethodFromText(session, normalizedTurn, currencyData);

    if (selection.matched) {
      const method = selection.matched;
      if (method.networks.length > 1) {
        consumedTurnForSelection = true;
        session.payment = {
          methodId: method.id,
          methodSlug: method.slug,
          methodName: method.name,
          networkId: 0,
          networkSlug: "",
          networkName: "",
        };
        session.stage = "awaiting_payment_network";
        return prependReplyContext(
          reply(
            withUpdate(session, deps),
            buildPaymentNetworkPrompt(method, session.currency!),
            method.networks.map((network) => network.name)
          ),
          savedContactReplyNote
        );
      }

      const network = method.networks[0];
      consumedTurnForSelection = true;
      session.payment = {
        methodId: method.id,
        methodSlug: method.slug,
        methodName: method.name,
        networkId: network.id,
        networkSlug: network.slug,
        networkName: network.name,
      };
      session.contactSaveAction = session.contactExists ? "update" : "create";
    } else {
      session.stage = "awaiting_payment_method";
      const ambiguity = selection.ambiguous?.length
        ? `I found multiple matches: ${selection.ambiguous.map((method) => method.name).join(", ")}.`
        : undefined;
      return prependReplyContext(
        reply(withUpdate(session, deps), buildPaymentMethodPrompt(session, currencyData, ambiguity)),
        savedContactReplyNote
      );
    }
  }

  if (session.payment && !session.payment.networkSlug) {
    const currencyData = await resolvePaymentCatalogue(deps).getPaymentMethodsForCurrency(
      session.currency!,
      tokenizeSelectionTerms(session.payment.methodName)
    );
    const method = currencyData.paymentMethods.find((entry) => entry.slug === session.payment?.methodSlug);
    if (!method) {
      resetPaymentSelection(session);
      return prependReplyContext(
        reply(withUpdate(session, deps), `I couldn't re-resolve that payment method for ${session.currency}. Let's pick it again.`),
        savedContactReplyNote
      );
    }
    const network = chooseNetwork(method.networks, normalizedTurn.option || normalizedTurn.text || "");
    if (!network) {
      session.stage = "awaiting_payment_network";
      return prependReplyContext(
        reply(
          withUpdate(session, deps),
          buildPaymentNetworkPrompt(method, session.currency!),
          method.networks.map((entry) => entry.name)
        ),
        savedContactReplyNote
      );
    }
    consumedTurnForSelection = true;
    session.payment = {
      ...session.payment,
      networkId: network.id,
      networkSlug: network.slug,
      networkName: network.name,
    };
  }

  const detailTurn = consumedTurnForSelection && !normalizedTurn.fields ? { ...normalizedTurn, text: "", option: undefined } : normalizedTurn;
  const detailResult = await collectPaymentDetails(session, detailTurn, deps);
  if (detailResult) {
    detailResult.session.stage = "awaiting_payment_details";
    return prependReplyContext(detailResult, savedContactReplyNote);
  }

  if (session.saveContactDecision !== "no" && (!session.contactExists || session.contactStale || session.goal === "save_contact_only")) {
    session.stage = "awaiting_save_contact_decision";
    if (hints.saveContactDecision === "yes") {
      session.saveContactDecision = "yes";
      const event = await saveCurrentContact(session, deps);
      if (event) events.push(event);
      if (session.goal === "save_contact_only") {
        session.status = "completed";
        session.stage = "completed";
        return prependReplyContext(
          reply(withUpdate(session, deps), event?.message || `${session.recipientName} saved.`, undefined, events),
          savedContactReplyNote
        );
      }
    } else if (hints.saveContactDecision === "no") {
      session.saveContactDecision = "no";
      if (session.goal === "save_contact_only") {
        session.status = "completed";
        session.stage = "completed";
        return prependReplyContext(
          reply(withUpdate(session, deps), `Okay, I didn't save ${session.recipientName}.`, undefined, events),
          savedContactReplyNote
        );
      }
    } else {
      return prependReplyContext(
        reply(withUpdate(session, deps), buildSavePrompt(session)),
        savedContactReplyNote
      );
    }
  }

  if (session.goal === "save_contact_only") {
    session.status = "completed";
    session.stage = "completed";
    return prependReplyContext(
      reply(withUpdate(session, deps), `${session.recipientName} is ready for later transfers.`, undefined, events),
      savedContactReplyNote
    );
  }

  if (!session.amount) {
    session.stage = "awaiting_amount";
    const parsed = parseAmountAndCurrency(normalizedTurn.text);
    if (parsed.amount) {
      session.amount = parsed.amount;
      if (parsed.currency && parsed.currency !== session.currency) {
        setCurrency(session, parsed.currency);
        return prependReplyContext(
          reply(withUpdate(session, deps), `You asked for ${parsed.currency}, so I reset the payout method selection. Which method should I use?`, undefined, events),
          savedContactReplyNote
        );
      }
    } else {
      return prependReplyContext(
        reply(withUpdate(session, deps), `How much ${session.currency} should I send to ${session.recipientName}?`, undefined, events),
        savedContactReplyNote
      );
    }
  }

  const client = await getExecutionClient(deps, session);
  const preflight = await ensureExecutionPreflight(session, deps, client);
  events.push(...preflight.events);
  if (preflight.blockedResult) {
    return prependReplyContext(preflight.blockedResult, savedContactReplyNote);
  }

  const kycCheck = await maybeEnsureKycReady(session, deps, client);
  if (kycCheck.blockedResult) {
    return prependReplyContext(kycCheck.blockedResult, savedContactReplyNote);
  }

  const confirmationReply = stageAwareHints.confirm
    || (session.stage === "awaiting_confirmation" && /^confirm\b/i.test(cleanText(normalizedTurn.text)));

  if (!session.execution.confirmed) {
    session.stage = "awaiting_confirmation";
    if (confirmationReply) {
      session.execution.confirmed = true;
    } else {
      return prependReplyContext(
        reply(withUpdate(session, deps), buildConfirmationMessage(session), undefined, events),
        savedContactReplyNote
      );
    }
  }

  return prependReplyContext(await handleExecution(session, { ...deps, client }), savedContactReplyNote);
}
