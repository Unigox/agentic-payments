#!/usr/bin/env -S node --experimental-strip-types
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import UnigoxClient, {
  getPaymentMethodsForCurrency as defaultGetPaymentMethodsForCurrency,
  getPaymentMethodFieldConfig as defaultGetPaymentMethodFieldConfig,
  validatePaymentDetailInput as defaultValidatePaymentDetailInput,
  getUnigoxWalletConnectionPrompt,
} from "./unigox-client.ts";
import type {
  AgenticPaymentsSettings,
  CurrencyPaymentData,
  NetworkFieldConfig,
  PaymentDetail,
  PaymentFieldValidationResult,
  PaymentMethodInfo,
  PaymentNetworkInfo,
  ResolvedPaymentMethodFieldConfig,
  TradeRequest,
  UnigoxClientConfig,
  WalletBalance,
} from "./unigox-client.ts";
import {
  DEFAULT_CONTACTS_FILE,
  SKILL_DIR,
  loadContacts,
  saveContacts,
  resolveContact,
  upsertContactPaymentMethod,
} from "./contact-store.ts";
import type { ContactMatch, ContactRecord, StoredPaymentMethod } from "./contact-store.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SETTINGS_FILE = path.join(SKILL_DIR, "settings.json");

type AuthChoice = "evm" | "ton" | "email";

export type TransferGoal = "transfer" | "save_contact_only";
export type TransferStage =
  | "resolving"
  | "awaiting_auth_choice"
  | "awaiting_recipient_mode"
  | "awaiting_recipient_name"
  | "awaiting_currency"
  | "awaiting_payment_method"
  | "awaiting_payment_network"
  | "awaiting_payment_details"
  | "awaiting_save_contact_decision"
  | "awaiting_amount"
  | "awaiting_confirmation"
  | "awaiting_balance_resolution"
  | "awaiting_match_status"
  | "awaiting_no_match_resolution"
  | "completed"
  | "blocked"
  | "cancelled";

export interface TransferTurn {
  text?: string;
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
    | "trade_pending"
    | "blocked_missing_auth"
    | "blocked_insufficient_balance"
    | "blocked_no_vendor_match";
  message: string;
  data?: Record<string, unknown>;
}

export interface TransferExecutionClient {
  getWalletBalance(): Promise<WalletBalance>;
  ensurePaymentDetail(params: {
    paymentMethodId: number;
    paymentNetworkId: number;
    fiatCurrencyCode: string;
    details: Record<string, string>;
  }): Promise<PaymentDetail>;
  createTradeRequest(params: {
    tradeType: "BUY" | "SELL";
    cryptoCurrencyCode?: string;
    fiatCurrencyCode: string;
    fiatAmount: number;
    cryptoAmount: number;
    paymentDetailsId: number;
    paymentMethodId: number;
    paymentNetworkId: number;
    preferredVendor?: string;
    tradePartner?: "licensed" | "p2p" | "all";
  }): Promise<TradeRequest>;
  waitForTradeMatch(tradeRequestId: number, timeoutMs?: number): Promise<TradeRequest>;
  getTradeRequest?(tradeRequestId: number): Promise<TradeRequest>;
  getTrade?(tradeId: number): Promise<any>;
}

export interface TransferFlowDeps {
  contactsFilePath?: string;
  settingsFilePath?: string;
  waitForMatchTimeoutMs?: number;
  now?: () => Date;
  authState?: AuthState;
  client?: TransferExecutionClient;
  clientFactory?: () => Promise<TransferExecutionClient>;
  clientConfig?: UnigoxClientConfig;
  getPaymentMethodsForCurrency?: (currency: string) => Promise<CurrencyPaymentData>;
  getPaymentMethodFieldConfig?: (params: {
    currency: string;
    methodSlug?: string;
    methodId?: number;
    networkSlug?: string;
    networkId?: number;
  }) => Promise<ResolvedPaymentMethodFieldConfig>;
  validatePaymentDetailInput?: (
    details: Record<string, string>,
    fields: NetworkFieldConfig[],
    options?: { countryCode?: string; formatId?: string }
  ) => PaymentFieldValidationResult;
}

