#!/usr/bin/env -S node --experimental-strip-types
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mnemonicValidate } from "@ton/crypto";
import { Address } from "@ton/ton";
import { Wallet } from "ethers";

import UnigoxClient, {
  getPaymentMethodsForCurrency as defaultGetPaymentMethodsForCurrency,
  getPaymentMethodFieldConfig as defaultGetPaymentMethodFieldConfig,
  parseTonPrivateKeyInput,
  validatePaymentDetailInput as defaultValidatePaymentDetailInput,
  getUnigoxWalletConnectionPrompt,
} from "./unigox-client.ts";
import type {
  AgenticPaymentsSettings,
  CurrencyPaymentData,
  DepositFlowSelection,
  InitiatorTradeSummary,
  KycVerificationData,
  NetworkFieldConfig,
  PartnerPaymentDetailsDiffData,
  PaymentDetail,
  PaymentFieldValidationResult,
  PaymentMethodInfo,
  PaymentNetworkInfo,
  PreflightQuote,
  ResolvedPaymentMethodFieldConfig,
  SupportedDepositAssetOption,
  SupportedDepositChainOption,
  TonWalletVersion,
  TradeRequest,
  UnigoxClientConfig,
  UserProfile,
  WalletBalance,
  WalletBalanceAsset,
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
  SettlementMonitorOptions,
  SettlementPhase,
  SettlementSnapshot,
  SettlementTrade,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SETTINGS_FILE = path.join(SKILL_DIR, "settings.json");

type AuthChoice = "evm" | "ton" | "email" | "generated_evm" | "generated_ton";
type SecretKind = "evm_login_key" | "evm_signing_key" | "ton_private_key" | "ton_mnemonic";
type TopUpMethod = "internal_username" | "external_deposit";

export type TransferGoal = "transfer" | "save_contact_only";
export type TransferStage =
  | "resolving"
  | "awaiting_auth_choice"
  | "awaiting_email_address"
  | "awaiting_email_otp"
  | "awaiting_wallet_setup_choice"
  | "awaiting_evm_wallet_signin"
  | "awaiting_evm_login_key"
  | "awaiting_evm_signing_key"
  | "awaiting_ton_address"
  | "awaiting_ton_address_confirmation"
  | "awaiting_ton_auth_method"
  | "awaiting_ton_private_key"
  | "awaiting_ton_mnemonic"
  | "awaiting_tonconnect_completion"
  | "awaiting_secret_cleanup_confirmation"
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
  | "awaiting_topup_method"
  | "awaiting_external_deposit_asset"
  | "awaiting_external_deposit_chain"
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
    | "trade_pending"
    | "browser_login_handoff"
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
  getKycVerificationStatus?(): Promise<KycVerificationData>;
  initializeKycVerification?(params: { fullName: string; country: string }): Promise<KycVerificationData>;
  requestEmailOTP?(): Promise<void>;
  verifyEmailOTP?(code: string): Promise<string>;
  generateAndLinkWallet?(): Promise<{ address: string; privateKey: string }>;
  generateAndLinkTonWallet?(): Promise<{ address: string; privateKey: string; walletVersion: TonWalletVersion }>;
  listPaymentDetails?(): Promise<PaymentDetail[]>;
  listInitiatorTrades?(filter?: "action_required" | "waiting_other_party" | "history"): Promise<InitiatorTradeSummary[]>;
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
  fundTradeEscrow?(tokenCode: "USDC" | "USDT", amount: string, escrowAddress: string): Promise<{ txId: number; txHash: string }>;
  getTradeRequest?(tradeRequestId: number): Promise<TradeRequest>;
  getTrade?(tradeId: number): Promise<SettlementTrade | undefined>;
  getPartnerPaymentDetailsDiff?(tradeId: number): Promise<PartnerPaymentDetailsDiffData>;
  createOrUpdatePartnerPaymentDetails?(params: {
    internalDetailsId: number;
    partner: string;
    details: Record<string, string>;
  }): Promise<{ details?: Record<string, string> }>;
  revalidateTradePaymentDetails?(tradeId: number): Promise<{ trade?: SettlementTrade | undefined } | undefined>;
  confirmFiatReceived?(tradeId: number): Promise<SettlementTrade | undefined>;
  confirmTradeRequestPrice?(tradeRequestId: number): Promise<TradeRequest>;
  refuseTradeRequestPrice?(tradeRequestId: number): Promise<TradeRequest>;
  getSupportedDepositOptions?(): Promise<SupportedDepositAssetOption[]>;
  describeDepositSelection?(selection: DepositFlowSelection): Promise<SupportedDepositChainOption & { depositAddress: string }>;
}

export interface TransferFlowDeps {
  contactsFilePath?: string;
  settingsFilePath?: string;
  waitForMatchTimeoutMs?: number;
  waitForSettlementTimeoutMs?: number;
  receiptConfirmationHandoffTimeoutMs?: number;
  settlementPollIntervalMs?: number;
  receiptReminderMs?: number;
  receiptTimeoutMs?: number;
  kycVerificationPollIntervalMs?: number;
  kycVerificationPollTimeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  authState?: AuthState;
  client?: TransferExecutionClient;
  clientFactory?: () => Promise<TransferExecutionClient>;
  clientConfig?: UnigoxClientConfig;
  verifyEvmLoginKey?: (loginKey: string) => Promise<{ success?: boolean; ok?: boolean; message?: string; username?: string } | void>;
  verifyTonLogin?: (params: { tonPrivateKey?: string; mnemonic?: string; tonAddress?: string }) => Promise<{ success?: boolean; ok?: boolean; message?: string; username?: string; tonWalletVersion?: TonWalletVersion } | void>;
  startTonConnectLogin?: () => Promise<{ universalLink: string; manifestUrl?: string; expiresAt?: string; payloadToken: string }>;
  checkTonConnectLogin?: () => Promise<{
    status: "pending" | "connected" | "error";
    walletAddress?: string;
    network?: string;
    publicKey?: string;
    proof?: {
      timestamp: number;
      domain: { lengthBytes: number; value: string };
      signature: string;
      payload: string;
      stateInit?: string;
    };
    message?: string;
  }>;
  clearTonConnectLogin?: () => Promise<void> | void;
  approveTonConnectLink?: (universalLink: string) => Promise<{
    bridgeUrl: string;
    walletAddress: string;
    manifestUrl: string;
    tonProofPayload?: string;
  }>;
  decodeTonConnectQr?: (imagePath: string) => Promise<string | undefined>;
  persistEmailAddress?: (emailAddress: string) => Promise<void> | void;
  persistEvmLoginKey?: (loginKey: string) => Promise<void> | void;
  persistEvmSigningKey?: (signingKey: string) => Promise<void> | void;
  persistTonPrivateKey?: (tonPrivateKey: string) => Promise<void> | void;
  persistTonMnemonic?: (mnemonic: string) => Promise<void> | void;
  persistTonAddress?: (tonAddress: string) => Promise<void> | void;
  persistTonWalletVersion?: (tonWalletVersion: TonWalletVersion) => Promise<void> | void;
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
  walletBalance?: WalletBalance;
}

