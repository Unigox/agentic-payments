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
  DepositFlowSelection,
  NetworkFieldConfig,
  PaymentDetail,
  PaymentFieldValidationResult,
  PaymentMethodInfo,
  PaymentNetworkInfo,
  PreflightQuote,
  ResolvedPaymentMethodFieldConfig,
  SupportedDepositAssetOption,
  SupportedDepositChainOption,
  TradeRequest,
  UnigoxClientConfig,
  UserProfile,
  WalletBalance,
} from "./unigox-client.ts";
import {
  createInitialSettlementState,
  noteDeferredPlaceholder,
  noteReceiptNotReceived,
  parseReceiptDecision,
  pollSettlementSnapshot,
  refreshSettlementSnapshot,
} from "./settlement-monitor.ts";
import type {
  SettlementMonitorState,
  SettlementPhase,
  SettlementSnapshot,
  SettlementTrade,
} from "./settlement-monitor.ts";
import {
  DEFAULT_CONTACTS_FILE,
  SKILL_DIR,
  loadContacts,
  normalizeLookupValue,
  saveContacts,
  resolveContact,
  resolveContactQuery,
  upsertContactPaymentMethod,
} from "./contact-store.ts";
import type { ContactMatch, ContactRecord, StoredPaymentMethod } from "./contact-store.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SETTINGS_FILE = path.join(SKILL_DIR, "settings.json");

type AuthChoice = "evm" | "ton" | "email";
type SecretKind = "evm_login_key" | "evm_signing_key";
type TopUpMethod = "internal_username" | "external_deposit";

export type TransferGoal = "transfer" | "save_contact_only";
export type TransferStage =
  | "resolving"
  | "awaiting_auth_choice"
  | "awaiting_evm_wallet_signin"
  | "awaiting_evm_login_key"
  | "awaiting_evm_signing_key"
  | "awaiting_secret_cleanup_confirmation"
  | "awaiting_recipient_mode"
  | "awaiting_recipient_name"
  | "awaiting_currency"
  | "awaiting_payment_method"
  | "awaiting_payment_network"
  | "awaiting_payment_details"
  | "awaiting_save_contact_decision"
  | "awaiting_amount"
  | "awaiting_confirmation"
  | "awaiting_topup_method"
  | "awaiting_external_deposit_asset"
  | "awaiting_external_deposit_chain"
  | "awaiting_balance_resolution"
  | "awaiting_match_status"
  | "awaiting_no_match_resolution"
  | "awaiting_trade_settlement"
  | "awaiting_receipt_confirmation"
  | "awaiting_release_completion"
  | "awaiting_manual_settlement_followup"
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
    | "blocked_no_vendor_match"
    | "secret_message_deleted"
    | "secret_cleanup_required"
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

export interface TransferExecutionClient {
  getProfile?(): Promise<Pick<UserProfile, "username"> | UserProfile>;
  getWalletBalance(): Promise<WalletBalance>;
  ensurePaymentDetail(params: {
    paymentMethodId: number;
    paymentNetworkId: number;
    fiatCurrencyCode: string;
    details: Record<string, string>;
  }): Promise<PaymentDetail>;
  getPreflightQuote?(params: {
    tradeType: "BUY" | "SELL";
    cryptoCurrencyCode?: string;
    fiatAmount: number;
    paymentDetailsId: number;
    tradePartner?: "licensed" | "p2p" | "all";
  }): Promise<PreflightQuote | undefined>;
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
  getTrade?(tradeId: number): Promise<SettlementTrade | undefined>;
  confirmFiatReceived?(tradeId: number): Promise<SettlementTrade | undefined>;
  getSupportedDepositOptions?(): Promise<SupportedDepositAssetOption[]>;
  describeDepositSelection?(selection: DepositFlowSelection): Promise<SupportedDepositChainOption & { depositAddress: string }>;
}

export interface TransferFlowDeps {
  contactsFilePath?: string;
  settingsFilePath?: string;
  waitForMatchTimeoutMs?: number;
  waitForSettlementTimeoutMs?: number;
  settlementPollIntervalMs?: number;
  receiptReminderMs?: number;
  receiptTimeoutMs?: number;
  now?: () => Date;
  authState?: AuthState;
  client?: TransferExecutionClient;
  clientFactory?: () => Promise<TransferExecutionClient>;
  clientConfig?: UnigoxClientConfig;
  verifyEvmLoginKey?: (loginKey: string) => Promise<{ success?: boolean; ok?: boolean; message?: string; username?: string } | void>;
  persistEvmLoginKey?: (loginKey: string) => Promise<void> | void;
  persistEvmSigningKey?: (signingKey: string) => Promise<void> | void;
  handleSensitiveInput?: (params: {
    kind: SecretKind;
    secret: string;
    turn: TransferTurn;
    session: TransferSession;
  }) => Promise<{ deleted?: boolean; note?: string } | void> | { deleted?: boolean; note?: string } | void;
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
  evmSigningKeyAvailable?: boolean;
  username?: string;
}

interface ResolvedAuthState extends AuthState {
  balanceUsd?: number;
}

export interface SecretSubmissionState {
  kind: SecretKind;
  value: string;
  note?: string;
}