export interface AuthState {
  hasReplayableAuth: boolean;
  authMode?: "evm" | "ton" | "email";
  emailFallbackAvailable: boolean;
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
    mode?: "evm" | "ton" | "email";
    choice?: AuthChoice;
  };
  execution: {
    confirmed: boolean;
    paymentDetailsId?: number;
    tradeRequestId?: number;
    tradeId?: number;
    tradeRequestStatus?: string;
    tradeStatus?: string;
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
  authChoice?: AuthChoice;
  changeCurrency?: string;
  changeAmount?: number;
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

function maskDetailMap(details: Record<string, string>): string {
  return Object.entries(details)
    .map(([field, value]) => `${field}=${value}`)
    .join(", ");
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

function parseIntentHints(text: string | undefined): ParsedHints {
  const value = cleanText(text);
  if (!value) return {};
  const lower = value.toLowerCase();
  const amountCurrency = parseAmountAndCurrency(value);

  const hints: ParsedHints = {
    ...(amountCurrency.amount ? { amount: amountCurrency.amount } : {}),
    ...(amountCurrency.currency ? { currency: amountCurrency.currency } : {}),
  };

  if (/(?:save|add).*(?:contact|recipient)|contact only|for later/.test(lower)) {
    hints.goal = "save_contact_only";
  }
  if (/make a transfer|send money|send|transfer|pay /.test(lower) && !hints.goal) {
    hints.goal = "transfer";
  }
  if (/saved contact|existing contact|someone saved/.test(lower)) {
    hints.savedOrNew = "saved";
  }
  if (/new recipient|new contact|someone new/.test(lower)) {
    hints.savedOrNew = "new";
  }
  const recipient = parseRecipient(value);
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
  if (/^(evm|evm wallet|wallet connection evm)$/i.test(value)) {
    hints.authChoice = "evm";
  } else if (/^(ton|ton wallet|wallet connection ton)$/i.test(value)) {
    hints.authChoice = "ton";
  } else if (/^(email|otp|email otp)$/i.test(value)) {
    hints.authChoice = "email";
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

function reply(session: TransferSession, message: string, options?: string[], events: TransferFlowEvent[] = []): TransferFlowResult {
  session.lastPrompt = message;
  return {
    session,
    reply: message,
    options,
    done: session.status === "completed" || session.status === "cancelled",
    events,
  };
}

function getEnvCandidates(): string[] {
  return [
    path.join(SKILL_DIR, ".env"),
    path.join(process.env.HOME || "", ".openclaw", ".env"),
  ];
}

function loadEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const envPath of getEnvCandidates()) {
    if (!envPath || !fs.existsSync(envPath)) continue;
    const line = fs.readFileSync(envPath, "utf-8")
      .split("\n")
      .find((entry) => entry.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

export function detectAuthState(): AuthState {
  const privateKey = loadEnvValue("UNIGOX_PRIVATE_KEY");
  const tonMnemonic = loadEnvValue("UNIGOX_TON_MNEMONIC");
  const email = loadEnvValue("UNIGOX_EMAIL");

  if (privateKey) {
    return { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: !!email };
  }
  if (tonMnemonic) {
    return { hasReplayableAuth: true, authMode: "ton", emailFallbackAvailable: !!email };
  }
  return { hasReplayableAuth: false, authMode: email ? "email" : undefined, emailFallbackAvailable: !!email };
}

export function loadUnigoxConfigFromEnv(): UnigoxClientConfig {
  const privateKey = loadEnvValue("UNIGOX_PRIVATE_KEY");
  if (privateKey) {
    return { privateKey, authMode: "evm" };
  }

  const tonMnemonic = loadEnvValue("UNIGOX_TON_MNEMONIC");
  if (tonMnemonic) {
    return {
      authMode: loadEnvValue("UNIGOX_AUTH_MODE") === "ton" ? "ton" : "auto",
      tonMnemonic,
      tonAddress: loadEnvValue("UNIGOX_TON_ADDRESS"),
      tonNetwork: loadEnvValue("UNIGOX_TON_NETWORK") || "-239",
      email: loadEnvValue("UNIGOX_EMAIL"),
    };
  }

  const email = loadEnvValue("UNIGOX_EMAIL");
  if (email) {
    return { email, authMode: "email" };
  }

  throw new Error(`UNIGOX auth config not found. ${getUnigoxWalletConnectionPrompt()}`);
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

async function getExecutionClient(deps: TransferFlowDeps): Promise<TransferExecutionClient> {
  if (deps.client) return deps.client;
  if (deps.clientFactory) return deps.clientFactory();
  return new UnigoxClient(deps.clientConfig || loadUnigoxConfigFromEnv());
}

function resetPaymentSelection(session: TransferSession): void {
  session.payment = undefined;
  session.details = {};
  session.detailCollection = { index: 0 };
  session.saveContactDecision = undefined;
  session.contactSaveAction = session.contactExists ? "update" : "create";
  session.execution.confirmed = false;
}

function setCurrency(session: TransferSession, currency: string): void {
  session.currency = currency.toUpperCase();
  resetPaymentSelection(session);
}

function summarizePayment(session: TransferSession): string {
  if (!session.payment) return "payment method pending";
  return `${session.payment.methodName} via ${session.payment.networkName}`;
}

function buildConfirmationMessage(session: TransferSession): string {
  return [
    `Send ${session.amount} ${session.currency} to ${session.recipientName} via ${summarizePayment(session)}?`,
    `Details: ${maskDetailMap(session.details)}`,
    "Reply 'confirm' to proceed, or tell me what to change.",
  ].join(" ");
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

function currentFieldPrompt(field: NetworkFieldConfig): string {
  const optional = field.required ? "" : " Optional — you can say 'skip'.";
  const hint = field.placeholder ? ` ${field.placeholder}.` : field.description ? ` ${field.description}.` : "";
  return `Please provide ${field.label || field.field}.${hint}${optional}`.trim();
}

async function resolveFieldConfig(session: TransferSession, deps: TransferFlowDeps): Promise<ResolvedPaymentMethodFieldConfig> {
  if (!session.currency || !session.payment) {
    throw new Error("Cannot resolve field config without currency and payment selection");
  }
  const getFieldConfig = deps.getPaymentMethodFieldConfig || defaultGetPaymentMethodFieldConfig;
  return getFieldConfig({
    currency: session.currency,
    methodId: session.payment.methodId,
    methodSlug: session.payment.methodSlug,
    networkId: session.payment.networkId,
    networkSlug: session.payment.networkSlug,
  });
}

function fieldValidationOptions(config: ResolvedPaymentMethodFieldConfig): { countryCode?: string; formatId?: string } {
  return {
    countryCode: config.networkConfig.countryCode,
    formatId: config.selectedFormatId,
  };
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
  const result = validate(session.details, config.fields, fieldValidationOptions(config));
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

async function maybeHandleStatusRequest(session: TransferSession, hints: ParsedHints, deps: TransferFlowDeps): Promise<TransferFlowResult | undefined> {
  if (!hints.checkStatus || !session.execution.tradeRequestId) return undefined;

  const client = await getExecutionClient(deps);
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
  if (hints.authChoice) {
    session.auth.choice = hints.authChoice;
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
    changed = true;
  }
  return changed;
}

function maybeConsumeStructuredFieldValue(
  turn: TransferTurn,
  field: NetworkFieldConfig
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
    if (field.required) {
      return reply(withUpdate(session, deps), currentFieldPrompt(field));
    }
    if (typeof session.details[field.field] === "string") {
      session.detailCollection.index += 1;
      continue;
    }
    return reply(withUpdate(session, deps), currentFieldPrompt(field));
  }
  return reply(withUpdate(session, deps), "Payment details captured.");
}

async function collectPaymentDetails(session: TransferSession, turn: TransferTurn, deps: TransferFlowDeps): Promise<TransferFlowResult | undefined> {
  const config = await resolveFieldConfig(session, deps);
  const validate = deps.validatePaymentDetailInput || defaultValidatePaymentDetailInput;
  const options = fieldValidationOptions(config);
  const fields = config.fields;
  let consumedText = false;

  while (session.detailCollection.index < fields.length) {
    const field = fields[session.detailCollection.index];
    const structuredValue = maybeConsumeStructuredFieldValue(turn, field);
    const textValue = !consumedText ? cleanText(turn.text) : "";
    const provided = structuredValue ?? (textValue || undefined);

    if (!provided) {
      return reply(withUpdate(session, deps), currentFieldPrompt(field));
    }

    if (!structuredValue) consumedText = true;

    if (!field.required && SKIP_RE.test(provided)) {
      session.detailCollection.index += 1;
      continue;
    }

    const partialResult = validate({ [field.field]: provided }, [field], options);
    if (!partialResult.valid) {
      session.detailCollection.lastError = partialResult.errors[0]?.message;
      return reply(withUpdate(session, deps), `${partialResult.errors[0]?.message}. ${currentFieldPrompt(field)}`);
    }

    const normalizedValue = partialResult.normalizedDetails[field.field] ?? provided.trim();
    session.details[field.field] = normalizedValue;
    session.detailCollection.index += 1;
  }

  const fullValidation = validate(session.details, fields, options);
  session.details = { ...session.details, ...fullValidation.normalizedDetails };
  if (!fullValidation.valid) {
    const firstError = fullValidation.errors[0];
    const fieldIndex = Math.max(0, fields.findIndex((field) => field.field === firstError.field));
    session.detailCollection.index = fieldIndex;
    session.detailCollection.lastError = firstError.message;
    return reply(withUpdate(session, deps), `${firstError.message}. ${currentFieldPrompt(fields[fieldIndex])}`);
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

async function handleExecution(session: TransferSession, deps: TransferFlowDeps): Promise<TransferFlowResult> {
  const events: TransferFlowEvent[] = [];
  const client = await getExecutionClient(deps);
  const settings = loadSendMoneySettings(deps.settingsFilePath || DEFAULT_SETTINGS_FILE);
  const amount = session.amount || 0;

  const balance = await client.getWalletBalance();
  if (balance.totalUsd < amount) {
    session.status = "blocked";
    session.stage = "awaiting_balance_resolution";
    const message = `Your wallet balance is ${balance.totalUsd.toFixed(2)} USD, which is below the requested ${amount} ${session.currency}. Fund the wallet or change the amount.`;
    events.push({
      type: "blocked_insufficient_balance",
      message,
      data: { balance: balance.totalUsd, amount },
    });
    return reply(withUpdate(session, deps), message, ["change amount", "fund wallet"], events);
  }

  const paymentDetail = await client.ensurePaymentDetail({
    paymentMethodId: session.payment!.methodId,
    paymentNetworkId: session.payment!.networkId,
    fiatCurrencyCode: session.currency!,
    details: session.details,
  });
  session.execution.paymentDetailsId = paymentDetail.id;
  events.push({
    type: "payment_detail_ensured",
    message: `Ensured payment detail #${paymentDetail.id}.`,
    data: { paymentDetailId: paymentDetail.id },
  });

  const tradeRequest = await client.createTradeRequest({
    tradeType: "SELL",
    fiatCurrencyCode: session.currency!,
    fiatAmount: amount,
    cryptoAmount: amount,
    paymentDetailsId: paymentDetail.id,
    paymentMethodId: session.payment!.methodId,
    paymentNetworkId: session.payment!.networkId,
    tradePartner: settings.tradePartner,
  });

  session.execution.tradeRequestId = tradeRequest.id;
  session.execution.tradeRequestStatus = tradeRequest.status;
  events.push({
    type: "trade_request_created",
    message: `Created trade request #${tradeRequest.id}.`,
    data: { tradeRequestId: tradeRequest.id, status: tradeRequest.status },
  });

  try {
    const matched = await client.waitForTradeMatch(tradeRequest.id, deps.waitForMatchTimeoutMs || 120_000);
    session.execution.tradeRequestStatus = matched.status;
    session.execution.tradeId = matched.trade?.id;
    session.execution.tradeStatus = matched.trade?.status;
    session.status = "completed";
    session.stage = "completed";
    events.push({
      type: "trade_matched",
      message: `Trade request #${matched.id} matched${matched.trade?.id ? ` with trade #${matched.trade.id}` : ""}.`,
      data: { tradeRequestId: matched.id, tradeId: matched.trade?.id, tradeStatus: matched.trade?.status },
    });
    return reply(
      withUpdate(session, deps),
      matched.trade?.id
        ? `Trade request #${matched.id} matched. Trade #${matched.trade.id} is now ${matched.trade.status || "created"}.`
        : `Trade request #${matched.id} matched successfully.`,
      undefined,
      events
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.execution.lastError = message;

    if (/timed out/i.test(message)) {
      session.status = "active";
      session.stage = "awaiting_match_status";
      events.push({
        type: "trade_pending",
        message: `Trade request #${tradeRequest.id} is still pending vendor match.`,
        data: { tradeRequestId: tradeRequest.id },
      });
      return reply(
        withUpdate(session, deps),
        `Trade request #${tradeRequest.id} is still waiting for a vendor match. You can ask for status, retry later, or change the method / currency.`,
        ["status", "change method", "change currency"],
        events
      );
    }

    if (/not_accepted_by_any_vendor|matching_timeout_reached|escrow_deployment_failed/i.test(message)) {
      session.status = "blocked";
      session.stage = "awaiting_no_match_resolution";
      events.push({
        type: "blocked_no_vendor_match",
        message,
        data: { tradeRequestId: tradeRequest.id },
      });
      return reply(
        withUpdate(session, deps),
        `Trade request #${tradeRequest.id} could not get a vendor match (${message}). You can retry, change the amount, or switch payment method / currency.`,
        ["retry", "change method", "change currency", "change amount"],
        events
      );
    }

    throw error;
  }
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
  const events: TransferFlowEvent[] = [];
  let consumedTurnForSelection = false;

  if (hints.cancel) {
    session.status = "cancelled";
    session.stage = "cancelled";
    return reply(withUpdate(session, deps), "Okay, I cancelled this transfer flow.");
  }

  const statusReply = await maybeHandleStatusRequest(session, hints, deps);
  if (statusReply) return statusReply;

  applyHintsToSession(session, stageAwareHints);
  applyMidFlowChanges(session, hints);

  if (!session.auth.checked) {
    const auth = deps.authState || detectAuthState();
    session.auth = {
      checked: true,
      available: auth.hasReplayableAuth,
      mode: auth.authMode,
      choice: session.auth.choice,
    };
  }

  if (session.goal === "transfer" && !session.auth.available) {
    session.status = "blocked";
    session.stage = "awaiting_auth_choice";
    if (hints.authChoice) {
      session.auth.choice = hints.authChoice;
      const followUp = hints.authChoice === "evm"
        ? "Please provide the exported EVM private key so onboarding can save it and verify login."
        : hints.authChoice === "ton"
          ? "Please provide the TON mnemonic and raw TON address so onboarding can verify TON login."
          : "Please provide the email address to use for OTP onboarding / recovery.";
      return reply(withUpdate(session, deps), followUp, undefined, [{
        type: "blocked_missing_auth",
        message: followUp,
      }]);
    }

    return reply(
      withUpdate(session, deps),
      getUnigoxWalletConnectionPrompt(),
      ["EVM wallet connection", "TON wallet connection", "email OTP"],
      [{
        type: "blocked_missing_auth",
        message: getUnigoxWalletConnectionPrompt(),
      }]
    );
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
    const store = loadContacts(deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
    const match = resolveContact(store, session.recipientQuery);
    if (match) {
      session.contactKey = match.key;
      session.recipientName = match.contact.name;
      session.aliases = match.contact.aliases || [];
      session.contactExists = true;
      session.recipientMode = "saved";
    } else if (session.recipientMode === "saved") {
      session.stage = "awaiting_recipient_name";
      return reply(withUpdate(session, deps), `I couldn't find a saved contact for '${session.recipientQuery}'. Who is the recipient?`);
    } else {
      session.recipientName = session.recipientQuery;
      session.aliases = [session.recipientQuery];
      session.contactExists = false;
      session.recipientMode = "new";
      session.contactSaveAction = "create";
    }
  }

  if (!session.currency) {
    session.stage = "awaiting_currency";
    const maybeCurrency = parseStandaloneCurrency(normalizedTurn.text);
    if (maybeCurrency) {
      setCurrency(session, maybeCurrency);
    } else {
      return reply(withUpdate(session, deps), "What currency should the recipient receive? If you don't specify, I can default to EUR.");
    }
  }

  if (session.contactExists && !session.payment) {
    const store = loadContacts(deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
    const match = session.contactKey ? { key: session.contactKey, contact: store.contacts[session.contactKey] } as ContactMatch : resolveContact(store, session.recipientName);
    const contact = match?.contact;
    if (contact?.paymentMethods?.[session.currency!]) {
      const validation = await validateStoredContactSelection(session, contact, deps);
      if (!validation.valid) {
        session.stage = "awaiting_payment_details";
        const fieldPrompt = await promptForNextField(session, deps);
        fieldPrompt.reply = `I found saved ${session.currency} details for ${session.recipientName}, but they look stale or incomplete. ${fieldPrompt.reply}`;
        return fieldPrompt;
      }
    }
  }

  if (!session.payment) {
    const getMethods = deps.getPaymentMethodsForCurrency || defaultGetPaymentMethodsForCurrency;
    const currencyData = await getMethods(session.currency!);
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
        return reply(
          withUpdate(session, deps),
          `${method.name} has multiple payout routes for ${session.currency}: ${method.networks.map((network) => network.name).join(", ")}. Which one should I use?`,
          method.networks.map((network) => network.name)
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
      const suggestions = currencyData.paymentMethods.slice(0, 6).map((method) => method.name);
      const ambiguity = selection.ambiguous?.length
        ? `I found multiple matches: ${selection.ambiguous.map((method) => method.name).join(", ")}.`
        : `Available examples for ${session.currency}: ${suggestions.join(", ")}.`;
      return reply(withUpdate(session, deps), `Which payout method should ${session.recipientName} receive in ${session.currency}? ${ambiguity}`);
    }
  }

  if (session.payment && !session.payment.networkId) {
    const getMethods = deps.getPaymentMethodsForCurrency || defaultGetPaymentMethodsForCurrency;
    const currencyData = await getMethods(session.currency!);
    const method = currencyData.paymentMethods.find((entry) => entry.id === session.payment?.methodId);
    if (!method) {
      resetPaymentSelection(session);
      return reply(withUpdate(session, deps), `I couldn't re-resolve that payment method for ${session.currency}. Let's pick it again.`);
    }
    const network = chooseNetwork(method.networks, normalizedTurn.option || normalizedTurn.text || "");
    if (!network) {
      session.stage = "awaiting_payment_network";
      return reply(
        withUpdate(session, deps),
        `${method.name} supports: ${method.networks.map((entry) => entry.name).join(", ")}. Which network should I use?`,
        method.networks.map((entry) => entry.name)
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
    return detailResult;
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
        return reply(withUpdate(session, deps), event?.message || `${session.recipientName} saved.`, undefined, events);
      }
    } else if (hints.saveContactDecision === "no") {
      session.saveContactDecision = "no";
      if (session.goal === "save_contact_only") {
        session.status = "completed";
        session.stage = "completed";
        return reply(withUpdate(session, deps), `Okay, I didn't save ${session.recipientName}.`, undefined, events);
      }
    } else {
      return reply(withUpdate(session, deps), buildSavePrompt(session));
    }
  }

  if (session.goal === "save_contact_only") {
    session.status = "completed";
    session.stage = "completed";
    return reply(withUpdate(session, deps), `${session.recipientName} is ready for later transfers.`, undefined, events);
  }

  if (!session.amount) {
    session.stage = "awaiting_amount";
    const parsed = parseAmountAndCurrency(normalizedTurn.text);
    if (parsed.amount) {
      session.amount = parsed.amount;
      if (parsed.currency && parsed.currency !== session.currency) {
        setCurrency(session, parsed.currency);
        return reply(withUpdate(session, deps), `You asked for ${parsed.currency}, so I reset the payout method selection. Which method should I use?`, undefined, events);
      }
    } else {
      return reply(withUpdate(session, deps), `How much ${session.currency} should I send to ${session.recipientName}?`, undefined, events);
    }
  }

  if (!session.execution.confirmed) {
    session.stage = "awaiting_confirmation";
    if (hints.confirm) {
      session.execution.confirmed = true;
    } else {
      return reply(withUpdate(session, deps), buildConfirmationMessage(session), undefined, events);
    }
  }

  return handleExecution(session, deps);
}