export interface SecretSubmissionState {
  kind: SecretKind;
  value: string;
  note?: string;
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
  paymentDetailsId?: number;
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

export interface TopUpState {
  method?: TopUpMethod;
  assetCode?: SupportedDepositAssetOption["assetCode"];
  chainId?: number;
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
  tradeId: number;
  tradeRequestId: number;
  paymentDetailsId: number;
  partner: string;
  index: number;
  fields: PartnerFieldToComplete[];
  values: Record<string, string>;
}

interface OutstandingTradeReminderState {
  tradeId: number;
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
    emailAddress?: string;
    emailAuthToken?: string;
    emailAuthTokenExpiresAt?: string;
    evmSigningKeyAvailable?: boolean;
    tonAddress?: string;
    tonAddressDisplay?: string;
    tonWalletVersion?: TonWalletVersion;
    sessionToken?: string;
    sessionTokenExpiresAt?: string;
    tonConnect?: {
      universalLink?: string;
      manifestUrl?: string;
      expiresAt?: string;
      payloadToken?: string;
    };
    username?: string;
    kycStatus?: string;
    kycCountryCode?: string;
    kycFullName?: string;
    totalTradedVolumeUsd?: number;
    kycVerificationUrl?: string;
    kycVerificationSecondsLeft?: number;
    balanceUsd?: number;
    walletBalance?: WalletBalance;
    startupSnapshotShown?: boolean;
    outstandingTradeReminderShown?: boolean;
    outstandingTradeReminder?: string;
    outstandingTrade?: OutstandingTradeReminderState;
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
const MAX_AMOUNT_WITHOUT_KYC = 100;
const KYC_VERIFIED_STATUSES = new Set(["VERIFIED", "APPROVED", "verified", "approved"]);
const KYC_ACTIVE_STATUSES = new Set(["initial", "pending", "in_progress"]);
const KYC_AUTH_FAILURE_KEYS = new Set([
  "invalid_auth_token",
  "auth_token_required",
  "verification_service_auth_failed",
]);
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

function parseKycIdentityInput(text: string | undefined): { fullName?: string; countryCode?: string } {
  const value = cleanText(text);
  if (!value) return {};

  const combined = value.match(
    /(?:my\s+)?(?:full\s+legal\s+name|legal\s+name|name)\s+is\s+(.+?)\s+(?:and|,)\s+(?:my\s+)?country\s+is\s+(.+)$/i
  );
  if (combined) {
    return {
      fullName: combined[1]?.trim() || undefined,
      countryCode: resolveCountryCode(combined[2]),
    };
  }

  // Accept a natural one-line reply like "Alex Grape, Estonia" while KYC is collecting
  // identity details. Require a comma so we do not steal unrelated free-text turns.
  const commaSeparated = value.match(/^(.+?),\s*([^,]+)$/);
  if (commaSeparated) {
    const fullName = commaSeparated[1]?.trim() || undefined;
    const countryCode = resolveCountryCode(commaSeparated[2]);
    if (fullName && countryCode && /\s+/.test(fullName)) {
      return {
        fullName,
        countryCode,
      };
    }
  }

  const fullNameMatch = value.match(/(?:my\s+)?(?:full\s+legal\s+name|legal\s+name|name)\s+is\s+(.+)$/i);
  const countryMatch = value.match(/(?:my\s+)?country\s+is\s+(.+)$/i);

  return {
    fullName: fullNameMatch?.[1]?.trim() || undefined,
    countryCode: resolveCountryCode(countryMatch?.[1]),
  };
}

function parseEmailAddress(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.trim();
}

function parseOtpCode(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  const inline = value.match(/\b(\d{4,8})\b/);
  return inline?.[1];
}

function parseTonAddressInput(text: string | undefined): { raw: string; display: string } | undefined {
  const value = cleanText(text);
  if (!value) return undefined;

  const candidates = value.match(/(?:[A-Za-z0-9_-]{48,80}|[A-Za-z0-9_-]?:[0-9a-fA-F]{64})/g) || [];
  for (const candidate of candidates) {
    try {
      return {
        raw: Address.parse(candidate).toRawString().toLowerCase(),
        display: candidate,
      };
    } catch {
      // keep scanning
    }
  }

  return undefined;
}

function parseTonAddress(text: string | undefined): string | undefined {
  return parseTonAddressInput(text)?.raw;
}

function parseTonConnectUniversalLinkInput(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  const match = value.match(/tc:\/\/\?[^\s]+/i);
  return match?.[0];
}

function parseTonMnemonic(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;

  const words = value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (words.length < 12 || words.length > 24) return undefined;
  if (!words.every((entry) => /^[a-z]+$/i.test(entry))) return undefined;
  return words.join(" ");
}

function chooseTonCredentialMethod(text: string | undefined): "mnemonic" | "private_key" | "tonconnect" | undefined {
  const value = cleanText(text)?.toLowerCase();
  if (!value) return undefined;
  if (/\b(tonconnect|ton connect|qr|qr code|deep link|wallet connect)\b/.test(value)) return "tonconnect";
  if (/\b(mnemonic|seed phrase|recovery phrase|12 words|24 words)\b/.test(value)) return "mnemonic";
  if (/\b(private key|secret key|ton key|seed32|secret64)\b/.test(value)) return "private_key";
  return undefined;
}

function parseTonPrivateKey(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;
  return parseTonPrivateKeyInput(value)?.normalized;
}

function parseEvmPrivateKey(text: string | undefined): string | undefined {
  const value = cleanText(text);
  if (!value) return undefined;

  const match = value.match(/\b(?:0x)?[0-9a-fA-F]{64}\b/);
  if (!match) return undefined;

  const normalized = match[0].startsWith("0x") ? match[0] : `0x${match[0]}`;
  try {
    new Wallet(normalized);
    return normalized;
  } catch {
    return undefined;
  }
}

function looksLikeEvmAddress(text: string | undefined): boolean {
  const value = cleanText(text);
  if (!value) return false;
  return /\b(?:0x)?[0-9a-fA-F]{40}\b/.test(value);
}

const AUTH_CHOICE_OPTIONS = [
  "EVM wallet connection",
  "TON wallet connection",
  "Create dedicated EVM wallet",
  "Create dedicated TON wallet",
  "email OTP",
] as const;

const POST_EMAIL_WALLET_SETUP_OPTIONS = [
  "Create dedicated EVM wallet",
  "Create dedicated TON wallet",
  "Stay on email OTP for now",
] as const;

function parseAuthChoice(value: string): AuthChoice | undefined {
  const normalized = cleanText(value)?.toLowerCase();
  if (!normalized) return undefined;

  if (/^(evm|evm wallet|evm wallet connection|wallet connection evm)$/.test(normalized)) {
    return "evm";
  }
  if (/^(ton|ton wallet|ton wallet connection|wallet connection ton)$/.test(normalized)) {
    return "ton";
  }
  if (/^(create|generate|make)\s+(?:a\s+)?(?:dedicated\s+|new\s+|local\s+)?evm wallet(?: for me)?$/.test(normalized)) {
    return "generated_evm";
  }
  if (/^(create|generate|make)\s+(?:a\s+)?(?:dedicated\s+|new\s+|local\s+)?ton wallet(?: for me)?$/.test(normalized)) {
    return "generated_ton";
  }
  if (/^(email|otp|email otp)$/.test(normalized)) {
    return "email";
  }

  if (/\b(?:let'?s do|lets do|use|choose|pick|go with|do)\s+(?:the\s+)?(?:evm|evm wallet(?: connection)?)\b/.test(normalized)) {
    return "evm";
  }
  if (/\b(?:let'?s do|lets do|use|choose|pick|go with|do)\s+(?:the\s+)?(?:ton|ton wallet(?: connection)?)\b/.test(normalized)) {
    return "ton";
  }
  if (/\b(?:let'?s do|lets do|use|choose|pick|go with|do|create|generate|make)\s+(?:me\s+)?(?:a\s+)?(?:dedicated\s+|new\s+|local\s+)?evm wallet\b/.test(normalized)) {
    return "generated_evm";
  }
  if (/\b(?:let'?s do|lets do|use|choose|pick|go with|do|create|generate|make)\s+(?:me\s+)?(?:a\s+)?(?:dedicated\s+|new\s+|local\s+)?ton wallet\b/.test(normalized)) {
    return "generated_ton";
  }
  if (/\b(?:let'?s do|lets do|use|choose|pick|go with|do)\s+(?:the\s+)?(?:email|email otp|otp)\b/.test(normalized)) {
    return "email";
  }
  if (/\b(?:stay|keep using|use)\s+(?:on\s+)?email(?: otp)?(?: for now)?\b/.test(normalized)) {
    return "email";
  }

  return undefined;
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
  hints.authChoice = parseAuthChoice(value);
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
  const formattedUsername = formatUsername(session.auth.username);
  if (formattedUsername) {
    parts.push(`You're currently signed in as ${formattedUsername} on UNIGOX.`);
  }
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
  if (!/signed in as/i.test(message)) {
    const formattedUsername = formatUsername(session.auth.username);
    if (formattedUsername) {
      snapshotParts.push(`You're currently signed in as ${formattedUsername} on UNIGOX.`);
    }
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
  const tonPrivateKey = loadEnvValue("UNIGOX_TON_PRIVATE_KEY");
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
  if (tonPrivateKey || tonMnemonic) {
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
  const tonPrivateKey = loadEnvValue("UNIGOX_TON_PRIVATE_KEY");
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

  if (tonPrivateKey || tonMnemonic) {
    return {
      authMode: "ton",
      ...(tonPrivateKey && { tonPrivateKey }),
      ...(tonMnemonic && { tonMnemonic }),
      tonAddress: loadEnvValue("UNIGOX_TON_ADDRESS"),
      tonWalletVersion: loadEnvValue("UNIGOX_TON_WALLET_VERSION") as TonWalletVersion | undefined,
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

function buildExecutionClientConfig(session: TransferSession | undefined, deps: TransferFlowDeps): UnigoxClientConfig {
  let config: UnigoxClientConfig | undefined = deps.clientConfig;
  if (!config) {
    try {
      config = loadUnigoxConfigFromEnv();
    } catch {
      if (!session?.auth.emailAddress) throw new Error(`UNIGOX auth config not found. ${getUnigoxWalletConnectionPrompt()}`);
      config = {
        authMode: "email",
        email: session.auth.emailAddress,
      };
    }
  }

  const transientSessionToken = session?.auth.sessionToken || session?.auth.emailAuthToken;
  const sessionTokenExpiresAt = session?.auth.sessionTokenExpiresAt
    ? Date.parse(session.auth.sessionTokenExpiresAt)
    : session?.auth.emailAuthTokenExpiresAt
      ? Date.parse(session.auth.emailAuthTokenExpiresAt)
    : undefined;

  if (session?.auth.mode === "email" || transientSessionToken) {
    return {
      ...config,
      authMode: session?.auth.mode || config.authMode || "email",
      email: session.auth.emailAddress || config.email || getStoredEmailAddress(deps),
      ...(transientSessionToken ? { sessionToken: transientSessionToken } : {}),
      ...(sessionTokenExpiresAt ? { sessionTokenExpiresAt } : {}),
    };
  }

  return config;
}

async function getExecutionClient(deps: TransferFlowDeps, session?: TransferSession): Promise<TransferExecutionClient> {
  if (deps.client) return deps.client;
  if (deps.clientFactory) return deps.clientFactory();
  return new UnigoxClient(buildExecutionClientConfig(session, deps));
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

async function verifyTonLoginInput(
  params: { tonPrivateKey?: string; mnemonic?: string; tonAddress?: string },
  deps: TransferFlowDeps
): Promise<{ success: boolean; message?: string; username?: string; tonWalletVersion?: TonWalletVersion }> {
  const { tonPrivateKey, mnemonic, tonAddress } = params;
  if (!tonPrivateKey && !mnemonic) {
    return { success: false, message: "TON auth requires a TON private key or legacy mnemonic." };
  }

  if (deps.verifyTonLogin) {
    const result = await deps.verifyTonLogin({ tonPrivateKey, mnemonic, tonAddress });
    if (!result) return { success: true };
    return {
      success: result.success ?? result.ok ?? true,
      message: result.message,
      username: result.username,
      tonWalletVersion: result.tonWalletVersion,
    };
  }

  let email: string | undefined;
  let frontendUrl: string | undefined;
  let evmSigningPrivateKey: string | undefined;
  let tonWalletVersion: TonWalletVersion | undefined;
  if (deps.clientConfig) {
    email = deps.clientConfig.email;
    frontendUrl = deps.clientConfig.frontendUrl;
    evmSigningPrivateKey = deps.clientConfig.evmSigningPrivateKey || deps.clientConfig.privateKey;
    tonWalletVersion = deps.clientConfig.tonWalletVersion;
  } else {
    try {
      const config = loadUnigoxConfigFromEnv();
      email = config.email;
      frontendUrl = config.frontendUrl;
      evmSigningPrivateKey = config.evmSigningPrivateKey || config.privateKey;
      tonWalletVersion = config.tonWalletVersion;
    } catch {
      // Verification can proceed with the supplied TON credentials alone.
    }
  }

  try {
    const client = new UnigoxClient({
      authMode: "ton",
      ...(tonPrivateKey ? { tonPrivateKey } : {}),
      ...(mnemonic ? { tonMnemonic: mnemonic } : {}),
      ...(tonAddress ? { tonAddress } : {}),
      ...(tonWalletVersion ? { tonWalletVersion } : {}),
      ...(email ? { email } : {}),
      ...(frontendUrl ? { frontendUrl } : {}),
      ...(evmSigningPrivateKey ? { evmSigningPrivateKey } : {}),
    });
    await client.login();
    const derivation = client.getTonWalletDerivation();

    let username: string | undefined;
    try {
      username = (await client.getProfile())?.username;
    } catch {
      // Username is helpful but optional for a successful verification.
    }

    return { success: true, username, tonWalletVersion: derivation?.walletVersion };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyLegacyTonMnemonicInput(
  mnemonic: string,
  tonAddress: string | undefined,
  deps: TransferFlowDeps
): Promise<{ success: boolean; message?: string; username?: string }> {
  return verifyTonLoginInput({ mnemonic, tonAddress }, deps);
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

function formatUsername(username: string | undefined): string | undefined {
  if (!username) return undefined;
  return username.startsWith("@") ? username : `@${username}`;
}

function buildUsernameReminder(username: string | undefined): string | undefined {
  const formatted = formatUsername(username);
  if (!formatted) return undefined;
  return `You're currently signed in as ${formatted} on UNIGOX. You can change that username later in this agent flow or on unigox.com.`;
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
  paymentDetailsId: number;
  tradePartner?: "licensed" | "p2p" | "all";
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
          tradeType: "SELL",
          cryptoCurrencyCode: asset.assetCode,
          fiatAmount: params.amount,
          paymentDetailsId: params.paymentDetailsId,
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
    buildAssetCoverageLine(preflight),
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
    : kind === "evm_signing_key"
      ? "UNIGOX-exported signing key"
      : kind === "ton_private_key"
        ? "TON private key"
        : "TON mnemonic";
  return [
    "🚨🔐 IMPORTANT WALLET SAFETY WARNING 🔐🚨",
    `Use a NEWLY CREATED / ISOLATED wallet for this ${keyLabel}.`,
    "❌ This must NOT be your main wallet.",
    "❌ Do NOT paste a wallet that holds long-term funds.",
    "✅ Use a dedicated UNIGOX / agent wallet only.",
  ].join(" ");
}

function buildWalletSetupChoicePrompt(emailAddress?: string): string {
  return [
    emailAddress ? `Email OTP worked for ${emailAddress}.` : "Email OTP worked.",
    "To keep future sign-in simple, I can create a dedicated login wallet for you locally on this device.",
    "Which path should I set up now?",
    "1. Create a dedicated EVM wallet on this device",
    "2. Create a dedicated TON wallet on this device",
    "3. Stay on email OTP for now",
  ].join(" ");
}

function buildEvmLoginKeyPrompt(): string {
  return [
    buildEvmKeySecurityWarning("evm_login_key"),
    "Great. Which wallet key did you use to sign in on UNIGOX? Paste the login wallet private key and I’ll verify login with that key first.",
  ].join(" ");
}

function buildInvalidEvmKeyPrompt(kind: "evm_login_key" | "evm_signing_key", username?: string): string {
  const followUp = kind === "evm_login_key" ? buildEvmLoginKeyPrompt() : buildMissingSigningKeyPrompt(username);
  return [
    "That doesn’t look like a valid EVM private key.",
    "I accept the key with or without 0x, but it must be the full 32-byte private key, not the wallet address.",
    followUp,
  ].join(" ");
}

function buildAddressInsteadOfPrivateKeyPrompt(kind: "evm_login_key" | "evm_signing_key", username?: string): string {
  const followUp = kind === "evm_login_key" ? buildEvmLoginKeyPrompt() : buildMissingSigningKeyPrompt(username);
  return [
    "That looks like an EVM address, not a private key.",
    "I accept the private key with or without 0x, but it must be the full 32-byte private key, not the 20-byte wallet address.",
    followUp,
  ].join(" ");
}

function buildInvalidTonMnemonicPrompt(tonAddress: string | undefined): string {
  const followUp = tonAddress ? buildTonAuthMethodPrompt(tonAddress) : buildTonAddressPrompt();
  return [
    "That doesn’t look like a valid TON mnemonic phrase yet.",
    "Send the full mnemonic for the exact wallet address you confirmed, and I’ll match the supported TON wallet versions locally until one derives that address.",
    followUp,
  ].join(" ");
}

function buildInvalidTonPrivateKeyPrompt(tonAddress: string | undefined): string {
  const followUp = tonAddress ? buildTonAuthMethodPrompt(tonAddress) : buildTonAddressPrompt();
  return [
    "That doesn’t look like a valid TON private key / secret key.",
    "I accept a TON key as 32-byte or 64-byte key material in hex or base64, with or without 0x.",
    followUp,
  ].join(" ");
}

function buildEvmSigningKeyPrompt(username: string | undefined): string {
  return [
    buildUsernameReminder(username),
    buildEvmKeySecurityWarning("evm_signing_key"),
    "Login works. One more step: I still need the separate UNIGOX EVM signing key from your account settings, the UNIGOX-exported EVM signing key.",
    "Why: wallet login, TON login, or email OTP only gets me signed in. Secure in-app actions like funding trade escrow, confirming fiat received, or releasing escrow require that separate exported signing key.",
    "How to get it: open your UNIGOX account settings and export the agentic-payments / signing key, then paste that private key here.",
    "To get into unigox.com settings and export it, you can use any of these browser-login paths: 1. scan a fresh UNIGOX TonConnect QR in your wallet, 2. copy the fresh tc:// TonConnect link into your wallet if UNIGOX shows that instead of a QR, or 3. use your mobile or desktop wallet and log in to UNIGOX directly.",
    buildTonConnectBrowserApprovalPrompt(),
    "If you do not see the export option yet, this beta feature probably is not enabled on your account yet and you likely still need early beta access for agentic payments. Ask UNIGOX via hello@unigox.com or Intercom chat to enable agentic-payments access for your account, then come back and paste the exported key here.",
    "I’ll store it locally on this machine so I can reuse it safely for those signed actions.",
  ].filter(Boolean).join(" ");
}

function buildMissingSigningKeyPrompt(username: string | undefined): string {
  return [
    buildUsernameReminder(username),
    buildEvmKeySecurityWarning("evm_signing_key"),
    "Login is already set up, but this next step needs the separate UNIGOX EVM signing key from your account settings, the UNIGOX-exported EVM signing key.",
    "Why: sign-in alone is enough for quotes and some setup, but secure actions like funding trade escrow, confirming fiat received, or releasing escrow still require the exported signing key.",
    "How to get it: open your UNIGOX account settings and export the agentic-payments / signing key, then paste that private key here.",
    "To get into unigox.com settings and export it, you can use any of these browser-login paths: 1. scan a fresh UNIGOX TonConnect QR in your wallet, 2. copy the fresh tc:// TonConnect link into your wallet if UNIGOX shows that instead of a QR, or 3. use your mobile or desktop wallet and log in to UNIGOX directly.",
    buildTonConnectBrowserApprovalPrompt(),
    "If you do not see the export option yet, this beta feature probably is not enabled on your account yet and you likely still need early beta access for agentic payments. Ask UNIGOX via hello@unigox.com or Intercom chat to enable agentic-payments access for your account, then come back and paste the exported key here.",
    "I’ll store it locally on this machine so I can reuse it safely across turns.",
  ].filter(Boolean).join(" ");
}

function getStoredTonAddress(deps: TransferFlowDeps): string | undefined {
  return deps.clientConfig?.tonAddress || loadEnvValue("UNIGOX_TON_ADDRESS");
}

function buildTonAddressPrompt(): string {
  return [
    "I can do TON login here.",
    "First send the TON address shown by the wallet you use on UNIGOX.",
    "You can paste either the normal wallet address form or the raw 0:... form.",
    "I’ll use that exact address as the source of truth so I do not guess the wrong wallet version.",
  ].join(" ");
}

function buildTonAddressConfirmationPrompt(tonAddress: string): string {
  return [
    `I’ll use this exact TON address: ${tonAddress}.`,
    "Is this the correct wallet address for the wallet you used on UNIGOX, or should I use a different version / address?",
    "Once you confirm it, you can either send the mnemonic phrase for that wallet, send the TON private key / secret key, or use a fresh TonConnect QR / deep link. I’ll keep only the wallet version that actually matches this exact address.",
  ].join(" ");
}

function buildTonAuthMethodPrompt(tonAddress: string): string {
  return [
    `Got the TON address: ${tonAddress}.`,
    "How do you want me to complete TON login for this exact wallet?",
    "1. Send the TON mnemonic phrase for this wallet",
    "2. Send the TON private key / secret key for this wallet",
    "3. Say 'TonConnect QR' and I’ll generate a fresh live TonConnect deep link for this login",
    "For the mnemonic/private-key paths, I’ll derive the supported TON wallet versions locally and keep the one that matches this exact address.",
  ].join(" ");
}

function buildTonMnemonicPrompt(tonAddress: string): string {
  return [
    buildEvmKeySecurityWarning("ton_mnemonic"),
    `Got the TON address: ${tonAddress}.`,
    "Now send the TON mnemonic phrase for that same wallet and I’ll match the supported TON wallet versions locally until one derives this exact address, then I’ll log in from the agent side.",
  ].join(" ");
}

function buildTonPrivateKeyPrompt(tonAddress: string): string {
  return [
    buildEvmKeySecurityWarning("ton_private_key"),
    `Got the TON address: ${tonAddress}.`,
    "Now send the TON private key / secret key for that same wallet and I’ll match the supported TON wallet versions locally until one derives this exact address, then I’ll verify TON login here from the agent side.",
  ].join(" ");
}

function buildTonConnectPrompt(params: { universalLink: string; expiresAt?: string; tonAddress?: string }): string {
  const expiresIn = params.expiresAt
    ? Math.max(1, Math.round((Date.parse(params.expiresAt) - Date.now()) / 60000))
    : undefined;
  return [
    "Your fresh TonConnect login link is ready.",
    params.tonAddress ? `I’ll only accept the connection if the wallet comes back as this address: ${params.tonAddress}.` : undefined,
    params.universalLink,
    "Open that link in the TON wallet you use on UNIGOX. If you’re on another device, scan a QR generated from this exact link.",
    "Use this live link or a QR generated from it now. An old screenshot of a previous QR will not work as a reusable login credential.",
    expiresIn ? `This live request should stay valid for about ${expiresIn} minutes.` : undefined,
    "After you approve it in the wallet, reply with: connected",
  ].filter(Boolean).join(" ");
}

function buildTonConnectBrowserApprovalPrompt(): string {
  return [
    "If UNIGOX is already showing you a fresh tc:// TonConnect link in the browser, you can paste that link here too.",
    "You can also send a fresh screenshot of the visible TonConnect QR and I’ll decode the tc:// request locally on this machine.",
    "I’ll use the TON key on this machine to approve that live browser-login request so the UNIGOX page can finish logging you in without a manual wallet scan.",
  ].join(" ");
}

function buildTonConnectBrowserApprovalSuccessPrompt(): string {
  return [
    "I approved that fresh UNIGOX TonConnect browser-login request locally with the TON key for this wallet.",
    "If the page is still open on that live request, it should finish logging you in within a moment.",
    "Once you are in UNIGOX settings, export the agentic-payments / signing key and paste it here.",
    "If the page does not move, refresh UNIGOX and generate a fresh link because these requests expire quickly.",
  ].join(" ");
}

function buildTonConnectBrowserApprovalMissingTonKeyPrompt(): string {
  return [
    "I can consume a fresh UNIGOX tc:// TonConnect link here, but I still need TON key material for that exact wallet on this machine first.",
    "Send the TON mnemonic phrase or TON private key / secret key for that wallet, then paste the fresh tc:// link again.",
  ].join(" ");
}

function buildTonConnectBrowserApprovalFailurePrompt(message?: string): string {
  return [
    "I couldn’t approve that UNIGOX TonConnect browser-login link yet.",
    message ? `Reason: ${message}` : undefined,
    "Make sure it is a fresh tc:// link from unigox.com, not an older expired one.",
  ].filter(Boolean).join(" ");
}

function buildTonConnectQrDecodeFailurePrompt(message?: string): string {
  return [
    "I couldn’t read a valid fresh UNIGOX TonConnect QR from that image yet.",
    message ? `Reason: ${message}` : undefined,
    "Send a fresh screenshot with the QR clearly visible, or paste the fresh tc:// link directly.",
  ].filter(Boolean).join(" ");
}

function buildTonConnectStillWaitingPrompt(params: { universalLink: string; expiresAt?: string }): string {
  const expiresIn = params.expiresAt
    ? Math.max(1, Math.round((Date.parse(params.expiresAt) - Date.now()) / 60000))
    : undefined;
  return [
    "I’m still waiting for the TonConnect approval from the wallet.",
    params.universalLink,
    expiresIn ? `This live request should still be valid for about ${expiresIn} minutes.` : undefined,
    "Approve it in the wallet, then reply: connected",
  ].filter(Boolean).join(" ");
}

function buildSecretCleanupPrompt(secret: SecretSubmissionState): string {
  const label = secret.kind === "evm_login_key"
    ? "login wallet key"
    : secret.kind === "evm_signing_key"
      ? "UNIGOX-exported signing key"
      : secret.kind === "ton_private_key"
        ? "TON private key"
        : "TON mnemonic";
  return [
    secret.note,
    `⚠️ For safety, please delete the message that contains your ${label} from this chat right now.`,
    "If this channel/runtime cannot delete your message automatically, I need you to delete it yourself before I continue.",
    "Reply 'deleted' once that message is gone.",
  ].filter(Boolean).join(" ");
}

function getStoredEmailAddress(deps: TransferFlowDeps): string | undefined {
  if (deps.clientConfig?.email) return deps.clientConfig.email;
  return loadEnvValue("UNIGOX_EMAIL");
}

function buildEmailAddressPrompt(existingEmail?: string): string {
  if (existingEmail) {
    return `I can use ${existingEmail} for email OTP recovery. Reply with that email again if you want to use it, or send a different email address.`;
  }
  return "What email address should I use for OTP onboarding or recovery?";
}

function buildEmailOtpPrompt(email: string): string {
  return `I sent a 6-digit code to ${email}. What’s the code?`;
}

function buildGeneratedWalletFailurePrompt(kind: "generated_evm" | "generated_ton", message?: string): string {
  const walletLabel = kind === "generated_evm" ? "dedicated EVM login wallet" : "dedicated TON login wallet";
  return [
    `I couldn’t create the ${walletLabel} automatically yet.`,
    message ? `Reason: ${message}` : undefined,
    "You can retry that generated-wallet path, use your own wallet instead, or stay on email OTP for now.",
  ].filter(Boolean).join(" ");
}

function buildGeneratedEvmWalletReadyPrompt(username: string | undefined): string {
  return [
    "Email OTP works.",
    "I generated and linked a dedicated EVM login wallet locally on this machine, so you do not need to paste the EVM login key yourself.",
    "It was created from cryptographic randomness and kept local to this device.",
    buildEvmSigningKeyPrompt(username),
  ].filter(Boolean).join(" ");
}

function buildGeneratedTonWalletReadyPrompt(username: string | undefined): string {
  return [
    "Email OTP works.",
    "I generated and linked a dedicated TON login wallet locally on this machine, so you do not need to paste the TON login key yourself.",
    "It was created from cryptographic randomness and kept local to this device.",
    buildEvmSigningKeyPrompt(username),
  ].filter(Boolean).join(" ");
}

function buildEmailOtpOnlyReadyPrompt(username: string | undefined): string {
  return [
    "Email OTP works. I can keep using email OTP for onboarding or recovery on this device, but future re-authentication may still need another code.",
    buildMissingSigningKeyPrompt(username),
  ].filter(Boolean).join(" ");
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
    const fullProfile = profile as UserProfile;
    const fullName = buildKycFullName(fullProfile.first_name, fullProfile.last_name);
    if (fullName) {
      session.auth.kycFullName = fullName;
    }
    if (fullProfile.kyc_country_code) {
      session.auth.kycCountryCode = fullProfile.kyc_country_code.toUpperCase();
    }
    if (typeof fullProfile.total_traded_volume_usd === "number") {
      session.auth.totalTradedVolumeUsd = fullProfile.total_traded_volume_usd;
    }
    if (fullProfile.id_verification_status) {
      session.auth.kycStatus = fullProfile.id_verification_status;
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

async function maybeRefreshStoredAuthState(
  session: TransferSession,
  deps: TransferFlowDeps
): Promise<void> {
  if (session.goal !== "transfer" || session.auth.available) return;

  const auth = resolveInitialAuthState(deps.authState);
  if (!auth.hasReplayableAuth) return;

  session.auth.checked = true;
  session.auth.available = true;
  session.auth.mode = auth.authMode || session.auth.mode;
  session.auth.choice = auth.authMode || session.auth.choice;
  session.auth.evmSigningKeyAvailable = auth.evmSigningKeyAvailable;
  session.auth.username = auth.username || session.auth.username;
  session.auth.balanceUsd = auth.balanceUsd ?? session.auth.balanceUsd;
  session.auth.walletBalance = auth.walletBalance ?? session.auth.walletBalance;
  session.auth.startupSnapshotShown = false;
  session.auth.outstandingTradeReminderShown = false;
  session.auth.outstandingTradeReminder = undefined;
  session.auth.outstandingTrade = undefined;
  session.auth.pendingSecret = undefined;

  if ([
    "awaiting_auth_choice",
    "awaiting_email_address",
    "awaiting_email_otp",
    "awaiting_wallet_setup_choice",
    "awaiting_evm_wallet_signin",
    "awaiting_evm_login_key",
    "awaiting_evm_signing_key",
    "awaiting_ton_address",
    "awaiting_ton_address_confirmation",
    "awaiting_ton_auth_method",
    "awaiting_ton_private_key",
    "awaiting_ton_mnemonic",
    "awaiting_tonconnect_completion",
    "awaiting_secret_cleanup_confirmation",
  ].includes(session.stage)) {
    session.status = "active";
    session.stage = "resolving";
  }

  await maybeHydrateStartupAuthStatus(session, deps);
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

async function normalizeSecretInput(
  kind: SecretKind,
  secret: string,
): Promise<string | undefined> {
  if (kind === "ton_private_key") {
    return parseTonPrivateKey(secret);
  }
  if (kind === "ton_mnemonic") {
    const mnemonic = parseTonMnemonic(secret);
    if (!mnemonic) return undefined;
    try {
      return await mnemonicValidate(mnemonic.split(/\s+/)) ? mnemonic : undefined;
    } catch {
      return undefined;
    }
  }
  return parseEvmPrivateKey(secret);
}

function restoreStageForSecretKind(session: TransferSession, kind: SecretKind): void {
  if (kind === "evm_login_key") {
    session.stage = "awaiting_evm_login_key";
    return;
  }
  if (kind === "evm_signing_key") {
    session.stage = "awaiting_evm_signing_key";
    return;
  }
  session.stage = kind === "ton_mnemonic" ? "awaiting_ton_mnemonic" : "awaiting_ton_private_key";
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

async function finalizeTonMnemonic(
  session: TransferSession,
  mnemonic: string,
  deps: TransferFlowDeps,
  prefixEvents: TransferFlowEvent[] = []
): Promise<TransferFlowResult> {
  session.auth.pendingSecret = undefined;
  const verification = await verifyTonLoginInput({ mnemonic, tonAddress: session.auth.tonAddress }, deps);
  if (!verification.success) {
    session.stage = "awaiting_ton_mnemonic";
    const failure = `That TON mnemonic didn't verify against the exact TON address used on UNIGOX. Please double-check the mnemonic phrase and the exact wallet address, then try again.${verification.message ? ` (${verification.message})` : ""}`;
    return reply(withUpdate(session, deps), failure, undefined, [...prefixEvents, {
      type: "blocked_missing_auth",
      message: failure,
    }]);
  }

  if (session.auth.tonAddress) {
    await deps.persistTonAddress?.(session.auth.tonAddress);
  }
  if (verification.tonWalletVersion) {
    session.auth.tonWalletVersion = verification.tonWalletVersion;
    await deps.persistTonWalletVersion?.(verification.tonWalletVersion);
  }
  await deps.persistTonMnemonic?.(mnemonic);

  session.auth.available = true;
  session.auth.mode = "ton";
  session.auth.choice = "ton";
  session.auth.username = verification.username || session.auth.username;
  if (!session.auth.username) {
    await maybeHydrateAuthIdentity(session, deps);
  }

  if (!session.auth.evmSigningKeyAvailable) {
    session.stage = "awaiting_evm_signing_key";
    const followUp = ["TON login works.", buildEvmSigningKeyPrompt(session.auth.username)].filter(Boolean).join(" ");
    return reply(withUpdate(session, deps), followUp, undefined, [...prefixEvents, {
      type: "blocked_missing_auth",
      message: followUp,
    }]);
  }

  session.status = "active";
  session.stage = "resolving";
  const resumed = await advanceTransferFlow(session, { text: "" }, deps);
  if (prefixEvents.length) {
    resumed.events = [...prefixEvents, ...resumed.events];
  }
  return resumed;
}

async function startTonConnectLoginFlow(
  session: TransferSession,
  deps: TransferFlowDeps,
  prefixEvents: TransferFlowEvent[] = []
): Promise<TransferFlowResult> {
  if (!deps.startTonConnectLogin) {
    const prompt = "This skill runtime cannot generate a live TonConnect login link yet. Send the TON mnemonic phrase or TON private key / secret key for that same wallet instead.";
    session.stage = "awaiting_ton_auth_method";
    session.status = "blocked";
    return reply(withUpdate(session, deps), prompt, ["send TON mnemonic", "send TON private key"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  try {
    const started = await deps.startTonConnectLogin();
    session.auth.tonConnect = {
      universalLink: started.universalLink,
      manifestUrl: started.manifestUrl,
      expiresAt: started.expiresAt,
      payloadToken: started.payloadToken,
    };
    session.stage = "awaiting_tonconnect_completion";
    session.status = "blocked";
    const prompt = buildTonConnectPrompt({
      universalLink: started.universalLink,
      expiresAt: started.expiresAt,
      tonAddress: session.auth.tonAddress,
    });
    return reply(withUpdate(session, deps), prompt, ["connected", "status", "send TON mnemonic", "send TON private key"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  } catch (error) {
    const prompt = `I couldn't start a fresh TonConnect login right now.${error instanceof Error ? ` (${error.message})` : ""}`;
    session.stage = "awaiting_ton_auth_method";
    session.status = "blocked";
    return reply(withUpdate(session, deps), prompt, ["send TON mnemonic", "send TON private key"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }
}

function buildTonConnectVerificationClient(deps: TransferFlowDeps): UnigoxClient {
  let frontendUrl: string | undefined;
  let email: string | undefined;
  let evmSigningPrivateKey: string | undefined;
  if (deps.clientConfig) {
    frontendUrl = deps.clientConfig.frontendUrl;
    email = deps.clientConfig.email;
    evmSigningPrivateKey = deps.clientConfig.evmSigningPrivateKey || deps.clientConfig.privateKey;
  } else {
    try {
      const config = loadUnigoxConfigFromEnv();
      frontendUrl = config.frontendUrl;
      email = config.email;
      evmSigningPrivateKey = config.evmSigningPrivateKey || config.privateKey;
    } catch {
      // Default frontend URL is fine.
    }
  }

  return new UnigoxClient({
    ...(frontendUrl ? { frontendUrl } : {}),
    ...(email ? { email } : {}),
    ...(evmSigningPrivateKey ? { evmSigningPrivateKey } : {}),
  });
}

async function tryApproveProvidedTonConnectBrowserLink(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps,
  prefixEvents: TransferFlowEvent[] = [],
): Promise<TransferFlowResult | undefined> {
  let link = parseTonConnectUniversalLinkInput(turn.text);
  if (!link && turn.imagePath) {
    if (!deps.decodeTonConnectQr) {
      const prompt = "This skill runtime cannot decode a TonConnect QR screenshot yet. Paste the fresh tc:// link directly or open the QR in your wallet instead.";
      return reply(withUpdate(session, deps), prompt, undefined, [...prefixEvents, {
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    try {
      link = await deps.decodeTonConnectQr(turn.imagePath);
    } catch (error) {
      const prompt = buildTonConnectQrDecodeFailurePrompt(error instanceof Error ? error.message : undefined);
      return reply(withUpdate(session, deps), prompt, undefined, [...prefixEvents, {
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (!link) {
      const prompt = buildTonConnectQrDecodeFailurePrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [...prefixEvents, {
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }
  }

  if (!link) return undefined;

  if (!deps.approveTonConnectLink) {
    const prompt = "This skill runtime cannot consume a fresh tc:// TonConnect link yet. Open it in your wallet directly or paste the exported signing key here instead.";
    return reply(withUpdate(session, deps), prompt, undefined, [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  try {
    await deps.approveTonConnectLink(link);
    const prompt = buildTonConnectBrowserApprovalSuccessPrompt();
    return reply(withUpdate(session, deps), prompt, undefined, [...prefixEvents, {
      type: "browser_login_handoff",
      message: prompt,
    }]);
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    const prompt = /TON auth requires|tonPrivateKey|tonMnemonic|does not derive the exact TON address/i.test(message || "")
      ? buildTonConnectBrowserApprovalMissingTonKeyPrompt()
      : buildTonConnectBrowserApprovalFailurePrompt(message);
    return reply(withUpdate(session, deps), prompt, undefined, [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }
}

async function finalizeTonConnectLogin(
  session: TransferSession,
  deps: TransferFlowDeps,
  prefixEvents: TransferFlowEvent[] = []
): Promise<TransferFlowResult> {
  const active = session.auth.tonConnect;
  if (!active?.payloadToken || !active.universalLink) {
    session.stage = "awaiting_ton_auth_method";
    session.status = "blocked";
    const prompt = buildTonAuthMethodPrompt(session.auth.tonAddressDisplay || session.auth.tonAddress!);
    return reply(withUpdate(session, deps), prompt, ["send TON mnemonic", "send TON private key", "TonConnect QR"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  if (!deps.checkTonConnectLogin) {
    const prompt = "This skill runtime cannot check TonConnect approval yet. Use the mnemonic or TON private-key path instead.";
    session.stage = "awaiting_ton_auth_method";
    session.status = "blocked";
    return reply(withUpdate(session, deps), prompt, ["send TON mnemonic", "send TON private key"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  const checked = await deps.checkTonConnectLogin();
  if (checked.status === "pending") {
    const prompt = buildTonConnectStillWaitingPrompt({
      universalLink: active.universalLink,
      expiresAt: active.expiresAt,
    });
    session.stage = "awaiting_tonconnect_completion";
    session.status = "blocked";
    return reply(withUpdate(session, deps), prompt, ["connected", "status"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  if (checked.status === "error" || !checked.walletAddress || !checked.network || !checked.proof) {
    const prompt = `TonConnect did not complete cleanly yet.${checked.status === "error" && checked.message ? ` (${checked.message})` : ""} If needed, I can generate a fresh live link.`;
    session.stage = "awaiting_tonconnect_completion";
    session.status = "blocked";
    return reply(withUpdate(session, deps), prompt, ["connected", "status", "TonConnect QR"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  if (session.auth.tonAddress && checked.walletAddress !== session.auth.tonAddress) {
    await deps.clearTonConnectLogin?.();
    session.auth.tonConnect = undefined;
    session.stage = "awaiting_ton_address";
    session.status = "blocked";
    const prompt = [
      `The connected wallet came back as ${checked.walletAddress}, not ${session.auth.tonAddress}.`,
      "That means this TonConnect approval was for a different wallet or address version.",
      "Send the exact TON address you want me to use, then I can generate a fresh TonConnect QR or use the mnemonic/private-key path for that wallet.",
    ].join(" ");
    return reply(withUpdate(session, deps), prompt, ["use a different TON address", "TonConnect QR"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  try {
    const client = buildTonConnectVerificationClient(deps);
    const token = await client.loginWithTonConnect({
      address: checked.walletAddress,
      network: checked.network,
      ...(checked.publicKey ? { public_key: checked.publicKey } : {}),
      proof: checked.proof,
      payloadToken: active.payloadToken,
    });

    await deps.clearTonConnectLogin?.();
    session.auth.tonConnect = undefined;
    session.auth.available = true;
    session.auth.mode = "ton";
    session.auth.choice = "ton";
    session.auth.checked = true;
    session.auth.tonAddress = checked.walletAddress;
    session.auth.sessionToken = token;
    session.auth.sessionTokenExpiresAt = new Date(Date.now() + 50 * 60 * 1000).toISOString();
    await maybeHydrateStartupAuthStatus(session, { ...deps, client }, client);

    if (!session.auth.evmSigningKeyAvailable) {
      session.stage = "awaiting_evm_signing_key";
      session.status = "blocked";
      const followUp = ["TON login works via TonConnect.", buildEvmSigningKeyPrompt(session.auth.username)].filter(Boolean).join(" ");
      return reply(withUpdate(session, deps), followUp, undefined, [...prefixEvents, {
        type: "blocked_missing_auth",
        message: followUp,
      }]);
    }

    session.status = "active";
    session.stage = "resolving";
    const resumed = await advanceTransferFlow(session, { text: "" }, { ...deps, client });
    if (prefixEvents.length) {
      resumed.events = [...prefixEvents, ...resumed.events];
    }
    return resumed;
  } catch (error) {
    const prompt = `TonConnect approval came back, but UNIGOX login still failed.${error instanceof Error ? ` (${error.message})` : ""}`;
    session.stage = "awaiting_tonconnect_completion";
    session.status = "blocked";
    return reply(withUpdate(session, deps), prompt, ["connected", "TonConnect QR"], [...prefixEvents, {
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }
}

async function finalizeTonPrivateKey(
  session: TransferSession,
  tonPrivateKey: string,
  deps: TransferFlowDeps,
  prefixEvents: TransferFlowEvent[] = []
): Promise<TransferFlowResult> {
  session.auth.pendingSecret = undefined;
  const verification = await verifyTonLoginInput({ tonPrivateKey, tonAddress: session.auth.tonAddress }, deps);
  if (!verification.success) {
    session.stage = "awaiting_ton_private_key";
    const failure = `That TON wallet didn't verify. Please double-check the TON private key / secret key and the exact TON address used on UNIGOX, then try again.${verification.message ? ` (${verification.message})` : ""}`;
    return reply(withUpdate(session, deps), failure, undefined, [...prefixEvents, {
      type: "blocked_missing_auth",
      message: failure,
    }]);
  }

  if (session.auth.tonAddress) {
    await deps.persistTonAddress?.(session.auth.tonAddress);
  }
  if (verification.tonWalletVersion) {
    session.auth.tonWalletVersion = verification.tonWalletVersion;
    await deps.persistTonWalletVersion?.(verification.tonWalletVersion);
  }
  await deps.persistTonPrivateKey?.(tonPrivateKey);

  session.auth.available = true;
  session.auth.mode = "ton";
  session.auth.choice = "ton";
  session.auth.username = verification.username || session.auth.username;
  if (!session.auth.username) {
    await maybeHydrateAuthIdentity(session, deps);
  }

  if (!session.auth.evmSigningKeyAvailable) {
    session.stage = "awaiting_evm_signing_key";
    const followUp = ["TON login works.", buildEvmSigningKeyPrompt(session.auth.username)].filter(Boolean).join(" ");
    return reply(withUpdate(session, deps), followUp, undefined, [...prefixEvents, {
      type: "blocked_missing_auth",
      message: followUp,
    }]);
  }

  session.status = "active";
  session.stage = "resolving";
  const resumed = await advanceTransferFlow(session, { text: "" }, deps);
  if (prefixEvents.length) {
    resumed.events = [...prefixEvents, ...resumed.events];
  }
  return resumed;
}

async function finalizeGeneratedEvmWalletSetup(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient
): Promise<TransferFlowResult> {
  if (!client.generateAndLinkWallet) {
    session.stage = "awaiting_wallet_setup_choice";
    session.status = "blocked";
    const prompt = buildGeneratedWalletFailurePrompt("generated_evm", "This runtime cannot generate EVM wallets automatically yet.");
    return reply(withUpdate(session, deps), prompt, [...POST_EMAIL_WALLET_SETUP_OPTIONS], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  try {
    const generated = await client.generateAndLinkWallet();
    await deps.persistEvmLoginKey?.(generated.privateKey);

    session.auth.available = true;
    session.auth.mode = "evm";
    session.auth.choice = "generated_evm";
    session.auth.evmSigningKeyAvailable = false;
    if (!session.auth.username) {
      await maybeHydrateAuthIdentity(session, { ...deps, client }, client);
    }

    if (!session.auth.evmSigningKeyAvailable) {
      session.stage = "awaiting_evm_signing_key";
      session.status = "blocked";
      const followUp = buildGeneratedEvmWalletReadyPrompt(session.auth.username);
      return reply(withUpdate(session, deps), followUp, undefined, [{
        type: "blocked_missing_auth",
        message: followUp,
      }]);
    }

    session.status = "active";
    session.stage = "resolving";
    return advanceTransferFlow(session, { text: "" }, { ...deps, client });
  } catch (error) {
    session.stage = "awaiting_wallet_setup_choice";
    session.status = "blocked";
    const prompt = buildGeneratedWalletFailurePrompt("generated_evm", error instanceof Error ? error.message : String(error));
    return reply(withUpdate(session, deps), prompt, [...POST_EMAIL_WALLET_SETUP_OPTIONS], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }
}

async function finalizeGeneratedTonWalletSetup(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient
): Promise<TransferFlowResult> {
  if (!client.generateAndLinkTonWallet) {
    session.stage = "awaiting_wallet_setup_choice";
    session.status = "blocked";
    const prompt = buildGeneratedWalletFailurePrompt("generated_ton", "This runtime cannot generate TON wallets automatically yet.");
    return reply(withUpdate(session, deps), prompt, [...POST_EMAIL_WALLET_SETUP_OPTIONS], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  try {
    const generated = await client.generateAndLinkTonWallet();
    await deps.persistTonPrivateKey?.(generated.privateKey);
    await deps.persistTonAddress?.(generated.address);
    await deps.persistTonWalletVersion?.(generated.walletVersion);

    session.auth.available = true;
    session.auth.mode = "ton";
    session.auth.choice = "generated_ton";
    session.auth.tonAddress = generated.address;
    session.auth.tonAddressDisplay = generated.address;
    session.auth.tonWalletVersion = generated.walletVersion;
    if (!session.auth.username) {
      await maybeHydrateAuthIdentity(session, { ...deps, client }, client);
    }

    if (!session.auth.evmSigningKeyAvailable) {
      session.stage = "awaiting_evm_signing_key";
      session.status = "blocked";
      const followUp = buildGeneratedTonWalletReadyPrompt(session.auth.username);
      return reply(withUpdate(session, deps), followUp, undefined, [{
        type: "blocked_missing_auth",
        message: followUp,
      }]);
    }

    session.status = "active";
    session.stage = "resolving";
    return advanceTransferFlow(session, { text: "" }, { ...deps, client });
  } catch (error) {
    session.stage = "awaiting_wallet_setup_choice";
    session.status = "blocked";
    const prompt = buildGeneratedWalletFailurePrompt("generated_ton", error instanceof Error ? error.message : String(error));
    return reply(withUpdate(session, deps), prompt, [...POST_EMAIL_WALLET_SETUP_OPTIONS], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }
}

async function startEmailOtpFlow(
  session: TransferSession,
  deps: TransferFlowDeps,
  emailAddress: string
): Promise<TransferFlowResult> {
  const client = await getExecutionClient(deps, {
    ...session,
    auth: {
      ...session.auth,
      emailAddress,
      mode: "email",
    },
  });
  if (!client.requestEmailOTP) {
    session.stage = "awaiting_auth_choice";
    session.status = "blocked";
    return reply(
      withUpdate(session, deps),
      "This skill setup cannot send email OTP codes automatically yet. Please choose a wallet path instead.",
      [...AUTH_CHOICE_OPTIONS],
      [{
        type: "blocked_missing_auth",
        message: "Email OTP request is not available in this client setup.",
      }]
    );
  }
  try {
    await client.requestEmailOTP();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.stage = "awaiting_email_address";
    session.auth.emailAddress = emailAddress;
    session.status = "blocked";
    return reply(
      withUpdate(session, deps),
      `I couldn’t send the email OTP yet (${message}). Double-check the email address and send it again.`,
      undefined,
      [{
        type: "blocked_missing_auth",
        message,
      }]
    );
  }

  session.auth.emailAddress = emailAddress;
  session.auth.choice = session.auth.choice || "email";
  session.auth.mode = "email";
  session.status = "blocked";
  session.stage = "awaiting_email_otp";
  return reply(withUpdate(session, deps), buildEmailOtpPrompt(emailAddress), undefined, [{
    type: "blocked_missing_auth",
    message: buildEmailOtpPrompt(emailAddress),
  }]);
}

async function finalizeEmailOtpVerification(
  session: TransferSession,
  deps: TransferFlowDeps,
  client: TransferExecutionClient,
  emailAddress: string,
  otpCode: string
): Promise<TransferFlowResult> {
  if (!client.verifyEmailOTP) {
    session.stage = "awaiting_auth_choice";
    session.status = "blocked";
    return reply(
      withUpdate(session, deps),
      "This skill setup cannot verify email OTP codes automatically yet. Please choose a wallet path instead.",
      [...AUTH_CHOICE_OPTIONS],
      [{
        type: "blocked_missing_auth",
        message: "Email OTP verification is not available in this client setup.",
      }]
    );
  }
  try {
    const token = await client.verifyEmailOTP(otpCode);
    session.auth.available = true;
    session.auth.mode = "email";
    session.auth.choice = session.auth.choice || "email";
    session.auth.emailAddress = emailAddress;
    session.auth.emailAuthToken = token;
    session.auth.emailAuthTokenExpiresAt = new Date(Date.now() + 50 * 60 * 1000).toISOString();
    session.auth.sessionToken = token;
    session.auth.sessionTokenExpiresAt = session.auth.emailAuthTokenExpiresAt;
    session.auth.checked = true;
    await deps.persistEmailAddress?.(emailAddress);
    await maybeHydrateStartupAuthStatus(session, { ...deps, client }, client);

    if (session.auth.choice === "generated_evm") {
      const generated = await finalizeGeneratedEvmWalletSetup(session, deps, client);
      generated.events = [{
        type: "blocked_missing_auth",
        message: `Email OTP verified for ${emailAddress}.`,
      }, ...generated.events];
      return generated;
    }

    if (session.auth.choice === "generated_ton") {
      const generated = await finalizeGeneratedTonWalletSetup(session, deps, client);
      generated.events = [{
        type: "blocked_missing_auth",
        message: `Email OTP verified for ${emailAddress}.`,
      }, ...generated.events];
      return generated;
    }

    if (session.auth.choice === "email") {
      session.status = "blocked";
      session.stage = "awaiting_wallet_setup_choice";
      const prompt = buildWalletSetupChoicePrompt(emailAddress);
      return reply(withUpdate(session, deps), prompt, [...POST_EMAIL_WALLET_SETUP_OPTIONS], [{
        type: "blocked_missing_auth",
        message: `Email OTP verified for ${emailAddress}.`,
      }]);
    }

    session.status = "active";
    session.stage = "resolving";
    const resumed = await advanceTransferFlow(session, { text: "" }, { ...deps, client });
    resumed.events = [{
      type: "blocked_missing_auth",
      message: `Email OTP verified for ${emailAddress}.`,
    }, ...resumed.events];
    return resumed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.stage = "awaiting_email_otp";
    session.status = "blocked";
    return reply(
      withUpdate(session, deps),
      `That OTP code didn’t work (${message}). ${buildEmailOtpPrompt(emailAddress)}`,
      undefined,
      [{
        type: "blocked_missing_auth",
        message,
      }]
    );
  }
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
      return reply(withUpdate(session, deps), getUnigoxWalletConnectionPrompt(), [...AUTH_CHOICE_OPTIONS], [{
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

    const normalizedSecret = await normalizeSecretInput(pendingSecret.kind, pendingSecret.value);
    if (!normalizedSecret) {
      session.auth.pendingSecret = undefined;
      restoreStageForSecretKind(session, pendingSecret.kind);
      const prompt = pendingSecret.kind === "evm_login_key"
        ? buildInvalidEvmKeyPrompt("evm_login_key")
        : pendingSecret.kind === "evm_signing_key"
          ? buildInvalidEvmKeyPrompt("evm_signing_key", session.auth.username)
          : buildInvalidTonMnemonicPrompt(session.auth.tonAddress || getStoredTonAddress(deps));
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (pendingSecret.kind === "evm_login_key") {
      return finalizeEvmLoginKey(session, normalizedSecret, deps);
    }
    if (pendingSecret.kind === "ton_private_key") {
      return finalizeTonPrivateKey(session, normalizedSecret, deps);
    }
    if (pendingSecret.kind === "ton_mnemonic") {
      return finalizeTonMnemonic(session, normalizedSecret, deps);
    }
    return finalizeEvmSigningKey(session, normalizedSecret, deps);
  }

  if (session.stage === "awaiting_wallet_setup_choice") {
    session.status = "blocked";
    const choice = hintedChoice;
    const emailAddress = session.auth.emailAddress || getStoredEmailAddress(deps);
    if (!emailAddress || !session.auth.sessionToken) {
      session.stage = "awaiting_email_address";
      const prompt = buildEmailAddressPrompt(emailAddress);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const client = await getExecutionClient(deps, {
      ...session,
      auth: {
        ...session.auth,
        emailAddress,
        mode: "email",
      },
    });

    if (choice === "generated_evm") {
      return finalizeGeneratedEvmWalletSetup(session, deps, client);
    }

    if (choice === "generated_ton") {
      return finalizeGeneratedTonWalletSetup(session, deps, client);
    }

    if (choice === "evm") {
      session.stage = "awaiting_evm_wallet_signin";
      const prompt = "Before I ask for any key: have you already signed in on unigox.com with that EVM wallet? If not, please do that first, then tell me once it’s done. After that I’ll ask which login wallet key you used.";
      return reply(withUpdate(session, deps), prompt, ["I signed in", "Create dedicated EVM wallet", "Create dedicated TON wallet", "TON wallet connection", "email OTP"], [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (choice === "ton") {
      const storedTonAddress = getStoredTonAddress(deps);
      session.auth.tonAddress = storedTonAddress || session.auth.tonAddress;
      session.auth.tonAddressDisplay = storedTonAddress || session.auth.tonAddressDisplay;
      session.stage = storedTonAddress ? "awaiting_ton_address_confirmation" : "awaiting_ton_address";
      const prompt = storedTonAddress ? buildTonAddressConfirmationPrompt(session.auth.tonAddressDisplay || storedTonAddress) : buildTonAddressPrompt();
      return reply(withUpdate(session, deps), prompt, ["this address is correct", "use a different TON address"], [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (choice === "email") {
      if (!session.auth.evmSigningKeyAvailable) {
        session.stage = "awaiting_evm_signing_key";
        const prompt = buildEmailOtpOnlyReadyPrompt(session.auth.username);
        return reply(withUpdate(session, deps), prompt, undefined, [{
          type: "blocked_missing_auth",
          message: prompt,
        }]);
      }

      session.status = "active";
      session.stage = "resolving";
      return advanceTransferFlow(session, { text: "" }, { ...deps, client });
    }

    const prompt = buildWalletSetupChoicePrompt(emailAddress);
    return reply(withUpdate(session, deps), prompt, [...POST_EMAIL_WALLET_SETUP_OPTIONS], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  if (session.stage === "awaiting_evm_wallet_signin") {
    session.status = "blocked";

    if (hintedChoice === "ton" || hintedChoice === "email" || hintedChoice === "generated_evm" || hintedChoice === "generated_ton") {
      session.auth.choice = hintedChoice;
      if (hintedChoice === "ton") {
        const storedTonAddress = getStoredTonAddress(deps);
        session.auth.tonAddress = storedTonAddress || session.auth.tonAddress;
        session.auth.tonAddressDisplay = storedTonAddress || session.auth.tonAddressDisplay;
        session.stage = storedTonAddress ? "awaiting_ton_address_confirmation" : "awaiting_ton_address";
        const followUp = storedTonAddress ? buildTonAddressConfirmationPrompt(session.auth.tonAddressDisplay || storedTonAddress) : buildTonAddressPrompt();
        return reply(withUpdate(session, deps), followUp, ["this address is correct", "use a different TON address"], [{
          type: "blocked_missing_auth",
          message: followUp,
        }]);
      }

      if (hintedChoice === "generated_evm" || hintedChoice === "generated_ton") {
        const storedEmail = session.auth.emailAddress || getStoredEmailAddress(deps);
        if (storedEmail) {
          return startEmailOtpFlow(session, deps, storedEmail);
        }
        session.stage = "awaiting_email_address";
        const followUp = buildEmailAddressPrompt();
        return reply(withUpdate(session, deps), followUp, undefined, [{
          type: "blocked_missing_auth",
          message: followUp,
        }]);
      }

      const storedEmail = session.auth.emailAddress || getStoredEmailAddress(deps);
      if (storedEmail) {
        return startEmailOtpFlow(session, deps, storedEmail);
      }
      session.stage = "awaiting_email_address";
      const followUp = buildEmailAddressPrompt();
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
    return reply(withUpdate(session, deps), reminder, ["I signed in", "Create dedicated EVM wallet", "Create dedicated TON wallet", "TON wallet connection", "email OTP"], [{
      type: "blocked_missing_auth",
      message: reminder,
    }]);
  }

  if (session.stage === "awaiting_email_address") {
    session.status = "blocked";
    const emailAddress = parseEmailAddress(responseText) || session.auth.emailAddress || getStoredEmailAddress(deps);
    if (!emailAddress) {
      const prompt = buildEmailAddressPrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }
    return startEmailOtpFlow(session, deps, emailAddress);
  }

  if (session.stage === "awaiting_email_otp") {
    session.status = "blocked";
    const emailAddress = session.auth.emailAddress || getStoredEmailAddress(deps);
    if (!emailAddress) {
      session.stage = "awaiting_email_address";
      const prompt = buildEmailAddressPrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const otpCode = parseOtpCode(responseText);
    if (!otpCode) {
      const prompt = buildEmailOtpPrompt(emailAddress);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const client = await getExecutionClient(deps, {
      ...session,
      auth: {
        ...session.auth,
        emailAddress,
        mode: "email",
      },
    });
    return finalizeEmailOtpVerification(session, deps, client, emailAddress, otpCode);
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

    const loginKey = parseEvmPrivateKey(responseText);
    if (!loginKey) {
      const prompt = looksLikeEvmAddress(responseText)
        ? buildAddressInsteadOfPrivateKeyPrompt("evm_login_key")
        : buildInvalidEvmKeyPrompt("evm_login_key");
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const secretHandling = await maybeHandleSensitiveInput(session, "evm_login_key", loginKey, turn, deps);
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
    return finalizeEvmLoginKey(session, loginKey, deps, events);
  }

  if (session.stage === "awaiting_ton_address") {
    session.status = "blocked";
    const parsedTonAddress = parseTonAddressInput(responseText);
    const tonAddress = parsedTonAddress?.raw || session.auth.tonAddress || getStoredTonAddress(deps);
    const tonAddressDisplay = parsedTonAddress?.display || session.auth.tonAddressDisplay || tonAddress;
    if (!tonAddress) {
      const prompt = buildTonAddressPrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    session.auth.choice = "ton";
    session.auth.mode = "ton";
    session.auth.tonAddress = tonAddress;
    session.auth.tonAddressDisplay = tonAddressDisplay;
    session.stage = "awaiting_ton_address_confirmation";
    const prompt = buildTonAddressConfirmationPrompt(tonAddressDisplay);
    return reply(withUpdate(session, deps), prompt, ["this address is correct", "use a different TON address"], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  if (session.stage === "awaiting_ton_address_confirmation") {
    session.status = "blocked";
    const replacementAddress = parseTonAddressInput(responseText);
    if (replacementAddress && replacementAddress.raw !== session.auth.tonAddress) {
      session.auth.tonAddress = replacementAddress.raw;
      session.auth.tonAddressDisplay = replacementAddress.display;
      const prompt = buildTonAddressConfirmationPrompt(replacementAddress.display);
      return reply(withUpdate(session, deps), prompt, ["this address is correct", "use a different TON address"], [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (AFFIRMATIVE_RE.test(responseText) || /correct|this address is correct|use this address/i.test(responseText)) {
      session.stage = "awaiting_ton_auth_method";
      const prompt = buildTonAuthMethodPrompt(session.auth.tonAddressDisplay || session.auth.tonAddress!);
      return reply(withUpdate(session, deps), prompt, ["send TON mnemonic", "send TON private key", "TonConnect QR"], [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (NO_RE.test(responseText) || /different|change|another/i.test(responseText)) {
      session.stage = "awaiting_ton_address";
      const prompt = "Okay. Send the exact TON address shown by the wallet you used on UNIGOX, and I’ll use that exact address instead.";
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const prompt = buildTonAddressConfirmationPrompt(session.auth.tonAddressDisplay || session.auth.tonAddress!);
    return reply(withUpdate(session, deps), prompt, ["this address is correct", "use a different TON address"], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  if (session.stage === "awaiting_ton_auth_method") {
    session.status = "blocked";
    const tonAddress = session.auth.tonAddress || getStoredTonAddress(deps);
    const tonAddressDisplay = session.auth.tonAddressDisplay || tonAddress;
    if (!tonAddress) {
      session.stage = "awaiting_ton_address";
      const prompt = buildTonAddressPrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const explicitMethod = chooseTonCredentialMethod(responseText);
    if (explicitMethod === "tonconnect") {
      return startTonConnectLoginFlow(session, deps);
    }

    const mnemonic = await normalizeSecretInput("ton_mnemonic", responseText);
    if (mnemonic) {
      const secretHandling = await maybeHandleSensitiveInput(session, "ton_mnemonic", mnemonic, turn, deps);
      if (secretHandling.needsManualCleanup) {
        const prompt = buildSecretCleanupPrompt(session.auth.pendingSecret!);
        return reply(withUpdate(session, deps), prompt, ["deleted"], [{
          type: "secret_cleanup_required",
          message: prompt,
        }]);
      }

      const events = secretHandling.deleted
        ? [{ type: "secret_message_deleted", message: secretHandling.note || "Deleted the TON mnemonic message from chat." } as TransferFlowEvent]
        : [];
      return finalizeTonMnemonic(session, mnemonic, deps, events);
    }

    const tonPrivateKey = await normalizeSecretInput("ton_private_key", responseText);
    if (tonPrivateKey) {
      const secretHandling = await maybeHandleSensitiveInput(session, "ton_private_key", tonPrivateKey, turn, deps);
      if (secretHandling.needsManualCleanup) {
        const prompt = buildSecretCleanupPrompt(session.auth.pendingSecret!);
        return reply(withUpdate(session, deps), prompt, ["deleted"], [{
          type: "secret_cleanup_required",
          message: prompt,
        }]);
      }

      const events = secretHandling.deleted
        ? [{ type: "secret_message_deleted", message: secretHandling.note || "Deleted the TON private-key message from chat." } as TransferFlowEvent]
        : [];
      return finalizeTonPrivateKey(session, tonPrivateKey, deps, events);
    }

    if (explicitMethod === "mnemonic") {
      session.stage = "awaiting_ton_mnemonic";
      const prompt = buildTonMnemonicPrompt(tonAddressDisplay);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (explicitMethod === "private_key") {
      session.stage = "awaiting_ton_private_key";
      const prompt = buildTonPrivateKeyPrompt(tonAddressDisplay);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const prompt = buildTonAuthMethodPrompt(tonAddressDisplay);
    return reply(withUpdate(session, deps), prompt, ["send TON mnemonic", "send TON private key", "TonConnect QR"], [{
      type: "blocked_missing_auth",
      message: prompt,
    }]);
  }

  if (session.stage === "awaiting_ton_mnemonic") {
    session.status = "blocked";
    const tonAddress = session.auth.tonAddress || getStoredTonAddress(deps);
    if (!tonAddress) {
      session.stage = "awaiting_ton_address";
      const prompt = buildTonAddressPrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const mnemonic = await normalizeSecretInput("ton_mnemonic", responseText);
    if (!mnemonic) {
      const prompt = buildInvalidTonMnemonicPrompt(tonAddress);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const secretHandling = await maybeHandleSensitiveInput(session, "ton_mnemonic", mnemonic, turn, deps);
    if (secretHandling.needsManualCleanup) {
      const prompt = buildSecretCleanupPrompt(session.auth.pendingSecret!);
      return reply(withUpdate(session, deps), prompt, ["deleted"], [{
        type: "secret_cleanup_required",
        message: prompt,
      }]);
    }

    const events = secretHandling.deleted
      ? [{ type: "secret_message_deleted", message: secretHandling.note || "Deleted the TON mnemonic message from chat." } as TransferFlowEvent]
      : [];
    return finalizeTonMnemonic(session, mnemonic, deps, events);
  }

  if (session.stage === "awaiting_ton_private_key") {
    session.status = "blocked";
    const tonAddress = session.auth.tonAddress || getStoredTonAddress(deps);
    if (!tonAddress) {
      session.stage = "awaiting_ton_address";
      const prompt = buildTonAddressPrompt();
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    if (chooseTonCredentialMethod(responseText) === "tonconnect") {
      return startTonConnectLoginFlow(session, deps);
    }

    const tonPrivateKey = await normalizeSecretInput("ton_private_key", responseText);
    if (!tonPrivateKey) {
      const prompt = buildInvalidTonPrivateKeyPrompt(tonAddress);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const secretHandling = await maybeHandleSensitiveInput(session, "ton_private_key", tonPrivateKey, turn, deps);
    if (secretHandling.needsManualCleanup) {
      const prompt = buildSecretCleanupPrompt(session.auth.pendingSecret!);
      return reply(withUpdate(session, deps), prompt, ["deleted"], [{
        type: "secret_cleanup_required",
        message: prompt,
      }]);
    }

    const events = secretHandling.deleted
      ? [{ type: "secret_message_deleted", message: secretHandling.note || "Deleted the TON private-key message from chat." } as TransferFlowEvent]
      : [];
    return finalizeTonPrivateKey(session, tonPrivateKey, deps, events);
  }

  if (session.stage === "awaiting_tonconnect_completion") {
    session.status = "blocked";
    if (chooseTonCredentialMethod(responseText) === "tonconnect") {
      return startTonConnectLoginFlow(session, deps);
    }
    return finalizeTonConnectLogin(session, deps);
  }

  if (session.stage === "awaiting_evm_signing_key" && !session.auth.evmSigningKeyAvailable) {
    session.status = "blocked";
    const tonConnectBrowserLogin = await tryApproveProvidedTonConnectBrowserLink(session, turn, deps);
    if (tonConnectBrowserLogin) {
      return tonConnectBrowserLogin;
    }

    if (!responseText || SIGNIN_READY_RE.test(responseText) || NOT_READY_RE.test(responseText)) {
      const prompt = buildMissingSigningKeyPrompt(session.auth.username);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const signingKey = parseEvmPrivateKey(responseText);
    if (!signingKey) {
      const prompt = looksLikeEvmAddress(responseText)
        ? buildAddressInsteadOfPrivateKeyPrompt("evm_signing_key", session.auth.username)
        : buildInvalidEvmKeyPrompt("evm_signing_key", session.auth.username);
      return reply(withUpdate(session, deps), prompt, undefined, [{
        type: "blocked_missing_auth",
        message: prompt,
      }]);
    }

    const secretHandling = await maybeHandleSensitiveInput(session, "evm_signing_key", signingKey, turn, deps);
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
    return finalizeEvmSigningKey(session, signingKey, deps, events);
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
  const detailBlock = buildHumanDetailBlock(session.details);
  return [
    buildUsernameReminder(session.auth.username),
    balanceLine,
    buildPreflightQuoteSummary(session.execution.preflight),
    buildAssetCoverageLine(session.execution.preflight),
    buildPreflightQuoteCaveat(session.execution.preflight),
    `Send ${session.amount} ${session.currency} to ${session.recipientName} via ${summarizePayment(session)}?`,
    detailBlock,
    "Reply 'confirm' to place the trade, or tell me what to change.",
  ].filter(Boolean).join("\n\n");
}

function getProjectedTradeUsd(session: TransferSession): number {
  return session.execution.preflight?.sellAssetRequiredUsd
    ?? session.execution.preflight?.quote?.totalCryptoAmount
    ?? session.amount
    ?? 0;
}

function buildKycRequirementMessage(session: TransferSession): string {
  const projectedTotal = (session.auth.totalTradedVolumeUsd || 0) + getProjectedTradeUsd(session);
  const projectedLine = projectedTotal > 0
    ? `This transfer would bring your no-KYC volume to about ${formatFixed(projectedTotal, 2)} USD, and UNIGOX only allows up to ${formatFixed(MAX_AMOUNT_WITHOUT_KYC, 2)} USD without verification.`
    : `UNIGOX only allows up to ${formatFixed(MAX_AMOUNT_WITHOUT_KYC, 2)} USD without verification.`;
  return [
    `To continue with this ${session.amount ? `${session.amount} ${session.currency}` : "transfer"}, UNIGOX needs KYC first.`,
    projectedLine,
    "The steps are simple:",
    "1. You give me your full name and country.",
    "2. I give you a secure link for the third-party KYC service. You can also complete the same KYC directly in the UNIGOX website or app if you prefer.",
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

function buildKycPendingMessage(session: TransferSession): string {
  const projectedTotal = (session.auth.totalTradedVolumeUsd || 0) + getProjectedTradeUsd(session);
  const projectedLine = projectedTotal > 0
    ? `This transfer would bring your no-KYC volume to about ${formatFixed(projectedTotal, 2)} USD, and UNIGOX only allows up to ${formatFixed(MAX_AMOUNT_WITHOUT_KYC, 2)} USD without verification.`
    : `UNIGOX only allows up to ${formatFixed(MAX_AMOUNT_WITHOUT_KYC, 2)} USD without verification.`;
  return [
    `To continue with this ${session.amount ? `${session.amount} ${session.currency}` : "transfer"}, UNIGOX needs KYC first.`,
    projectedLine,
  ].join(" ");
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
      : "UNIGOX has started the verification, but the secure link still has not appeared yet. This can take a little longer on the provider side. If it still does not show up, message me again and I’ll re-check immediately, and you can also open KYC directly in the UNIGOX website or app if you prefer.",
    "If you prefer, you can also complete the same KYC directly from the UNIGOX website or app.",
    "Once UNIGOX shows the verification as approved, message me here and I’ll continue the transfer.",
  ].filter(Boolean).join(" ");
}

function kycVerificationHasAuthFailure(data: KycVerificationData | undefined): boolean {
  return Boolean(data?.error_key && KYC_AUTH_FAILURE_KEYS.has(data.error_key));
}

function buildKycVerificationAuthFailureMessage(session: TransferSession): string {
  return [
    buildKycRequirementMessage(session),
    "I couldn't fetch the secure verification link from chat on this machine right now.",
    "Please open KYC directly in the UNIGOX website or app and complete it there.",
    "Once UNIGOX shows the verification as approved, message me here and I’ll continue the transfer.",
  ].join(" ");
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
  if (kycVerificationHasAuthFailure(resolvedVerification)) {
    return reply(withUpdate(session, deps), buildKycVerificationAuthFailureMessage(session));
  }
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

  const projectedTradeUsd = getProjectedTradeUsd(session);
  const totalTradedVolumeUsd = session.auth.totalTradedVolumeUsd || 0;
  if (!(projectedTradeUsd > 0) || projectedTradeUsd + totalTradedVolumeUsd < MAX_AMOUNT_WITHOUT_KYC) {
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
      if (kycVerificationHasAuthFailure(verification)) {
        session.status = "blocked";
        session.execution.confirmed = false;
        session.stage = "awaiting_kyc_completion";
        return {
          blockedResult: reply(
            withUpdate(session, deps),
            buildKycVerificationAuthFailureMessage(session)
          ),
        };
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

    if (kycVerificationHasAuthFailure(verification)) {
      session.status = "blocked";
      session.execution.confirmed = false;
      session.stage = "awaiting_kyc_completion";
      return reply(withUpdate(session, deps), buildKycVerificationAuthFailureMessage(session));
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

function toStoredPaymentMethod(detail: PaymentDetail): StoredPaymentMethod | undefined {
  if (!detail.payment_method?.id || !detail.payment_network?.id) return undefined;
  const methodName = cleanText(detail.payment_method.name);
  const networkName = cleanText(detail.payment_network.name);
  if (!methodName || !networkName) return undefined;
  return {
    method: methodName,
    methodId: detail.payment_method.id,
    methodSlug: detail.payment_method.slug,
    networkId: detail.payment_network.id,
    network: networkName,
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
        paymentDetailsId: diff.payment_details_id || session.execution.paymentDetailsId || 0,
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
    && currentTrade?.escrow_address
  ) {
    const funding = await client.fundTradeEscrow(matchedAssetCode, matchedFundingAmount, currentTrade.escrow_address);
    events.push({
      type: "escrow_funding_submitted",
      message: `Submitted ${matchedFundingAmount} ${matchedAssetCode} to the trade escrow address for trade #${matched.trade.id}.`,
      data: {
        tradeId: matched.trade.id,
        tradeRequestId: matched.id,
        assetCode: matchedAssetCode,
        amount: matchedFundingAmount,
        escrowAddress: currentTrade.escrow_address,
        txId: funding.txId,
        txHash: funding.txHash,
      },
    });

    if (client.getTrade) {
      const fundedTrade = await client.getTrade(matched.trade.id);
      if (fundedTrade) {
        currentTrade = fundedTrade;
        session.execution.tradeStatus = fundedTrade.status;
        session.execution.settlement = createInitialSettlementState({
          tradeRequestId: matched.id,
          tradeRequestStatus: matched.status,
          tradeId: fundedTrade.id,
          tradeStatus: fundedTrade.status,
        });
      }
    }
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
  const snapshot = mode === "poll"
    ? await pollSettlementSnapshot(state, client, settlementMonitorOptions(deps, overrides))
    : await refreshSettlementSnapshot(state, client, settlementMonitorOptions(deps, overrides));
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
    const parsed = parseAmountAndCurrency(selectionText);
    const wantsRefresh = wantsBalanceRecheck(selectionText) || looksLikeTopUpCompletion(selectionText) || Boolean(parsed.amount);
    if (wantsRefresh) {
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
    if (methodChoice === "internal_username") {
      const client = await getExecutionClient(deps, session);
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

    if (methodChoice === "external_deposit") {
      const client = await getExecutionClient(deps, session);
      if (!client.getSupportedDepositOptions) {
        throw new Error("This UNIGOX client cannot load supported deposit options for external top-ups.");
      }
      const options = await client.getSupportedDepositOptions();
      session.status = "blocked";
      session.topUp = { method: methodChoice };
      session.stage = "awaiting_external_deposit_asset";
      return reply(withUpdate(session, deps), buildExternalDepositAssetPrompt(options), options.map((option) => option.assetCode));
    }

    const parsed = parseAmountAndCurrency(selectionText);
    const wantsRefresh = wantsBalanceRecheck(selectionText) || looksLikeTopUpCompletion(selectionText) || Boolean(parsed.amount);
    if (wantsRefresh) {
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
      if (preflight.blockedResult) {
        return preflight.blockedResult;
      }
      session.status = "active";
      session.topUp = undefined;
      session.stage = "awaiting_confirmation";
      return reply(withUpdate(session, deps), buildConfirmationMessage(session), undefined, preflight.events);
    }

    if (!methodChoice) {
      return reply(
        withUpdate(session, deps),
        buildTopUpMethodPrompt(session.auth.username),
        ["another UNIGOX user sends to my username", "external / on-chain deposit", "change amount"]
      );
    }
  }

  const client = await getExecutionClient(deps, session);
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
      trade_type: "SELL",
    },
    session,
    session.execution.preflight?.quote?.totalCryptoAmount || session.amount || 0
  );

  if (
    currentTrade?.id
    && tradeCanFundEscrow(currentTrade, currentTrade.status)
    && client.fundTradeEscrow
    && !tradeNeedsBuyerPaymentDetails(currentTrade)
    && currentTrade.escrow_address
  ) {
    const funding = await client.fundTradeEscrow(matchedAssetCode, matchedFundingAmount, currentTrade.escrow_address);
    events.push({
      type: "escrow_funding_submitted",
      message: `Submitted ${matchedFundingAmount} ${matchedAssetCode} to the trade escrow address for trade #${currentTrade.id}.`,
      data: {
        tradeId: currentTrade.id,
        tradeRequestId: collection.tradeRequestId,
        assetCode: matchedAssetCode,
        amount: matchedFundingAmount,
        escrowAddress: currentTrade.escrow_address,
        txId: funding.txId,
        txHash: funding.txHash,
      },
    });

    if (client.getTrade) {
      const fundedTrade = await client.getTrade(currentTrade.id);
      if (fundedTrade) {
        currentTrade = fundedTrade;
        session.execution.tradeStatus = fundedTrade.status;
        session.execution.settlement = createInitialSettlementState({
          tradeRequestId: collection.tradeRequestId,
          tradeRequestStatus: session.execution.tradeRequestStatus,
          tradeId: fundedTrade.id,
          tradeStatus: fundedTrade.status,
        });
      }
    }
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
  const parsedIdentity = parseKycIdentityInput(text);

  if (session.stage === "awaiting_kyc_full_name") {
    const fullName = parsedIdentity.fullName || text?.trim();
    if (!fullName) {
      return reply(
        withUpdate(session, deps),
        `${buildKycRequirementMessage(session)} First, what full legal name should I use for the verification?`
      );
    }
    const words = fullName.split(/\s+/).filter(Boolean);
    if (words.length < 2) {
      return reply(
        withUpdate(session, deps),
        `${buildKycRequirementMessage(session)} Please send the full legal name with at least first and last name.`
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
      return reply(withUpdate(session, deps), buildKycCountryPrompt(session));
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

  if (kycVerificationHasAuthFailure(verification)) {
    return reply(withUpdate(session, deps), buildKycVerificationAuthFailureMessage(session));
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

async function maybeHandlePendingPriceChangeTurn(
  session: TransferSession,
  turn: TransferTurn,
  deps: TransferFlowDeps
): Promise<TransferFlowResult | undefined> {
  if (session.stage !== "awaiting_new_price_confirmation" || !session.execution.tradeRequestId) return undefined;

  const responseText = cleanText(turn.option || turn.text);
  const wantsConfirm = /^(confirm(?: new price)?|accept(?: new price)?|go ahead|proceed|continue)$/i.test(responseText);
  const wantsCancel = /^(cancel|stop|reject(?: new price)?|decline)$/i.test(responseText);
  const client = await getExecutionClient(deps, session);
  const tradeRequestId = session.execution.tradeRequestId;
  const quotedCryptoAmount = session.execution.preflight?.quote?.totalCryptoAmount || session.amount || 0;
  const sellAssetCode = session.execution.preflight?.selectedAssetCode
    || session.execution.preflight?.quote?.cryptoCurrencyCode
    || "USDC";
  const events: TransferFlowEvent[] = [];

  const latest = client.getTradeRequest ? await client.getTradeRequest(tradeRequestId) : undefined;
  if (latest?.status) {
    session.execution.tradeRequestStatus = latest.status;
  }

  if (latest?.status === "accepted_by_vendor" && latest.trade?.id) {
    return continueFromMatchedTradeRequest(session, deps, client, latest, events, sellAssetCode, quotedCryptoAmount);
  }

  if (latest?.status === "new_price_refused_by_initiator" || latest?.status === "canceled_by_initiator") {
    clearPendingPriceChange(session);
    session.stage = "awaiting_no_match_resolution";
    session.status = "active";
    return reply(
      withUpdate(session, deps),
      "That updated quote has already been cancelled. You can retry, change the method, or change the currency.",
      ["retry", "change method", "change currency", "change amount"],
      events
    );
  }

  if (!wantsConfirm && !wantsCancel) {
    if (latest?.status === "new_price_confirming_by_initiator") {
      capturePendingPriceChange(session, latest);
    }
    return reply(
      withUpdate(session, deps),
      buildNewPriceConfirmationMessage(session, latest),
      ["confirm new price", "cancel"],
      events
    );
  }

  if (wantsCancel) {
    if (client.refuseTradeRequestPrice) {
      const refused = await client.refuseTradeRequestPrice(tradeRequestId);
      session.execution.tradeRequestStatus = refused.status;
    }
    clearPendingPriceChange(session);
    session.stage = "awaiting_no_match_resolution";
    session.status = "active";
    events.push({
      type: "trade_price_change_cancelled",
      message: `Cancelled the updated quote for trade request #${tradeRequestId}.`,
      data: { tradeRequestId },
    });
    return reply(
      withUpdate(session, deps),
      "Okay, I cancelled that updated quote. If you want, I can retry the transfer, change the method, or change the currency.",
      ["retry", "change method", "change currency", "change amount"],
      events
    );
  }

  if (!client.confirmTradeRequestPrice) {
    return reply(
      withUpdate(session, deps),
      "This setup cannot confirm a changed vendor price yet. Please cancel this request or retry the transfer.",
      ["cancel", "retry"],
      events
    );
  }

  const confirmed = await client.confirmTradeRequestPrice(tradeRequestId);
  session.execution.tradeRequestStatus = confirmed.status;
  clearPendingPriceChange(session);
  events.push({
    type: "trade_price_change_confirmed",
    message: `Confirmed the updated quote for trade request #${tradeRequestId}.`,
    data: { tradeRequestId, status: confirmed.status },
  });

  const resolved = confirmed.trade?.id || confirmed.status === "accepted_by_vendor"
    ? confirmed
    : await client.waitForTradeMatch(tradeRequestId, deps.waitForMatchTimeoutMs || 120_000);

  if (resolved.status === "new_price_confirming_by_initiator") {
    capturePendingPriceChange(session, resolved);
    session.stage = "awaiting_new_price_confirmation";
    return reply(
      withUpdate(session, deps),
      buildNewPriceConfirmationMessage(session, resolved),
      ["confirm new price", "cancel"],
      events
    );
  }

  return continueFromMatchedTradeRequest(session, deps, client, resolved, events, sellAssetCode, quotedCryptoAmount);
}

async function maybeHandleStatusRequest(session: TransferSession, hints: ParsedHints, deps: TransferFlowDeps): Promise<TransferFlowResult | undefined> {
  if (!hints.checkStatus || !session.execution.tradeRequestId) return undefined;

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

  const client = await getExecutionClient(deps, session);
  let tradeRequest: TradeRequest | undefined;
  if (client.getTradeRequest) {
    tradeRequest = await client.getTradeRequest(session.execution.tradeRequestId);
    session.execution.tradeRequestStatus = tradeRequest.status;
    if (tradeRequest.trade?.id) session.execution.tradeId = tradeRequest.trade.id;
    if (tradeRequest.status === "new_price_confirming_by_initiator") {
      capturePendingPriceChange(session, tradeRequest);
      session.stage = "awaiting_new_price_confirmation";
      session.status = "active";
      return reply(
        withUpdate(session, deps),
        buildNewPriceConfirmationMessage(session, tradeRequest),
        ["confirm new price", "cancel"]
      );
    }
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
    invalidateBalanceState(session);
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
  session.auth.walletBalance = balance;

  let paymentDetailsId: number | undefined;
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

  const assetCoverageState = await buildAssetCoverageState({
    client,
    balance,
    amount,
    paymentDetailsId: paymentDetail.id,
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
    session.topUp = undefined;
    session.stage = "awaiting_topup_method";
    const message = [
      buildUsernameReminder(session.auth.username),
      buildWalletBalanceLine(balance, balance.totalUsd),
      buildPreflightQuoteSummary(session.execution.preflight),
      buildAssetCoverageLine(session.execution.preflight),
      buildTopUpShortfallLine(session.execution.preflight),
      quote
        ? "Until one asset covers that current estimate on its own, I will not place the trade."
        : `Until one asset covers the requested ${amount} ${session.currency} on its own, I will not place the trade.`,
      buildPreflightQuoteCaveat(session.execution.preflight),
      buildTopUpMethodPrompt(session.auth.username),
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
  const client = await getExecutionClient(deps, session);
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
  const sellAssetCode = session.execution.preflight?.selectedAssetCode || session.execution.preflight?.quote?.cryptoCurrencyCode || "USDC";
  let tradeRequest: TradeRequest;
  try {
    tradeRequest = await client.createTradeRequest({
      tradeType: "SELL",
      cryptoCurrencyCode: sellAssetCode,
      fiatCurrencyCode: session.currency!,
      fiatAmount: amount,
      cryptoAmount: quotedCryptoAmount,
      paymentDetailsId,
      paymentMethodId: session.payment!.methodId,
      paymentNetworkId: session.payment!.networkId,
      tradePartner: settings.tradePartner,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/kyc_verification_needed/i.test(message)) {
      session.execution.confirmed = false;
      const kycCheck = await maybeEnsureKycReady(session, deps, client);
      if (kycCheck.blockedResult) {
        return kycCheck.blockedResult;
      }
      return startKycVerificationFlow(session, deps, client);
    }
    throw error;
  }

  session.execution.tradeRequestId = tradeRequest.id;
  session.execution.tradeRequestStatus = tradeRequest.status;
  events.push({
    type: "trade_request_created",
    message: `Created trade request #${tradeRequest.id}.`,
    data: { tradeRequestId: tradeRequest.id, status: tradeRequest.status },
  });

  try {
    const matched = await client.waitForTradeMatch(tradeRequest.id, deps.waitForMatchTimeoutMs || 120_000);
    if (matched.status === "new_price_confirming_by_initiator") {
      capturePendingPriceChange(session, matched);
      session.stage = "awaiting_new_price_confirmation";
      session.status = "active";
      events.push({
        type: "trade_price_changed",
        message: `Trade request #${matched.id} needs a new price confirmation before funding.`,
        data: {
          tradeRequestId: matched.id,
          newFiatAmount: matched.fiat_amount,
          newCryptoAmount: matched.total_crypto_amount,
          originalFiatAmount: matched.best_deal_fiat_amount || session.amount,
          originalCryptoAmount: matched.best_deal_crypto_amount || quotedCryptoAmount,
        },
      });
      return reply(
        withUpdate(session, deps),
        buildNewPriceConfirmationMessage(session, matched),
        ["confirm new price", "cancel"],
        events
      );
    }

    return continueFromMatchedTradeRequest(session, deps, client, matched, events, sellAssetCode, quotedCryptoAmount);
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
  if (["awaiting_auth_choice", "awaiting_email_address", "awaiting_email_otp", "awaiting_wallet_setup_choice", "awaiting_evm_wallet_signin", "awaiting_evm_login_key", "awaiting_evm_signing_key", "awaiting_ton_address", "awaiting_ton_address_confirmation", "awaiting_ton_auth_method", "awaiting_ton_private_key", "awaiting_ton_mnemonic", "awaiting_tonconnect_completion", "awaiting_secret_cleanup_confirmation", "awaiting_saved_recipient_confirmation"].includes(inputSession.stage)) {
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

  await maybeRefreshStoredAuthState(session, deps);

  if (!handledSavedRecipientDecision) {
    const outstandingReminderReply = await maybeHandleOutstandingTradeReminderTurn(session, normalizedTurn, deps);
    if (outstandingReminderReply) return outstandingReminderReply;
  }

  const authOnboardingReply = await maybeHandleAuthOnboardingTurn(session, normalizedTurn, deps);
  if (authOnboardingReply) return authOnboardingReply;

  const kycReply = await maybeHandleKycTurn(session, normalizedTurn, deps);
  if (kycReply) return kycReply;

  applyHintsToSession(session, stageAwareHints);
  applyMidFlowChanges(session, hints);

  const topUpReply = await maybeHandleTopUpTurn(session, normalizedTurn, deps);
  if (topUpReply) return topUpReply;

  if (session.goal === "transfer" && !session.auth.available) {
    session.status = "blocked";
    session.stage = "awaiting_auth_choice";
    if (hints.authChoice) {
      session.auth.choice = hints.authChoice;
      if (hints.authChoice === "evm") {
        const followUp = "Before I ask for any key: have you already signed in on unigox.com with that EVM wallet? If not, please do that first, then tell me once it’s done. After that I’ll ask which login wallet key you used.";
        session.stage = "awaiting_evm_wallet_signin";
        return reply(withUpdate(session, deps), followUp, ["I signed in", "Create dedicated EVM wallet", "Create dedicated TON wallet", "TON wallet connection", "email OTP"], [{
          type: "blocked_missing_auth",
          message: followUp,
        }]);
      }

      if (hints.authChoice === "ton") {
        const storedTonAddress = getStoredTonAddress(deps);
        session.auth.tonAddress = storedTonAddress || session.auth.tonAddress;
        session.auth.tonAddressDisplay = storedTonAddress || session.auth.tonAddressDisplay;
        const followUp = storedTonAddress ? buildTonAddressConfirmationPrompt(session.auth.tonAddressDisplay || storedTonAddress) : buildTonAddressPrompt();
        session.stage = storedTonAddress ? "awaiting_ton_address_confirmation" : "awaiting_ton_address";
        return reply(withUpdate(session, deps), followUp, ["this address is correct", "use a different TON address"], [{
          type: "blocked_missing_auth",
          message: followUp,
        }]);
      }

      if (hints.authChoice === "generated_evm" || hints.authChoice === "generated_ton") {
        const storedEmail = session.auth.emailAddress || getStoredEmailAddress(deps);
        if (storedEmail) {
          return startEmailOtpFlow(session, deps, storedEmail);
        }

        session.stage = "awaiting_email_address";
        const followUp = buildEmailAddressPrompt();
        return reply(withUpdate(session, deps), followUp, undefined, [{
          type: "blocked_missing_auth",
          message: followUp,
        }]);
      }

      const storedEmail = session.auth.emailAddress || getStoredEmailAddress(deps);
      if (storedEmail) {
        return startEmailOtpFlow(session, deps, storedEmail);
      }

      session.stage = "awaiting_email_address";
      const followUp = buildEmailAddressPrompt();
      return reply(withUpdate(session, deps), followUp, undefined, [{
        type: "blocked_missing_auth",
        message: followUp,
      }]);
    }

    return reply(
      withUpdate(session, deps),
      getUnigoxWalletConnectionPrompt(),
      [...AUTH_CHOICE_OPTIONS],
      [{
        type: "blocked_missing_auth",
        message: getUnigoxWalletConnectionPrompt(),
      }]
    );
  }

  if (session.goal === "transfer" && session.auth.available && !session.auth.evmSigningKeyAvailable) {
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
  const shouldRecheckSavedRecipient = Boolean(
    session.goal === "transfer"
    && !session.contactExists
    && !session.contactKey
    && !session.remoteSavedContact
    && (
      (session.recipientQuery && !session.recipientName)
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
    shouldRecheckSavedRecipient && hints.recipient
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