export interface ExecutionPreflightState {
  balanceUsd: number;
  amount: number;
  currency: string;
  checkedAt: string;
  paymentDetailsId?: number;
  quote?: PreflightQuote;
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

export interface TopUpState {
  method?: TopUpMethod;
  assetCode?: SupportedDepositAssetOption["assetCode"];
  chainId?: number;
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
  topUp?: TopUpState;
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
    evmSigningKeyAvailable?: boolean;
    username?: string;
    balanceUsd?: number;
    startupSnapshotShown?: boolean;
    pendingSecret?: SecretSubmissionState;
  };
  execution: {
    confirmed: boolean;
    preflight?: ExecutionPreflightState;
    paymentDetailsId?: number;
    tradeRequestId?: number;
    tradeId?: number;
    tradeRequestStatus?: string;
    tradeStatus?: string;
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
const SIGNIN_READY_RE = /^(yes|y|done|ready|already signed in|already logged in|signed in|logged in|i signed in|i have signed in|i already signed in|i logged in|i have logged in)$/i;
const NOT_READY_RE = /^(no|n|not yet|haven'?t|have not|didn'?t|did not)$/i;
const DELETED_RE = /^(deleted|i deleted it|deleted it|it'?s deleted|removed it|done deleting)$/i;

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

function parseSavedContactRecipient(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  const match = value.match(/\b(?:saved contact|existing contact|someone saved)\s+(?:named\s+)?([a-z0-9][a-z0-9 .,'@_-]{1,60})$/i);
  const candidate = match?.[1]?.trim().replace(/[!?.,]+$/g, "");
  if (!candidate) return undefined;
  if (/\b(currency|amount|method|wallet|status)\b/i.test(candidate)) return undefined;
  return candidate;
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
  if (/saved contact|existing contact|someone saved/.test(lower)) {
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
  if (/^(evm|evm wallet|evm wallet connection|wallet connection evm)$/i.test(value)) {
    hints.authChoice = "evm";
  } else if (/^(ton|ton wallet|ton wallet connection|wallet connection ton)$/i.test(value)) {
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
      startupSnapshotShown: false,
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
  const formattedUsername = formatUsername(session.auth.username);
  if (formattedUsername) {
    parts.push(`You're currently signed in as ${formattedUsername} on UNIGOX.`);
  }
  if (typeof session.auth.balanceUsd === "number") {
    parts.push(`Current wallet balance: ${session.auth.balanceUsd.toFixed(2)} USD.`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

function decorateStartupReply(session: TransferSession, message: string): string {
  if (session.goal !== "transfer" || !session.auth.available || session.auth.startupSnapshotShown) return message;

  const snapshot = buildStartupAuthSnapshot(session);
  if (!snapshot) return message;

  const snapshotParts: string[] = [];
  if (!/signed in as/i.test(message)) {
    const formattedUsername = formatUsername(session.auth.username);
    if (formattedUsername) {
      snapshotParts.push(`You're currently signed in as ${formattedUsername} on UNIGOX.`);
    }
  }
  if (!/Current wallet balance:/i.test(message) && typeof session.auth.balanceUsd === "number") {
    snapshotParts.push(`Current wallet balance: ${session.auth.balanceUsd.toFixed(2)} USD.`);
  }

  session.auth.startupSnapshotShown = true;
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

function getEnvCandidates(): string[] {
  if (process.env.SEND_MONEY_DISABLE_ENV_FILE_LOOKUP === "1") {
    return [];
  }
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
  const evmLoginPrivateKey = loadEnvValue("UNIGOX_EVM_LOGIN_PRIVATE_KEY");
  const evmSigningPrivateKey = loadEnvValue("UNIGOX_EVM_SIGNING_PRIVATE_KEY") || loadEnvValue("UNIGOX_PRIVATE_KEY");
  const tonMnemonic = loadEnvValue("UNIGOX_TON_MNEMONIC");
  const email = loadEnvValue("UNIGOX_EMAIL");

  if (evmLoginPrivateKey) {
    return {
      hasReplayableAuth: true,
      authMode: "evm",
      emailFallbackAvailable: !!email,
      evmSigningKeyAvailable: !!evmSigningPrivateKey,
    };
  }
  if (tonMnemonic) {
    return {
      hasReplayableAuth: true,
      authMode: "ton",
      emailFallbackAvailable: !!email,
      evmSigningKeyAvailable: !!evmSigningPrivateKey,
    };
  }
  if (evmSigningPrivateKey) {
    return {
      hasReplayableAuth: true,
      authMode: "evm",
      emailFallbackAvailable: !!email,
      evmSigningKeyAvailable: true,
    };
  }
  return {
    hasReplayableAuth: false,
    authMode: email ? "email" : undefined,
    emailFallbackAvailable: !!email,
    evmSigningKeyAvailable: false,
  };
}

function resolveInitialAuthState(authState?: AuthState): ResolvedAuthState {
  const detected = detectAuthState();
  if (!authState) return detected;

  return {
    hasReplayableAuth: authState.hasReplayableAuth || detected.hasReplayableAuth,
    authMode: authState.authMode || detected.authMode,
    emailFallbackAvailable: authState.emailFallbackAvailable || detected.emailFallbackAvailable,
    evmSigningKeyAvailable: authState.evmSigningKeyAvailable === true || detected.evmSigningKeyAvailable === true,
    username: authState.username || detected.username,
  };
}

export function loadUnigoxConfigFromEnv(): UnigoxClientConfig {
  const evmLoginPrivateKey = loadEnvValue("UNIGOX_EVM_LOGIN_PRIVATE_KEY");
  const evmSigningPrivateKey = loadEnvValue("UNIGOX_EVM_SIGNING_PRIVATE_KEY") || loadEnvValue("UNIGOX_PRIVATE_KEY");
  const tonMnemonic = loadEnvValue("UNIGOX_TON_MNEMONIC");
  const email = loadEnvValue("UNIGOX_EMAIL");

  if (evmLoginPrivateKey) {
    return {
      authMode: "evm",
      evmLoginPrivateKey,
      ...(evmSigningPrivateKey && { evmSigningPrivateKey }),
      ...(email && { email }),
    };
  }

  if (tonMnemonic) {
    return {
      authMode: loadEnvValue("UNIGOX_AUTH_MODE") === "ton" ? "ton" : "auto",
      tonMnemonic,
      tonAddress: loadEnvValue("UNIGOX_TON_ADDRESS"),
      tonNetwork: loadEnvValue("UNIGOX_TON_NETWORK") || "-239",
      ...(email && { email }),
      ...(evmSigningPrivateKey && { evmSigningPrivateKey }),
    };
  }

  if (email) {
    return {
      email,
      authMode: "email",
      ...(evmSigningPrivateKey && { evmSigningPrivateKey }),
    };
  }

  if (evmSigningPrivateKey) {
    return { privateKey: evmSigningPrivateKey, authMode: "evm" };
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

async function verifyEvmLoginKeyInput(loginKey: string, deps: TransferFlowDeps): Promise<{ success: boolean; message?: string; username?: string }> {
  if (deps.verifyEvmLoginKey) {
    const result = await deps.verifyEvmLoginKey(loginKey);
    if (!result) return { success: true };
    return {
      success: result.success ?? result.ok ?? true,
      message: result.message,
      username: result.username,
    };
  }

  let email: string | undefined;
  let frontendUrl: string | undefined;
  if (deps.clientConfig) {
    email = deps.clientConfig.email;
    frontendUrl = deps.clientConfig.frontendUrl;
  } else {
    try {
      const config = loadUnigoxConfigFromEnv();
      email = config.email;
      frontendUrl = config.frontendUrl;
    } catch {
      // No stored config available yet; login verification can still proceed with the provided key alone.
    }
  }

  try {
    const client = new UnigoxClient({
      authMode: "evm",
      evmLoginPrivateKey: loginKey,
      ...(email ? { email } : {}),
      ...(frontendUrl ? { frontendUrl } : {}),
    });
    await client.login();

    let username: string | undefined;
    try {
      username = (await client.getProfile())?.username;
    } catch {
      // Username is helpful but optional for a successful verification.
    }

    return { success: true, username };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function clearExecutionPreflight(session: TransferSession): void {
  session.execution.preflight = undefined;
}

function formatUsername(username: string | undefined): string | undefined {
  if (!username) return undefined;
  return username.startsWith("@") ? username : `@${username}`;
}

function buildUsernameReminder(username: string | undefined): string | undefined {
  const formatted = formatUsername(username);
  if (!formatted) return undefined;
  return `You're currently signed in as ${formatted} on UNIGOX. You can change that username later in this agent flow or on unigox.com.`;
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
  return preflight.quote?.totalCryptoAmount ?? preflight.amount;
}

function getTopUpShortfallUsd(preflight: ExecutionPreflightState | undefined): number | undefined {
  const required = getRequiredBalanceUsd(preflight);
  if (required === undefined) return undefined;
  return Math.max(required - preflight!.balanceUsd, 0);
}

function buildTopUpShortfallLine(preflight: ExecutionPreflightState | undefined): string | undefined {
  const shortfall = getTopUpShortfallUsd(preflight);
  if (shortfall === undefined || shortfall <= 0) return undefined;
  return `You need about ${formatFixed(shortfall, 2)} USD more in the wallet before I can place the trade.`;
}

function chooseTopUpMethod(text: string | undefined): TopUpMethod | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  if (/(another\s+unigox\s+(?:user|wallet)|internal(?:\s+unigox)?|my username|send to (?:my )?username|username transfer)/i.test(value)) {
    return "internal_username";
  }
  if (/(external|on-?chain|deposit address|wallet address|crypto deposit|from another wallet|token and chain|network deposit)/i.test(value)) {
    return "external_deposit";
  }
  return undefined;
}

function buildTopUpMethodPrompt(username: string | undefined): string {
  const formatted = formatUsername(username);
  return [
    "How would you like to top up the wallet?",
    formatted ? `1) Another UNIGOX user sends funds directly to your username ${formatted}.` : "1) Another UNIGOX user sends funds directly to your UNIGOX username.",
    "2) External / on-chain deposit to your wallet address.",
    "You can also change the transfer amount instead.",
  ].join(" ");
}

function buildInternalTopUpInstructions(username: string | undefined, preflight?: ExecutionPreflightState): string {
  const formatted = formatUsername(username);
  const shortfall = getTopUpShortfallUsd(preflight);
  return [
    buildPreflightQuoteSummary(preflight),
    buildTopUpShortfallLine(preflight),
    buildPreflightQuoteCaveat(preflight),
    formatted
      ? `Your current UNIGOX username is ${formatted}.`
      : "I couldn't hydrate your UNIGOX username just yet, so this internal route is only useful once that username is visible.",
    formatted
      ? shortfall && shortfall > 0
        ? `Ask the other UNIGOX user to send about ${formatFixed(shortfall, 2)} USD more directly to ${formatted} inside UNIGOX.`
        : `Ask the other UNIGOX user to send the required funds directly to ${formatted} inside UNIGOX.`
      : "If you want, switch to external / on-chain deposit instead and I'll guide that route step by step.",
    formatted ? "This internal UNIGOX route does not need a token + chain deposit flow first." : undefined,
    "When the funds arrive, tell me to recheck the balance.",
  ].filter(Boolean).join(" ");
}

function buildExternalDepositAssetPrompt(options: SupportedDepositAssetOption[]): string {
  const assets = options.map((entry) => entry.assetCode).join(", ");
  return `For an external / on-chain deposit, which token do you want to deposit? Available options here: ${assets}.`;
}

function buildExternalDepositChainPrompt(option: SupportedDepositAssetOption): string {
  const chains = option.chains.map((entry) => entry.chainName).join(", ");
  return `Which network should I use for ${option.assetCode}? Supported ${option.assetCode} deposit networks here: ${chains}.`;
}

function buildExternalDepositInstructions(selection: SupportedDepositChainOption & { depositAddress: string }): string {
  return [
    `Send ${selection.assetCode} on ${selection.chainName} to this deposit address: ${selection.depositAddress}`,
    "This is the single relevant address for that token + network choice.",
    "Once the transfer lands, tell me to recheck the balance.",
  ].join(" ");
}

function chooseDepositAssetOption(options: SupportedDepositAssetOption[], text: string | undefined): SupportedDepositAssetOption | undefined {
  const query = normalizeMatchValue(text);
  if (!query) return undefined;
  return options.find((option) => {
    const candidates = [option.assetCode, ...option.tokenCodes];
    return candidates.some((candidate) => {
      const normalized = normalizeMatchValue(candidate);
      return normalized === query || normalized.includes(query) || query.includes(normalized);
    });
  });
}

function chooseDepositChainOption(chains: SupportedDepositChainOption[], text: string | undefined): SupportedDepositChainOption | undefined {
  const query = normalizeMatchValue(text);
  if (!query) return undefined;
  return chains.find((chain) => {
    const candidates = [chain.chainName, chain.chainType, `${chain.assetCode} ${chain.chainName}`, `${chain.tokenCode} ${chain.chainName}`];
    return candidates.some((candidate) => {
      const normalized = normalizeMatchValue(candidate);
      return normalized === query || normalized.includes(query) || query.includes(normalized);
    });
  });
}

function wantsBalanceRecheck(text: string | undefined): boolean {
  return /^(recheck|check|refresh|retry|continue|done|funded|topped up|balance updated|try again)(?:\s+balance)?$/i.test(cleanText(text));
}

function buildEvmKeySecurityWarning(kind: SecretKind): string {
  const keyLabel = kind === "evm_login_key"
    ? "login wallet key"
    : "UNIGOX-exported signing key";
  return [
    "🚨🔐 IMPORTANT WALLET SAFETY WARNING 🔐🚨",
    `Use a NEWLY CREATED / ISOLATED wallet for this ${keyLabel}.`,
    "❌ This must NOT be your main wallet.",
    "❌ Do NOT paste a wallet that holds long-term funds.",
    "✅ Use a dedicated UNIGOX / agent wallet only.",
  ].join(" ");
}

function buildEvmLoginKeyPrompt(): string {
  return [
    buildEvmKeySecurityWarning("evm_login_key"),
    "Great. Which wallet key did you use to sign in on UNIGOX? Paste the login wallet private key and I’ll verify login with that key first.",
  ].join(" ");
}

function buildEvmSigningKeyPrompt(username: string | undefined): string {
  return [
    buildUsernameReminder(username),
    buildEvmKeySecurityWarning("evm_signing_key"),
    "Login works. One more step: please export the separate UNIGOX EVM signing key from your account settings on unigox.com and paste it here.",
    "I’ll store it locally on this machine so I can handle signed actions like receipt confirmation / escrow release.",
    "If the export option is not enabled on your account yet, contact UNIGOX support / hello@unigox.com first.",
  ].filter(Boolean).join(" ");
}

function buildMissingSigningKeyPrompt(username: string | undefined): string {
  return [
    buildUsernameReminder(username),
    buildEvmKeySecurityWarning("evm_signing_key"),
    "Login is set up, but I still need the separate UNIGOX-exported EVM signing key from unigox.com settings before I can finish signed actions like receipt confirmation / escrow release.",
    "Save it as UNIGOX_EVM_SIGNING_PRIVATE_KEY (UNIGOX_PRIVATE_KEY still works as a legacy alias).",
  ].filter(Boolean).join(" ");
}

function buildSecretCleanupPrompt(secret: SecretSubmissionState): string {
  const label = secret.kind === "evm_login_key"
    ? "login wallet key"
    : "UNIGOX-exported signing key";
  return [
    secret.note,
    `⚠️ For safety, please delete the message that contains your ${label} from this chat right now.`,
    "If this channel/runtime cannot delete your message automatically, I need you to delete it yourself before I continue.",
    "Reply 'deleted' once that message is gone.",
  ].filter(Boolean).join(" ");
}

async function maybeHydrateAuthIdentity(
  session: TransferSession,
  deps: TransferFlowDeps,
  client?: TransferExecutionClient
): Promise<void> {
  if (!session.auth.available || session.auth.username) return;
  const executionClient = client || await getExecutionClient(deps);
  if (!executionClient.getProfile) return;
  try {
    const profile = await executionClient.getProfile();
    if (profile?.username) {
      session.auth.username = profile.username;
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
    executionClient = client || await getExecutionClient(deps);
  } catch {
    return;
  }

  await maybeHydrateAuthIdentity(session, deps, executionClient);

  if (typeof session.auth.balanceUsd === "number") return;
  try {
    const balance = await executionClient.getWalletBalance();
    session.auth.balanceUsd = balance.totalUsd;
  } catch {
    // Early balance surfacing improves UX but should not block the flow.
  }
}

async function maybeHandleSensitiveInput(
  session: TransferSession,
  kind: SecretKind,
  secret: string,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<{ needsManualCleanup: boolean; note?: string; deleted?: boolean }> {
  const result = await deps.handleSensitiveInput?.({ kind, secret, turn, session });
  if (result?.deleted) {
    return { needsManualCleanup: false, deleted: true, note: result.note || "✅ I deleted that key-containing message from the chat before continuing." };
  }

  session.auth.pendingSecret = {
    kind,
    value: secret,
    note: result?.note,
  };
  session.stage = "awaiting_secret_cleanup_confirmation";
  session.status = "blocked";
  return {
    needsManualCleanup: true,
    note: result?.note,
  };
}

async function finalizeEvmLoginKey(
  session: TransferSession,
  loginKey: string,
  deps: TransferFlowDeps,
  prefixEvents: TransferFlowEvent[] = []
): Promise<TransferFlowResult> {
  session.auth.pendingSecret = undefined;
  const verification = await verifyEvmLoginKeyInput(loginKey, deps);
  if (!verification.success) {
    session.stage = "awaiting_evm_login_key";
    const failure = `That login wallet key didn't work. Please double-check the wallet that is actually linked to UNIGOX sign-in and try again.${verification.message ? ` (${verification.message})` : ""}`;
    return reply(withUpdate(session, deps), failure, undefined, [...prefixEvents, {
      type: "blocked_missing_auth",
      message: failure,
    }]);
  }

  await deps.persistEvmLoginKey?.(loginKey);
  session.auth.available = true;
  session.auth.mode = "evm";
  session.auth.choice = "evm";
  session.auth.evmSigningKeyAvailable = false;
  session.auth.username = verification.username || session.auth.username;
  if (!session.auth.username) {
    await maybeHydrateAuthIdentity(session, deps);
  }
  session.stage = "awaiting_evm_signing_key";
  const followUp = buildEvmSigningKeyPrompt(session.auth.username);
  return reply(withUpdate(session, deps), followUp, undefined, [...prefixEvents, {
    type: "blocked_missing_auth",
    message: followUp,
  }]);
}

async function finalizeEvmSigningKey(
  session: TransferSession,
  signingKey: string,
  deps: TransferFlowDeps,
  prefixEvents: TransferFlowEvent[] = []
): Promise<TransferFlowResult> {
  session.auth.pendingSecret = undefined;
  await deps.persistEvmSigningKey?.(signingKey);
  session.auth.available = true;
  session.auth.mode = "evm";
  session.auth.choice = "evm";
  session.auth.evmSigningKeyAvailable = true;
  session.status = "active";
  session.stage = "resolving";
  const resumed = await advanceTransferFlow(session, { text: "" }, deps);
  if (prefixEvents.length) {
    resumed.events = [...prefixEvents, ...resumed.events];
  }
  return resumed;
}

async function maybeHandleAuthOnboardingTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (session.goal !== "transfer") return undefined;

  const responseText = cleanText(turn.option || turn.text);
  const hintedChoice = parseIntentHints(responseText).authChoice;

  if (session.stage === "awaiting_secret_cleanup_confirmation") {
    session.status = "blocked";
    const pendingSecret = session.auth.pendingSecret;
    if (!pendingSecret) {
      session.stage = "awaiting_auth_choice";
      return reply(withUpdate(session, deps), getUnigoxWalletConnectionPrompt(), ["EVM wallet connection", "TON wallet connection", "email OTP"], [{
        type: "blocked_missing_auth",
        message: getUnigoxWalletConnectionPrompt(),
      }]);
    }

    if (!DELETED_RE.test(responseText)) {
      return reply(withUpdate(session, deps), buildSecretCleanupPrompt(pendingSecret), ["deleted"], [{
        type: "secret_cleanup_required",
        message: buildSecretCleanupPrompt(pendingSecret),
      }]);
    }

    if (pendingSecret.kind === "evm_login_key") {
      return finalizeEvmLoginKey(session, pendingSecret.value, deps);
    }
    return finalizeEvmSigningKey(session, pendingSecret.value, deps);
  }

  if (session.stage === "awaiting_evm_wallet_signin") {
    session.status = "blocked";

    if (hintedChoice === "ton" || hintedChoice === "email") {
      session.stage = "awaiting_auth_choice";
      session.auth.choice = hintedChoice;
      const followUp = hintedChoice === "ton"
        ? "Please provide the TON mnemonic and raw TON address so onboarding can verify TON login."
        : "Please provide the email address to use for OTP onboarding / recovery.";
      return reply(withUpdate(session, deps), followUp, undefined, [{
        type: "blocked_missing_auth",
        message: followUp,
      }]);
    }

    if (SIGNIN_READY_RE.test(responseText) || /signed in|logged in/i.test(responseText)) {
      session.stage = "awaiting_evm_login_key";
      const followUp = buildEvmLoginKeyPrompt();
      return reply(withUpdate(session, deps), followUp, undefined, [{
        type: "blocked_missing_auth",
        message: followUp,
      }]);
    }

    const reminder = NOT_READY_RE.test(responseText) || !responseText
      ? "Before I ask for any key: please sign in on unigox.com with the EVM wallet you want me to reuse. Once that is done, tell me you’ve already signed in and I’ll ask which login wallet key you used."
      : "I still need you to sign in on unigox.com with that EVM wallet first. Once that is done, tell me you’ve already signed in and I’ll ask which login wallet key you used.";
    return reply(withUpdate(session, deps), reminder, ["I signed in", "TON wallet connection", "email OTP"], [{
      type: "blocked_missing_auth",
      message: reminder,
    }]);
  }

  if (session.stage === "awaiting_evm_login_key") {
    session.status = "blocked";
    if (!responseText || SIGNIN_READY_RE.test(responseText) || NOT_READY_RE.test(responseText)) {
      const prompt = buildEvmLoginKeyPrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const secretHandling = await maybeHandleSensitiveInput(session, "evm_login_key", responseText, turn, deps);
    if (secretHandling.needsManualCleanup) {
      const prompt = buildSecretCleanupPrompt(session.auth.pendingSecret!);
      return reply(withUpdate(session, deps), prompt, ["deleted"], [{
        type: "secret_cleanup_required",
        message: prompt,
      }]);
    }

    const events = secretHandling.deleted
      ? [{ type: "secret_message_deleted", message: secretHandling.note || "Deleted the login-key message from chat." } as TransferFlowEvent]
      : [];
    return finalizeEvmLoginKey(session, responseText, deps, events);
  }

  if (session.stage === "awaiting_evm_signing_key" && session.auth.mode === "evm" && !session.auth.evmSigningKeyAvailable) {
    session.status = "blocked";
    if (!responseText || SIGNIN_READY_RE.test(responseText) || NOT_READY_RE.test(responseText)) {
      const prompt = buildMissingSigningKeyPrompt(session.auth.username);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const secretHandling = await maybeHandleSensitiveInput(session, "evm_signing_key", responseText, turn, deps);
    if (secretHandling.needsManualCleanup) {
      const prompt = buildSecretCleanupPrompt(session.auth.pendingSecret!);
      return reply(withUpdate(session, deps), prompt, ["deleted"], [{
        type: "secret_cleanup_required",
        message: prompt,
      }]);
    }

    const events = secretHandling.deleted
      ? [{ type: "secret_message_deleted", message: secretHandling.note || "Deleted the signing-key message from chat." } as TransferFlowEvent]
      : [];
    return finalizeEvmSigningKey(session, responseText, deps, events);
  }

  return undefined;
}

function resetPaymentSelection(session: TransferSession): void {
  session.payment = undefined;
  session.details = {};
  session.detailCollection = { index: 0 };
  session.saveContactDecision = undefined;
  session.contactSaveAction = session.contactExists ? "update" : "create";
  session.execution.confirmed = false;
  clearExecutionPreflight(session);
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
  const balanceLine = typeof session.execution.preflight?.balanceUsd === "number"
    ? `Current wallet balance: ${session.execution.preflight.balanceUsd.toFixed(2)} USD.`
    : undefined;
  return [
    buildUsernameReminder(session.auth.username),
    balanceLine,
    buildPreflightQuoteSummary(session.execution.preflight),
    buildPreflightQuoteCaveat(session.execution.preflight),
    `Send ${session.amount} ${session.currency} to ${session.recipientName} via ${summarizePayment(session)}?`,
    `Details: ${maskDetailMap(session.details)}`,
    "Reply 'confirm' to place the trade, or tell me what to change.",
  ].filter(Boolean).join(" ");
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

function buildSavedContactDisambiguation(query: string, matches: ContactMatch[]): string {
  return `I found multiple saved contacts matching '${query}': ${matches.map((match) => match.contact.name).join(", ")}. Which one do you mean?`;
}

function isBankLikeMethod(method: PaymentMethodInfo): boolean {
  const haystack = [method.name, method.type, method.slug, method.typeSlug].join(" ").toLowerCase();
  return /bank|iban|sepa|wise|revolut/.test(haystack);
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

function currentFieldPrompt(field: NetworkFieldConfig): string {
  const optional = field.required ? "" : " Optional — you can say 'skip'.";
  if (field.field === "bank_name") {
    return `Which bank should receive this payout? Please provide the bank name.${optional}`.trim();
  }
  if (field.field === "iban") {
    return `Please provide the recipient's IBAN / bank account for this payout.${optional}`.trim();
  }
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

function settlementMonitorOptions(deps: TransferFlowDeps) {
  return {
    now: deps.now,
    pollIntervalMs: deps.settlementPollIntervalMs,
    timeoutMs: deps.waitForSettlementTimeoutMs,
    receiptReminderMs: deps.receiptReminderMs,
    receiptTimeoutMs: deps.receiptTimeoutMs,
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
  mode: "refresh" | "poll" = "refresh"
): Promise<SettlementSnapshot | undefined> {
  const state = ensureSettlementState(session);
  if (!state) return undefined;
  const client = await getExecutionClient(deps);
  const snapshot = mode === "poll"
    ? await pollSettlementSnapshot(state, client, settlementMonitorOptions(deps))
    : await refreshSettlementSnapshot(state, client, settlementMonitorOptions(deps));
  applySettlementSnapshotToSession(session, snapshot);
  return snapshot;
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

async function maybeHandleTopUpTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (![
    "awaiting_topup_method",
    "awaiting_external_deposit_asset",
    "awaiting_external_deposit_chain",
    "awaiting_balance_resolution",
  ].includes(session.stage)) {
    return undefined;
  }

  const hints = parseIntentHints(turn.text);
  if (hints.changeAmount || hints.changeCurrency) {
    return undefined;
  }

  const selectionText = turn.option || turn.text;

  if (session.stage === "awaiting_balance_resolution") {
    if (wantsBalanceRecheck(selectionText)) {
      const client = await getExecutionClient(deps);
      clearExecutionPreflight(session);
      const preflight = await ensureExecutionPreflight(session, deps, client);
      if (preflight.blockedResult) {
        return preflight.blockedResult;
      }
      session.status = "active";
      session.topUp = undefined;
      session.stage = "awaiting_confirmation";
      return reply(withUpdate(session, deps), buildConfirmationMessage(session), undefined, preflight.events);
    }

    const methodChoice = chooseTopUpMethod(selectionText);
    if (methodChoice || /\b(top up|fund wallet|deposit)\b/i.test(cleanText(selectionText))) {
      session.stage = "awaiting_topup_method";
      return maybeHandleTopUpTurn(session, turn, deps);
    }

    return undefined;
  }

  const methodChoice = chooseTopUpMethod(selectionText);

  if (session.stage === "awaiting_topup_method") {
    if (!methodChoice) {
      return reply(
        withUpdate(session, deps),
        buildTopUpMethodPrompt(session.auth.username),
        ["another UNIGOX user sends to my username", "external / on-chain deposit", "change amount"]
      );
    }

    if (methodChoice === "internal_username") {
      const client = await getExecutionClient(deps);
      await maybeHydrateAuthIdentity(session, deps, client);
      session.status = "blocked";
      session.topUp = { method: methodChoice };
      session.stage = "awaiting_balance_resolution";
      return reply(
        withUpdate(session, deps),
        buildInternalTopUpInstructions(session.auth.username, session.execution.preflight),
        ["recheck balance", "external / on-chain deposit", "change amount"]
      );
    }

    const client = await getExecutionClient(deps);
    if (!client.getSupportedDepositOptions) {
      throw new Error("This UNIGOX client cannot load supported deposit options for external top-ups.");
    }
    const options = await client.getSupportedDepositOptions();
    session.status = "blocked";
    session.topUp = { method: methodChoice };
    session.stage = "awaiting_external_deposit_asset";
    return reply(withUpdate(session, deps), buildExternalDepositAssetPrompt(options), options.map((option) => option.assetCode));
  }

  const client = await getExecutionClient(deps);
  if (!client.getSupportedDepositOptions) {
    throw new Error("This UNIGOX client cannot load supported deposit options for external top-ups.");
  }
  const options = await client.getSupportedDepositOptions();

  if (session.stage === "awaiting_external_deposit_asset") {
    const asset = chooseDepositAssetOption(options, selectionText);
    if (!asset) {
      return reply(withUpdate(session, deps), buildExternalDepositAssetPrompt(options), options.map((option) => option.assetCode));
    }
    session.topUp = {
      ...session.topUp,
      method: "external_deposit",
      assetCode: asset.assetCode,
      chainId: undefined,
    };
    session.stage = "awaiting_external_deposit_chain";
    return reply(withUpdate(session, deps), buildExternalDepositChainPrompt(asset), asset.chains.map((chain) => chain.chainName));
  }

  if (session.stage === "awaiting_external_deposit_chain") {
    const asset = options.find((option) => option.assetCode === session.topUp?.assetCode);
    if (!asset) {
      session.stage = "awaiting_external_deposit_asset";
      return reply(withUpdate(session, deps), buildExternalDepositAssetPrompt(options), options.map((option) => option.assetCode));
    }
    const chain = chooseDepositChainOption(asset.chains, selectionText);
    if (!chain) {
      return reply(withUpdate(session, deps), buildExternalDepositChainPrompt(asset), asset.chains.map((entry) => entry.chainName));
    }
    if (!client.describeDepositSelection) {
      throw new Error("This UNIGOX client cannot resolve a single deposit address for the chosen external top-up route.");
    }
    const resolved = await client.describeDepositSelection({ assetCode: asset.assetCode, chainId: chain.chainId });
    session.status = "blocked";
    session.topUp = {
      ...session.topUp,
      method: "external_deposit",
      assetCode: asset.assetCode,
      chainId: chain.chainId,
    };
    session.stage = "awaiting_balance_resolution";
    return reply(
      withUpdate(session, deps),
      buildExternalDepositInstructions(resolved),
      ["recheck balance", "another UNIGOX user sends to my username", "change amount"]
    );
  }

  return undefined;
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

    const client = await getExecutionClient(deps);
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

async function maybeHandleStatusRequest(session: TransferSession, hints: ParsedHints, deps: TransferFlowDeps): Promise<TransferFlowResult | undefined> {
  if (!hints.checkStatus || !session.execution.tradeRequestId) return undefined;

  const snapshot = await refreshSettlementForSession(session, deps, "refresh");
  if (snapshot) {
    const events = snapshot.events.map(mapSettlementEvent);
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
    clearExecutionPreflight(session);
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

  let paymentDetailsId: number | undefined;
  let quote: PreflightQuote | undefined;
  const paymentDetail = await client.ensurePaymentDetail({
    paymentMethodId: session.payment!.methodId,
    paymentNetworkId: session.payment!.networkId,
    fiatCurrencyCode: session.currency!,
    details: session.details,
  });
  paymentDetailsId = paymentDetail.id;
  session.execution.paymentDetailsId = paymentDetail.id;
  events.push({
    type: "payment_detail_ensured",
    message: `Ensured payment detail #${paymentDetail.id}.`,
    data: { paymentDetailId: paymentDetail.id },
  });

  try {
    quote = await client.getPreflightQuote?.({
      tradeType: "SELL",
      cryptoCurrencyCode: "USDC",
      fiatAmount: amount,
      paymentDetailsId: paymentDetail.id,
      tradePartner: settings.tradePartner,
    });
  } catch {
    // Quote is a UX improvement but should not block the flow if the preview endpoint is unavailable.
  }

  session.execution.preflight = {
    balanceUsd: balance.totalUsd,
    amount,
    currency: session.currency || "",
    checkedAt: nowIso(deps),
    paymentDetailsId,
    quote,
  };

  const requiredBalanceUsd = getRequiredBalanceUsd(session.execution.preflight) ?? amount;
  events.push({
    type: "balance_checked",
    message: [
      `Current wallet balance: ${balance.totalUsd.toFixed(2)} USD.`,
      buildPreflightQuoteSummary(session.execution.preflight),
      buildTopUpShortfallLine(session.execution.preflight),
      buildPreflightQuoteCaveat(session.execution.preflight),
    ].filter(Boolean).join(" "),
    data: {
      balance: balance.totalUsd,
      amount,
      currency: session.currency,
      paymentDetailsId,
      requiredBalanceUsd,
      quoteType: quote?.quoteType,
      vendorOfferRate: quote?.vendorOfferRate,
      totalCryptoAmount: quote?.totalCryptoAmount,
    },
  });

  if (balance.totalUsd < requiredBalanceUsd) {
    session.status = "blocked";
    session.topUp = undefined;
    session.stage = "awaiting_topup_method";
    const message = [
      buildUsernameReminder(session.auth.username),
      `Current wallet balance: ${balance.totalUsd.toFixed(2)} USD.`,
      buildPreflightQuoteSummary(session.execution.preflight),
      buildTopUpShortfallLine(session.execution.preflight),
      quote
        ? "Until the wallet covers that current estimate, I will not place the trade."
        : `That is below the requested ${amount} ${session.currency}, so I will not place the trade.`,
      buildPreflightQuoteCaveat(session.execution.preflight),
      buildTopUpMethodPrompt(session.auth.username),
    ].filter(Boolean).join(" ");
    events.push({
      type: "blocked_insufficient_balance",
      message,
      data: { balance: balance.totalUsd, amount, requiredBalanceUsd, paymentDetailsId },
    });
    return {
      events,
      blockedResult: reply(
        withUpdate(session, deps),
        message,
        ["another UNIGOX user sends to my username", "external / on-chain deposit", "change amount"],
        events
      ),
    };
  }

  return { events };
}

async function handleExecution(session: TransferSession, deps: TransferFlowDeps): Promise<TransferFlowResult> {
  const events: TransferFlowEvent[] = [];
  const client = await getExecutionClient(deps);
  const settings = loadSendMoneySettings(deps.settingsFilePath || DEFAULT_SETTINGS_FILE);
  const amount = session.amount || 0;

  const preflight = await ensureExecutionPreflight(session, deps, client);
  events.push(...preflight.events);
  if (preflight.blockedResult) {
    preflight.blockedResult.events = [...events.filter((event) => !preflight.blockedResult!.events.includes(event)), ...preflight.blockedResult.events];
    return preflight.blockedResult;
  }

  let paymentDetailsId = session.execution.preflight?.paymentDetailsId;
  if (!paymentDetailsId) {
    const paymentDetail = await client.ensurePaymentDetail({
      paymentMethodId: session.payment!.methodId,
      paymentNetworkId: session.payment!.networkId,
      fiatCurrencyCode: session.currency!,
      details: session.details,
    });
    paymentDetailsId = paymentDetail.id;
    session.execution.paymentDetailsId = paymentDetail.id;
    events.push({
      type: "payment_detail_ensured",
      message: `Ensured payment detail #${paymentDetail.id}.`,
      data: { paymentDetailId: paymentDetail.id },
    });
  }

  if (!paymentDetailsId) {
    throw new Error("Missing payment details id for trade execution.");
  }

  const quotedCryptoAmount = session.execution.preflight?.quote?.totalCryptoAmount || amount;
  const tradeRequest = await client.createTradeRequest({
    tradeType: "SELL",
    fiatCurrencyCode: session.currency!,
    fiatAmount: amount,
    cryptoAmount: quotedCryptoAmount,
    paymentDetailsId,
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
    events.push({
      type: "settlement_monitor_started",
      message: `Started post-match settlement monitoring for trade request #${matched.id}.`,
      data: { tradeRequestId: matched.id, tradeId: matched.trade?.id },
    });

    const settlement = await refreshSettlementForSession(session, deps, "poll");
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
        ? `Trade request #${matched.id} matched. Trade #${matched.trade.id} is now ${matched.trade.status || "created"}. I am monitoring settlement. Reply 'received' only after the recipient confirms the fiat arrived, or 'not received' to keep escrow locked.`
        : `Trade request #${matched.id} matched successfully. I am now monitoring settlement.`,
      ["received", "not received", "status"],
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
  if (["awaiting_auth_choice", "awaiting_evm_wallet_signin", "awaiting_evm_login_key", "awaiting_evm_signing_key", "awaiting_secret_cleanup_confirmation"].includes(inputSession.stage)) {
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

  if (hints.cancel) {
    session.status = "cancelled";
    session.stage = "cancelled";
    return reply(withUpdate(session, deps), "Okay, I cancelled this transfer flow.");
  }

  const statusReply = await maybeHandleStatusRequest(session, hints, deps);
  if (statusReply) return statusReply;

  const settlementReply = await maybeHandleSettlementTurn(session, normalizedTurn, deps);
  if (settlementReply) return settlementReply;

  if (settlementStageActive(session) && session.execution.tradeRequestId) {
    const snapshot = await refreshSettlementForSession(session, deps, "refresh");
    if (snapshot) {
      return reply(withUpdate(session, deps), snapshot.prompt, snapshot.options, snapshot.events.map(mapSettlementEvent));
    }
  }

  if (!session.auth.checked) {
    const auth = resolveInitialAuthState(deps.authState);
    session.auth = {
      checked: true,
      available: auth.hasReplayableAuth,
      mode: auth.authMode,
      choice: session.auth.choice,
      evmSigningKeyAvailable: auth.evmSigningKeyAvailable,
      username: auth.username,
      balanceUsd: auth.balanceUsd,
      startupSnapshotShown: false,
    };
    if (session.goal === "transfer" && session.auth.available) {
      await maybeHydrateStartupAuthStatus(session, deps);
    }
  }

  const authOnboardingReply = await maybeHandleAuthOnboardingTurn(session, normalizedTurn, deps);
  if (authOnboardingReply) return authOnboardingReply;

  applyHintsToSession(session, stageAwareHints);
  applyMidFlowChanges(session, hints);

  const topUpReply = await maybeHandleTopUpTurn(session, normalizedTurn, deps);
  if (topUpReply) return topUpReply;

  if (session.goal === "transfer" && !session.auth.available) {
    session.status = "blocked";
    session.stage = "awaiting_auth_choice";
    if (hints.authChoice) {
      session.auth.choice = hints.authChoice;
      const followUp = hints.authChoice === "evm"
        ? "Before I ask for any key: have you already signed in on unigox.com with that EVM wallet? If not, please do that first, then tell me once it’s done. After that I’ll ask which login wallet key you used."
        : hints.authChoice === "ton"
          ? "Please provide the TON mnemonic and raw TON address so onboarding can verify TON login."
          : "Please provide the email address to use for OTP onboarding / recovery.";
      session.stage = hints.authChoice === "evm" ? "awaiting_evm_wallet_signin" : "awaiting_auth_choice";
      return reply(withUpdate(session, deps), followUp, hints.authChoice === "evm" ? ["I signed in", "TON wallet connection", "email OTP"] : undefined, [{
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

  if (session.goal === "transfer" && session.auth.available && session.auth.mode === "evm" && !session.auth.evmSigningKeyAvailable) {
    await maybeHydrateAuthIdentity(session, deps);
    session.status = "blocked";
    session.stage = "awaiting_evm_signing_key";
    const followUp = buildMissingSigningKeyPrompt(session.auth.username);
    return reply(withUpdate(session, deps), followUp, undefined, [{
      type: "blocked_missing_auth",
      message: followUp,
    }]);
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
    const resolution = resolveContactQuery(store, session.recipientQuery);
    if (resolution.match) {
      const queryDiffersFromSavedName = normalizeLookupValue(session.recipientQuery) !== normalizeLookupValue(resolution.match.contact.name);
      session.contactKey = resolution.match.key;
      session.recipientName = resolution.match.contact.name;
      session.aliases = resolution.match.contact.aliases || [];
      session.contactExists = true;
      session.recipientMode = "saved";
      if (queryDiffersFromSavedName || resolution.matchedBy === "partial") {
        savedContactReplyNote = addReplyNote(savedContactReplyNote, `I found saved contact ${session.recipientName}.`);
      }
    } else if (session.recipientMode === "saved") {
      session.stage = "awaiting_recipient_name";
      if (resolution.ambiguous.length) {
        return reply(
          withUpdate(session, deps),
          buildSavedContactDisambiguation(session.recipientQuery, resolution.ambiguous),
          resolution.ambiguous.map((match) => match.contact.name)
        );
      }
      return reply(withUpdate(session, deps), `I couldn't find a saved contact for '${session.recipientQuery}'. Who is the recipient?`);
    } else {
      session.recipientName = session.recipientQuery;
      session.aliases = [session.recipientQuery];
      session.contactExists = false;
      session.recipientMode = "new";
      session.contactSaveAction = "create";
    }
  }

  if (session.contactExists && !session.currency) {
    const store = loadContacts(deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
    const contact = session.contactKey ? store.contacts[session.contactKey] : resolveContact(store, session.recipientName)?.contact;
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
    const store = loadContacts(deps.contactsFilePath || DEFAULT_CONTACTS_FILE);
    const match = session.contactKey ? { key: session.contactKey, contact: store.contacts[session.contactKey] } as ContactMatch : resolveContact(store, session.recipientName);
    const contact = match?.contact;
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

  if (session.payment && !session.payment.networkId) {
    const getMethods = deps.getPaymentMethodsForCurrency || defaultGetPaymentMethodsForCurrency;
    const currencyData = await getMethods(session.currency!);
    const method = currencyData.paymentMethods.find((entry) => entry.id === session.payment?.methodId);
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

  const client = await getExecutionClient(deps);
  const preflight = await ensureExecutionPreflight(session, deps, client);
  events.push(...preflight.events);
  if (preflight.blockedResult) {
    return prependReplyContext(preflight.blockedResult, savedContactReplyNote);
  }

  if (!session.execution.confirmed) {
    session.stage = "awaiting_confirmation";
    if (hints.confirm) {
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
