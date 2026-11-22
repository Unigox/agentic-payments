import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { detectAuthState, startTransferFlow, advanceTransferFlow } from "./transfer-orchestrator.ts";

process.env.SEND_MONEY_DISABLE_ENV_FILE_LOOKUP = "1";
import { validatePaymentDetailInput } from "./payment-catalogue.ts";
import type {
  CurrencyPaymentData,
  PaymentFieldConfig,
  ResolvedPaymentMethodFieldConfig,
} from "./payment-catalogue.ts";
import { TransferExecutionError } from "./transfer-execution.ts";
import type {
  InitiatorTradeSummary,
  KycVerificationData,
  PartnerPaymentDetailsDiffData,
  PaymentDetail,
  PreflightQuote,
  SettlementTrade,
  TradeRequest,
  TransferExecutionClient,
  TransferExecutionFailure,
  UserProfile,
  WalletBalance,
} from "./transfer-execution.ts";
import type { TransferFlowDeps } from "./transfer-orchestrator.ts";

/**
 * Creates a contacts file in a fresh temporary directory.
 *
 * @param initialContacts Contents to write; defaults to an empty store.
 * @returns The directory and the file path.
 */
function makeTempContactsFile(initialContacts: any = { contacts: {}, _meta: { lastUpdated: "" } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-flow-"));
  const file = path.join(dir, "contacts.json");
  fs.writeFileSync(file, JSON.stringify(initialContacts, null, 2));
  return { dir, file };
}

/**
 * Runs a function with environment variables temporarily set or removed.
 *
 * @param vars Variables to set; `undefined` removes one.
 * @param fn Function to run. May be async.
 * @returns What `fn` returns. The previous environment is restored afterwards, also on failure.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const PAYMENT_DATA: Record<string, CurrencyPaymentData> = {
  EUR: {
    currency: { code: "EUR", name: "EUR" },
    paymentMethods: [
      {
        id: 2,
        name: "Revolut",
        slug: "revolut",
        type: "BANK",
        typeSlug: "digital-banks",
        networks: [
          { id: 3, name: "European Transfer (SEPA)", slug: "iban-sepa", fiatCurrencyCode: "EUR" },
          { id: 47, name: "Revolut Username", slug: "revolut-username", fiatCurrencyCode: "EUR" },
        ],
      },
      {
        id: 1,
        name: "Wise",
        slug: "wise",
        type: "BANK",
        typeSlug: "digital-banks",
        networks: [
          { id: 46, name: "Wise Tag", slug: "wise-tag", fiatCurrencyCode: "EUR" },
          { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa", fiatCurrencyCode: "EUR" },
        ],
      },
      {
        id: 519,
        name: "Other Bank",
        slug: "other-bank",
        type: "BANK",
        typeSlug: "traditional-banks",
        networks: [
          { id: 49, name: "European Transfer (SEPA)", slug: "iban-sepa", fiatCurrencyCode: "EUR" },
        ],
      },
    ],
  },
  INR: {
    currency: { code: "INR", name: "INR" },
    paymentMethods: [
      {
        id: 2001,
        name: "IMPS or NEFT Transfer",
        slug: "imps-or-neft-transfer",
        type: "BANK",
        typeSlug: "traditional-banks",
        networks: [
          { id: 551, name: "IMPS or NEFT India", slug: "imps-neft-india", fiatCurrencyCode: "INR" },
        ],
      },
    ],
  },
  NGN: {
    currency: { code: "NGN", name: "NGN" },
    paymentMethods: [
      {
        id: 1001,
        name: "Kuda Bank",
        slug: "kuda-bank",
        type: "BANK",
        typeSlug: "digital-banks",
        networks: [
          { id: 501, name: "NIP Nigeria", slug: "nip-nigeria", fiatCurrencyCode: "NGN" },
        ],
      },
    ],
  },
  KES: {
    currency: { code: "KES", name: "KES" },
    paymentMethods: [
      {
        id: 3001,
        name: "M-PESA",
        slug: "m-pesa",
        type: "WALLET",
        typeSlug: "mobile-money",
        networks: [
          { id: 601, name: "Pesalink", slug: "pesalink", fiatCurrencyCode: "KES" },
        ],
      },
    ],
  },
};

/**
 * Builds one payout field definition the way the catalogue returns it.
 *
 * @param field Field key.
 * @param label Human-readable name.
 * @param placeholder Example value.
 * @param required Whether the rail requires it.
 * @param pattern Regular expression the value must match, when the rail publishes one.
 * @returns The field definition.
 */
function fieldConfig(field: string, label: string, placeholder: string, required: boolean, pattern?: string): PaymentFieldConfig {
  return { field, label, placeholder, type: "text", required, pattern };
}

// Patterns as the live Partner API publishes them for these rails.
const IBAN_FIELD = fieldConfig("iban", "IBAN", "EE382200221020145685", true, "^[A-Z]{2}\\d{2}[A-Z0-9]{1,30}$");
const FULL_NAME_PATTERN = "^[a-zA-ZÀ-ÿ\\u0100-\\u017F\\u0400-\\u04FF\\s'-]{2,50}$";

/**
 * Builds the field config the catalogue would resolve for one fixture method and network.
 *
 * @param currency Currency code of the fixture.
 * @param methodIndex Index of the method in `PAYMENT_DATA[currency].paymentMethods`.
 * @param networkIndex Index of the network on that method.
 * @param fields Fields to collect.
 * @param selectedFormatId Rail format id, when the rail has formats.
 * @returns The resolved field config.
 */
function resolvedConfig(
  currency: string,
  methodIndex: number,
  networkIndex: number,
  fields: PaymentFieldConfig[],
  selectedFormatId?: string
): ResolvedPaymentMethodFieldConfig {
  const method = PAYMENT_DATA[currency].paymentMethods[methodIndex];
  return { method, network: method.networks[networkIndex], selectedFormatId, fields };
}

const FIELD_CONFIGS: Record<string, ResolvedPaymentMethodFieldConfig> = {
  "EUR:revolut:revolut-username": resolvedConfig("EUR", 0, 1, [
    fieldConfig("revtag", "RevTag", "Enter @username", true, "^[a-zA-Z0-9_-]+$"),
  ]),
  "EUR:wise:wise-tag": resolvedConfig("EUR", 1, 0, [
    fieldConfig("email", "Wise Email", "name@example.com", true, "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"),
  ]),
  "EUR:wise:iban-sepa": resolvedConfig("EUR", 1, 1, [
    IBAN_FIELD,
    fieldConfig("full_name", "Full Name", "Recipient full name", true, FULL_NAME_PATTERN),
  ]),
  "EUR:other-bank:iban-sepa": resolvedConfig("EUR", 2, 0, [
    IBAN_FIELD,
    fieldConfig("full_name", "Full Name", "Recipient full name", true, FULL_NAME_PATTERN),
    fieldConfig("bank_name", "Bank Name", "Bank name", true),
  ]),
  "INR:imps-or-neft-transfer:imps-neft-india": resolvedConfig("INR", 0, 0, [
    fieldConfig("bank_name", "Bank Name", "Example Bank", true),
    fieldConfig("ifsc_code", "IFSC Code", "TEST0001234", true, "^[A-Z]{4}0[A-Z0-9]{6}$"),
    fieldConfig("account_number", "Account Number", "123456789012", true),
    fieldConfig("full_name", "Full Name", "Bhim Example", true, FULL_NAME_PATTERN),
  ]),
  "NGN:kuda-bank:nip-nigeria": resolvedConfig("NGN", 0, 0, [
    fieldConfig("account_number", "Account Number", "0123456789", true, "^\\d{10}$"),
    fieldConfig("full_name", "Full Name", "Recipient full name", false, FULL_NAME_PATTERN),
  ], "banks"),
  "KES:m-pesa:pesalink": resolvedConfig("KES", 0, 0, [
    fieldConfig("phone_number", "Phone Number", "+254712345678", true, "^\\+[1-9]\\d{6,14}$"),
  ], "mobile-money"),
};

/**
 * Fake catalogue: lists the fixture methods for a currency.
 *
 * @param currency Currency code.
 * @returns The fixture methods.
 * @throws Error for a currency without fixtures.
 */
async function stubGetPaymentMethodsForCurrency(currency: string): Promise<CurrencyPaymentData> {
  const data = PAYMENT_DATA[currency.toUpperCase()];
  if (!data) throw new Error(`Unsupported test currency ${currency}`);
  return data;
}

/**
 * Fake catalogue: resolves the fixture field config for a method and network.
 *
 * @param params Currency, institution slug and rail slug.
 * @returns The fixture field config.
 * @throws Error when no fixture exists for the combination.
 */
async function stubGetPaymentMethodFieldConfig(params: {
  currency: string;
  methodSlug: string;
  networkSlug: string;
}): Promise<ResolvedPaymentMethodFieldConfig> {
  const config = FIELD_CONFIGS[`${params.currency.toUpperCase()}:${params.methodSlug}:${params.networkSlug}`];
  if (!config) throw new Error(`Field config not found for test config: ${JSON.stringify(params)}`);
  return config;
}

/** What the fake backend recorded and how it can be steered. Returned by `makeClient`. */
type FakeClient = TransferExecutionClient & {
  /** Names of the port methods called, in order, some with their key arguments appended. */
  calls: string[];
  /** Arguments of the most recent `createTradeRequest` call. */
  lastCreateTradeRequestParams?: Parameters<TransferExecutionClient["createTradeRequest"]>[0];
};

/**
 * Builds an in-memory backend for flow tests.
 *
 * By default the sender is verified, the wallet holds 1000 USDC, every transfer is matched and its
 * escrow is already funded.
 *
 * @param options Overrides: balances, saved details, how matching ends, trade status sequence,
 *   failures to raise, profile and KYC state, and quote values.
 * @returns The fake backend with its call log.
 */
function makeClient(options: {
  balance?: number;
  balances?: Partial<Record<"USDC" | "USDT", number>>;
  paymentDetails?: PaymentDetail[];
  initiatorTrades?: InitiatorTradeSummary[];
  waitMode?: "matched" | "no_match" | "timeout" | "new_price";
  matchedTradeStatus?: string;
  getTradeStatuses?: string[];
  tradeOverrides?: Partial<SettlementTrade>;
  tradeRequestOverrides?: Partial<TradeRequest>;
  fundTradeEscrowStatusAfter?: string;
  fundTradeEscrowFailure?: TransferExecutionFailure;
  revalidateTradeStatusAfter?: string;
  partnerPaymentDetailsDiff?: PartnerPaymentDetailsDiffData;
  confirmFiatReceivedStatus?: string;
  confirmFiatReceivedError?: string;
  username?: string;
  preflightQuote?: Partial<PreflightQuote>;
  preflightQuotesByAsset?: Partial<Record<"USDC" | "USDT", Partial<PreflightQuote> | null>>;
  profile?: Partial<UserProfile>;
  kycStatus?: KycVerificationData;
  initializeKycResponse?: KycVerificationData;
  createTradeRequestFailure?: TransferExecutionFailure;
} = {}): FakeClient {
  const calls: string[] = [];
  const usdcBalance = options.balances?.USDC ?? options.balance ?? 1000;
  const usdtBalance = options.balances?.USDT ?? 0;
  const totalBalance = usdcBalance + usdtBalance;
  const paymentDetails = options.paymentDetails ?? [];
  const initiatorTrades = options.initiatorTrades ?? [];
  const waitMode = options.waitMode ?? "matched";
  const username = options.username ?? "sender@example.test";
  const profile: UserProfile = {
    username,
    id_verification_status: "VERIFIED",
    ...options.profile,
  };
  let currentTradeStatus = options.matchedTradeStatus ?? "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer";
  const tradeStatuses = [...(options.getTradeStatuses || [currentTradeStatus])];
  const fundTradeEscrowStatusAfter = options.fundTradeEscrowStatusAfter ?? "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer";
  const revalidateTradeStatusAfter = options.revalidateTradeStatusAfter ?? "awaiting_escrow_funding_by_seller";
  const partnerPaymentDetailsDiff = options.partnerPaymentDetailsDiff;
  let tradeStatusIndex = 0;
  let newPriceReported = false;

  const client: FakeClient = {
    calls,
    async getProfile() {
      calls.push("getProfile");
      return { ...profile };
    },
    async getWalletBalance(): Promise<WalletBalance> {
      calls.push("getWalletBalance");
      return {
        usdc: usdcBalance,
        usdt: usdtBalance,
        totalUsd: totalBalance,
        assets: [
          { assetCode: "USDC", amount: usdcBalance },
          { assetCode: "USDT", amount: usdtBalance },
        ],
      };
    },
    async listPaymentDetails(): Promise<PaymentDetail[]> {
      calls.push("listPaymentDetails");
      return paymentDetails;
    },
    async listInitiatorTrades() {
      calls.push("listInitiatorTrades");
      return initiatorTrades;
    },
    async ensurePaymentDetail(): Promise<PaymentDetail> {
      calls.push("ensurePaymentDetail");
      return { id: "9001", fiat_currency_code: "EUR", details: {} };
    },
    async getKycVerificationStatus(): Promise<KycVerificationData> {
      calls.push("getKycVerificationStatus");
      return options.kycStatus ?? { status: "not_started" };
    },
    async initializeKycVerification(params: { fullName: string; country: string }): Promise<KycVerificationData> {
      calls.push(`initializeKycVerification:${params.fullName}:${params.country}`);
      return options.initializeKycResponse ?? {
        status: "initial",
        verification_url: "https://verify.example/kyc-session",
        verification_seconds_left: 900,
      };
    },
    async getPreflightQuote(params): Promise<PreflightQuote | undefined> {
      const assetCode = params.cryptoCurrencyCode as "USDC" | "USDT";
      calls.push(`getPreflightQuote:${assetCode}:${params.fiatAmount}`);
      const override = options.preflightQuotesByAsset?.[assetCode];
      if (override === null) return undefined;
      return {
        quoteType: "estimate",
        source: "best_offer",
        cryptoCurrencyCode: override?.cryptoCurrencyCode || options.preflightQuote?.cryptoCurrencyCode || assetCode,
        fiatCurrencyCode: "EUR",
        fiatAmount: params.fiatAmount,
        totalCryptoAmount: params.fiatAmount + 1.25,
        feeCryptoAmount: 0.25,
        vendorOfferRate: 0.95,
        paymentMethodName: "Revolut",
        paymentNetworkName: "Revolut Username",
        ...options.preflightQuote,
        ...override,
      };
    },
    async createTradeRequest(params): Promise<TradeRequest> {
      calls.push("createTradeRequest");
      if (options.createTradeRequestFailure) {
        throw new TransferExecutionError(options.createTradeRequestFailure, "engineering detail that must not reach the reply");
      }
      client.lastCreateTradeRequestParams = params;
      if (waitMode === "new_price" && !newPriceReported) {
        newPriceReported = true;
        return {
          id: "",
          status: "new_price_confirming_by_initiator",
          fiat_currency_code: params.fiatCurrencyCode,
          crypto_currency_code: params.cryptoCurrencyCode,
          fiat_amount: params.fiatAmount,
          total_crypto_amount: params.cryptoAmount + 5,
          vendor_offer_rate: 0.8164,
          ...options.tradeRequestOverrides,
        };
      }
      return { id: "7001", status: "awaiting_liquidity_provider", ...options.tradeRequestOverrides };
    },
    async waitForTradeMatch(): Promise<TradeRequest> {
      calls.push("waitForTradeMatch");
      if (waitMode === "no_match") {
        throw new TransferExecutionError("no_match", "order ended as cancelled before a provider accepted it");
      }
      if (waitMode === "timeout") {
        throw new TransferExecutionError("match_timeout", "no provider accepted within 120000 ms");
      }
      return {
        id: "7001",
        status: "accepted_by_vendor",
        trade: { id: "8801", status: currentTradeStatus },
        ...options.tradeRequestOverrides,
      };
    },
    async getTradeRequest(): Promise<TradeRequest> {
      calls.push("getTradeRequest");
      return {
        id: "7001",
        status: waitMode === "matched" || waitMode === "new_price" ? "accepted_by_vendor" : "awaiting_liquidity_provider",
        trade: { id: "8801", status: currentTradeStatus },
        fiat_currency_code: "EUR",
        crypto_currency_code: "USDT",
        fiat_amount: 40.82,
        total_crypto_amount: 50,
        vendor_offer_rate: 0.8164,
        payment_method_name: "Wise",
        payment_network_name: "European Transfer (SEPA)",
        ...options.tradeRequestOverrides,
      };
    },
    async getTrade(): Promise<SettlementTrade> {
      calls.push("getTrade");
      const next = tradeStatuses[Math.min(tradeStatusIndex, tradeStatuses.length - 1)] || currentTradeStatus;
      tradeStatusIndex += 1;
      currentTradeStatus = next;
      return {
        id: "8801",
        status: currentTradeStatus,
        payment_window_seconds_left: 900,
        claim_autorelease_seconds_left: 1800,
        ...options.tradeOverrides,
      };
    },
    async getPartnerPaymentDetailsDiff() {
      calls.push("getPartnerPaymentDetailsDiff");
      return partnerPaymentDetailsDiff ?? { payment_details_id: "9001", differences: { missing_fields: [], invalid_fields: [] } };
    },
    async createOrUpdatePartnerPaymentDetails(params: { internalDetailsId: string; partner: string; details: Record<string, string> }) {
      calls.push(`createOrUpdatePartnerPaymentDetails:${params.internalDetailsId}:${params.partner}`);
      return { details: params.details };
    },
    async revalidateTradePaymentDetails() {
      calls.push("revalidateTradePaymentDetails");
      currentTradeStatus = revalidateTradeStatusAfter;
      tradeStatuses.push(currentTradeStatus);
      return { trade: { id: "8801", status: currentTradeStatus } };
    },
    async fundTradeEscrow(tradeId: string) {
      calls.push(`fundTradeEscrow:${tradeId}`);
      if (options.fundTradeEscrowFailure) {
        throw new TransferExecutionError(options.fundTradeEscrowFailure, "engineering detail that must not reach the reply");
      }
      currentTradeStatus = fundTradeEscrowStatusAfter;
      tradeStatuses.push(currentTradeStatus);
    },
    async confirmFiatReceived() {
      calls.push("confirmFiatReceived");
      if (options.confirmFiatReceivedError) {
        throw new Error(options.confirmFiatReceivedError);
      }
      currentTradeStatus = options.confirmFiatReceivedStatus ?? "fiat_payment_confirmed_by_seller_escrow_release_started";
      tradeStatuses.push(currentTradeStatus);
      return { id: "8801", status: currentTradeStatus };
    },
    async authorizeRefund(tradeId: string) {
      calls.push(`authorizeRefund:${tradeId}`);
      currentTradeStatus = "escrow_refunded_to_seller";
      tradeStatuses.push(currentTradeStatus);
    },
  };

  return client;
}

/**
 * Builds flow collaborators around a fake backend and the fixture catalogue.
 *
 * @param contactsFilePath Contacts file for this test.
 * @param client Fake backend.
 * @param overrides Collaborators or timings to replace.
 * @returns Collaborators with credentials reported as configured and near-zero polling waits.
 */
function makeDeps(contactsFilePath: string, client: ReturnType<typeof makeClient>, overrides: Partial<TransferFlowDeps> = {}): TransferFlowDeps {
  return {
    contactsFilePath,
    authState: { hasReplayableAuth: true },
    client,
    waitForSettlementTimeoutMs: 1,
    receiptConfirmationHandoffTimeoutMs: 1,
    settlementPollIntervalMs: 1,
    getPaymentMethodsForCurrency: stubGetPaymentMethodsForCurrency,
    getPaymentMethodFieldConfig: stubGetPaymentMethodFieldConfig,
    validatePaymentDetailInput,
    ...overrides,
  };
}

test("happy path: new recipient transfer goes from chat prompts to matched trade", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("Hey I want to make a transfer", deps);
  assert.equal(res.session.stage, "awaiting_recipient_mode");

  res = await advanceTransferFlow(res.session, "new recipient", deps);
  assert.equal(res.session.stage, "awaiting_recipient_name");

  res = await advanceTransferFlow(res.session, "John Doe", deps);
  assert.equal(res.session.stage, "awaiting_currency");

  res = await advanceTransferFlow(res.session, "EUR", deps);
  assert.equal(res.session.stage, "awaiting_payment_method");

  res = await advanceTransferFlow(res.session, "Revolut", deps);
  assert.equal(res.session.stage, "awaiting_payment_network");

  res = await advanceTransferFlow(res.session, "Revolut Username", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /RevTag/i);

  res = await advanceTransferFlow(res.session, "@john_doe", deps);
  assert.equal(res.session.stage, "awaiting_save_contact_decision");

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "awaiting_amount");
  assert.ok(res.events.some((event) => event.type === "contact_saved"));

  res = await advanceTransferFlow(res.session, "50", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.match(res.reply, /Current wallet balance: 1000\.00 USD/i);
  assert.match(res.reply, /Current best-offer estimate:/i);
  assert.match(res.reply, /not a locked quote/i);
  assert.match(res.reply, /sending as sender@example\.test/i);

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.equal(res.session.status, "active");
  assert.ok(res.events.some((event) => event.type === "trade_request_created"));
  assert.ok(res.events.some((event) => event.type === "trade_matched"));
  assert.ok(res.events.some((event) => event.type === "settlement_monitor_started"));
  assert.match(res.reply, /The transfer is live and escrow is funded/i);
  assert.doesNotMatch(res.reply, /Trade request #|trade #|Vendor:/i);
  assert.deepEqual(client.calls.slice(0, 8), [
    "getProfile",
    "getWalletBalance",
    "listInitiatorTrades",
    "getProfile",
    "getWalletBalance",
    "ensurePaymentDetail",
    "getPreflightQuote:USDC:50",
    "getPreflightQuote:USDT:50",
  ]);
  assert.ok(client.calls.includes("createTradeRequest"));
  assert.ok(client.calls.includes("waitForTradeMatch"));
  assert.ok(client.calls.includes("getTrade"));

  const contacts = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(contacts.contacts["john-doe"].paymentMethods.EUR.methodSlug, "revolut");
  assert.equal(contacts.contacts["john-doe"].paymentMethods.EUR.networkSlug, "revolut-username");
  assert.equal(contacts.contacts["john-doe"].paymentMethods.EUR.details.revtag, "john_doe");
});

test("matched trade with seller-side funding required auto-funds escrow before settlement monitoring", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    matchedTradeStatus: "trade_created",
    tradeOverrides: {
      possible_actions: ["action_fund_escrow"],
    },
    preflightQuotesByAsset: {
      USDC: null,
      USDT: {
        cryptoCurrencyCode: "USDT",
        totalCryptoAmount: 60.768185,
        feeCryptoAmount: 0.302329,
        vendorOfferRate: 0.822799,
        paymentMethodName: "Wise",
        paymentNetworkName: "SEPA / IBAN",
      },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 50 EUR to aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.ok(res.events.some((event) => event.type === "escrow_funding_submitted"));
  assert.ok(client.calls.includes("createTradeRequest"));
  assert.ok(client.calls.includes("waitForTradeMatch"));
  assert.ok(client.calls.includes("fundTradeEscrow:8801"));
  assert.match(res.reply, /The transfer is live and escrow is funded/i);
  assert.doesNotMatch(res.reply, /Trade request #|trade #|Vendor:/i);
});

test("matched partner trade collects partner address fields, revalidates, and then funds escrow", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "trade_created",
    tradeOverrides: {
      partner_short_name: "switch",
      partner_details_checked_at: null,
      total_crypto_amount: 60.740716,
    },
    partnerPaymentDetailsDiff: {
      payment_details_id: "9001",
      differences: {
        missing_fields: [
          { partner_field_name: "holder_city" },
          { partner_field_name: "holder_postal_code" },
          { partner_field_name: "holder_street" },
        ],
        invalid_fields: [],
      },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 50 EUR to aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_partner_payment_details_input");
  assert.ok(client.calls.includes("getPartnerPaymentDetailsDiff"));
  assert.match(res.reply, /Holder city/i);
  assert.match(res.reply, /Just send me the city name/i);
  assert.doesNotMatch(res.reply, /field: value/i);
  assert.ok(!client.calls.includes("createOrUpdatePartnerPaymentDetails:9001:switch"));

  res = await advanceTransferFlow(res.session, "Brussels", deps);
  assert.equal(res.session.stage, "awaiting_partner_payment_details_input");
  assert.match(res.reply, /Holder postal code/i);
  assert.match(res.reply, /Just send me the postal code/i);

  res = await advanceTransferFlow(res.session, "1000", deps);
  assert.equal(res.session.stage, "awaiting_partner_payment_details_input");
  assert.match(res.reply, /Holder street/i);
  assert.match(res.reply, /Just send me the street address/i);

  res = await advanceTransferFlow(res.session, "Rue de la Loi 1", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.ok(client.calls.includes("createOrUpdatePartnerPaymentDetails:9001:switch"));
  assert.ok(client.calls.includes("revalidateTradePaymentDetails"));
  assert.ok(client.calls.includes("fundTradeEscrow:8801"));
  assert.match(res.reply, /The transfer is live and escrow is funded/i);
  assert.doesNotMatch(res.reply, /Trade request #|trade #|Vendor:/i);
});

test("after escrow funding the skill keeps watching until it can ask for receipt confirmation", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "trade_created",
    getTradeStatuses: [
      "trade_created",
      "awaiting_escrow_funding_by_seller",
      "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer",
      "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer",
      "fiat_payment_proof_submitted_by_buyer",
    ],
    tradeOverrides: {
      partner_short_name: "switch",
      partner_details_checked_at: null,
      total_crypto_amount: 60.740716,
    },
    partnerPaymentDetailsDiff: {
      payment_details_id: "9001",
      differences: {
        missing_fields: [
          { partner_field_name: "holder_city" },
          { partner_field_name: "holder_postal_code" },
          { partner_field_name: "holder_street" },
        ],
        invalid_fields: [],
      },
    },
  });
  const deps = makeDeps(file, client, {
    waitForSettlementTimeoutMs: 10,
    receiptConfirmationHandoffTimeoutMs: 20,
    settlementPollIntervalMs: 1,
  });

  let res = await startTransferFlow("send 50 EUR to aleksandr", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  res = await advanceTransferFlow(res.session, "Tallinn", deps);
  res = await advanceTransferFlow(res.session, "13511", deps);
  res = await advanceTransferFlow(res.session, "Oismae tee 140", deps);

  assert.equal(res.session.stage, "awaiting_receipt_confirmation");
  assert.ok(client.calls.includes("fundTradeEscrow:8801"));
  assert.match(res.reply, /Please let me know once you receive the payment/i);
  assert.match(res.reply, /on the way from the counterparty bank/i);
});

test("matched partner trade with required partner fields stays blocked before funding", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "trade_created",
    tradeOverrides: {
      partner_short_name: "switch",
      partner_details_checked_at: null,
    },
    partnerPaymentDetailsDiff: {
      payment_details_id: "9001",
      differences: {
        missing_fields: [
          { partner_field_name: "holder_city", required: true },
        ],
        invalid_fields: [],
      },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 50 EUR to aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_partner_payment_details_input");
  assert.match(res.reply, /holder city/i);
  assert.ok(!client.calls.includes("revalidateTradePaymentDetails"));
  assert.ok(!client.calls.some((call) => call.startsWith("fundTradeEscrow:")));
});

test("a live price above the approved estimate places nothing until the person confirms it", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    waitMode: "new_price",
    matchedTradeStatus: "trade_created",
    tradeOverrides: {
      possible_actions: ["action_fund_escrow"],
    },
    preflightQuotesByAsset: {
      USDC: null,
      USDT: {
        cryptoCurrencyCode: "USDT",
        totalCryptoAmount: 60.795681,
        feeCryptoAmount: 0.3025,
        vendorOfferRate: 0.822427,
        paymentMethodName: "Wise",
        paymentNetworkName: "European Transfer (SEPA)",
      },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 50 EUR to aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_new_price_confirmation");
  assert.match(res.reply, /original quote is no longer available/i);
  assert.match(res.reply, /65\.795681 USDT for 50 EUR/i);
  assert.match(res.reply, /about 60\.795681 USDT/i);
  assert.match(res.reply, /I have not funded escrow/i);
  assert.ok(res.events.some((event) => event.type === "trade_price_changed"));
  assert.equal(client.lastCreateTradeRequestParams?.cryptoAmount, 60.795681);
  assert.equal(res.session.execution.tradeRequestId, undefined);
  assert.ok(!client.calls.includes("waitForTradeMatch"));
  assert.ok(!client.calls.some((call) => call.startsWith("fundTradeEscrow:")));

  res = await advanceTransferFlow(res.session, "confirm new price", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.equal(client.lastCreateTradeRequestParams?.cryptoAmount, 65.795681);
  assert.ok(res.events.some((event) => event.type === "trade_price_change_confirmed"));
  assert.ok(client.calls.includes("fundTradeEscrow:8801"));
  assert.match(res.reply, /The transfer is live and escrow is funded/i);
});

test("declining a higher live price sends nothing", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    waitMode: "new_price",
    preflightQuotesByAsset: {
      USDC: null,
      USDT: {
        cryptoCurrencyCode: "USDT",
        totalCryptoAmount: 60.795681,
        feeCryptoAmount: 0.3025,
        vendorOfferRate: 0.822427,
        paymentMethodName: "Wise",
        paymentNetworkName: "European Transfer (SEPA)",
      },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 50 EUR to aleksandr", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_new_price_confirmation");

  res = await advanceTransferFlow(res.session, "cancel", deps);
  assert.equal(res.session.stage, "awaiting_no_match_resolution");
  assert.ok(!client.calls.includes("waitForTradeMatch"));
  assert.ok(res.events.some((event) => event.type === "trade_price_change_cancelled"));
  assert.match(res.reply, /dropped that updated price and nothing was sent/i);
});

test("stale saved contact gets revalidated, updated, and then used", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "bad tag!" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 40 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /stale or incomplete/i);

  res = await advanceTransferFlow(res.session, "@mom_ok", deps);
  assert.equal(res.session.stage, "awaiting_save_contact_decision");

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.ok(res.events.some((event) => event.type === "contact_updated"));

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");

  const contacts = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(contacts.contacts.mom.paymentMethods.EUR.details.revtag, "mom_ok");
});

test("saved contact partial name asks for confirmation before using the saved route", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["alex", "sasha"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "alex_vino" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("saved contact Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_saved_recipient_confirmation");
  assert.equal(res.session.pendingSavedRecipientConfirmation?.match.contact.name, "Aleksandr Example");
  assert.match(res.reply, /I think you mean saved contact for Aleksandr Example/i);
  assert.match(res.reply, /Should I use that saved recipient\?/i);

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "awaiting_amount");
  assert.equal(res.session.recipientName, "Aleksandr Example");
  assert.equal(res.session.currency, "EUR");
  assert.equal(res.session.payment?.methodSlug, "revolut");
  assert.equal(res.session.payment?.networkSlug, "revolut-username");
  assert.match(res.reply, /Okay — I’ll use the saved contact Aleksandr Example/i);
  assert.match(res.reply, /saved EUR via Revolut \/ Revolut Username payout route by default/i);
  assert.match(res.reply, /How much EUR should I send to Aleksandr Example\?/i);
  assert.doesNotMatch(res.reply, /What currency should the recipient receive/i);
});

test("mid-flow saved payment details question re-checks saved UNIGOX payout details", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send money", deps);
  res.session.recipientMode = "new";
  res.session.recipientName = "Aleksandr Vinogradov";
  res.session.recipientQuery = "Aleksandr Vinogradov";
  res.session.currency = "EUR";
  res.session.payment = {
    methodId: 519,
    methodName: "Other Bank",
    methodSlug: "other-bank",
    networkId: 49,
    networkName: "European Transfer (SEPA)",
    networkSlug: "iban-sepa",
  };
  res.session.details = {};
  res.session.detailCollection = { index: 0 };
  res.session.stage = "awaiting_payment_details";

  res = await advanceTransferFlow(res.session, "We have Aleksandr's payment details saved.", deps);

  assert.equal(res.session.stage, "awaiting_saved_recipient_confirmation");
  assert.equal(res.session.pendingSavedRecipientConfirmation?.source, "remote");
  assert.equal(res.session.pendingSavedRecipientConfirmation?.match.contact.name, "Aleksandr Example");
  assert.match(res.reply, /saved UNIGOX payout details for Aleksandr Example/i);
  assert.match(res.reply, /Should I use that saved recipient\?/i);
});

test("remote saved UNIGOX payout details resolve directly when the send amount is already specified", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 51.5, feeCryptoAmount: 0.5, vendorOfferRate: 0.97 },
      USDT: { totalCryptoAmount: 50.9, feeCryptoAmount: 0.4, vendorOfferRate: 0.98 },
    },
  });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 50 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.recipientName, "Aleksandr Example");
  assert.equal(res.session.currency, "EUR");
  assert.equal(res.session.payment?.methodSlug, "wise");
  assert.equal(res.session.payment?.networkSlug, "iban-sepa");
  assert.match(res.reply, /sending as sender@example\.test/i);
  assert.match(res.reply, /I found saved UNIGOX payout details for Aleksandr Example/i);
  assert.match(res.reply, /saved EUR via Wise \/ European Transfer \(SEPA\) payout route by default/i);
  assert.match(res.reply, /Reply 'confirm' to place the trade/i);
  assert.ok(client.calls.includes("listPaymentDetails"));
});

test("fresh transfer flow gently reminds about an older action-required trade once", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    initiatorTrades: [
      {
        id: "7098",
        status: "fiat_payment_proof_submitted_by_buyer",
        fiat_amount: 50,
        fiat_currency_code: "EUR",
        status_changed_at: "2026-03-27T01:02:03.000Z",
        initiator_payment_details: {
          id: "3413",
          details: { full_name: "Aleksandr Example" },
          payment_method_name: "Wise",
          payment_network_name: "European Transfer (SEPA)",
        },
      },
    ],
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("Hey I want to make a transfer", deps);
  assert.equal(res.session.stage, "awaiting_recipient_mode");
  assert.match(res.reply, /By the way, your earlier 50 EUR transfer to Aleksandr Example may already have arrived or still be on the way from the counterparty bank\./i);
  assert.match(res.reply, /Did Aleksandr Example receive it already\?/i);
  assert.ok(client.calls.includes("listInitiatorTrades"));

  res = await advanceTransferFlow(res.session, "saved contact Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_saved_recipient_confirmation");
  assert.doesNotMatch(res.reply, /Did Aleksandr Example receive it already\?/i);
  assert.match(res.reply, /Should I use that saved recipient\?/i);

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "awaiting_amount");
  assert.match(res.reply, /How much EUR should I send to Aleksandr Example/i);
});

test("receipt confirmation on an older startup reminder executes confirm-payment and resumes the new transfer", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["aleksandr"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 1,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    initiatorTrades: [
      {
        id: "7098",
        status: "fiat_payment_proof_submitted_by_buyer",
        fiat_amount: 50,
        fiat_currency_code: "EUR",
        status_changed_at: "2026-03-27T01:02:03.000Z",
        initiator_payment_details: {
          id: "3413",
          details: { full_name: "Aleksandr Example" },
          payment_method_name: "Wise",
          payment_network_name: "European Transfer (SEPA)",
        },
      },
    ],
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("I wanna send money to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_saved_recipient_confirmation");
  assert.match(res.reply, /Did Aleksandr Example receive it already\?/i);
  assert.match(res.reply, /Should I use that saved recipient\?/i);

  res = await advanceTransferFlow(res.session, "Yes money arrived", deps);
  assert.equal(res.session.stage, "awaiting_saved_recipient_confirmation");
  assert.match(res.reply, /I confirmed receipt for 50 EUR to Aleksandr Example/i);
  assert.match(res.reply, /Should I use that saved recipient\?/i);
  assert.ok(client.calls.includes("confirmFiatReceived"));
  assert.doesNotMatch(res.reply, /Did Aleksandr Example receive it already\?/i);

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "awaiting_amount");
  assert.match(res.reply, /How much EUR should I send to Aleksandr Example\?/i);
});

test("follow-up transfer flow confirms a fuzzy saved-recipient match before continuing", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 51.5, feeCryptoAmount: 0.5, vendorOfferRate: 0.97 },
      USDT: { totalCryptoAmount: 50.9, feeCryptoAmount: 0.4, vendorOfferRate: 0.98 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("I wanna send money to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_saved_recipient_confirmation");
  assert.equal(res.session.pendingSavedRecipientConfirmation?.match.contact.name, "Aleksandr Example");
  assert.match(res.reply, /I think you mean saved UNIGOX payout details for Aleksandr Example/i);

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "awaiting_amount");
  assert.equal(res.session.recipientName, "Aleksandr Example");
  assert.equal(res.session.contactExists, true);
  assert.equal(res.session.currency, "EUR");
  assert.equal(res.session.payment?.methodSlug, "wise");
  assert.equal(res.session.payment?.networkSlug, "iban-sepa");
  assert.match(res.reply, /Okay — I’ll use saved UNIGOX payout details for Aleksandr Example/i);
  assert.match(res.reply, /How much EUR should I send to Aleksandr Example\?/i);

  res = await advanceTransferFlow(res.session, "50 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.recipientName, "Aleksandr Example");
  assert.equal(res.session.contactExists, true);
  assert.equal(res.session.currency, "EUR");
  assert.equal(res.session.payment?.methodSlug, "wise");
  assert.equal(res.session.payment?.networkSlug, "iban-sepa");
  assert.match(res.reply, /Send 50 EUR to Aleksandr Example via Wise via European Transfer \(SEPA\)\?/i);
  assert.match(res.reply, /Recipient details:/i);
  assert.match(res.reply, /Full name: Aleksandr Example/i);
  assert.match(res.reply, /IBAN: EE382200221020145685/i);
  assert.doesNotMatch(res.reply, /full_name=/i);
  assert.match(res.reply, /Reply 'confirm' to place the trade/i);
  assert.ok(client.calls.filter((call) => call === "listPaymentDetails").length >= 1);
});

test("fuzzy typo in a saved UNIGOX payout recipient asks for confirmation before continuing", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("I wanna send money to Aleksadr", deps);
  assert.equal(res.session.stage, "awaiting_saved_recipient_confirmation");
  assert.equal(res.session.pendingSavedRecipientConfirmation?.matchedBy, "fuzzy");
  assert.match(res.reply, /I think you mean saved UNIGOX payout details for Aleksandr Example/i);

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "awaiting_amount");
  assert.equal(res.session.recipientName, "Aleksandr Example");
  assert.match(res.reply, /How much EUR should I send to Aleksandr Example\?/i);
});

test("preflight KYC gating blocks before confirmation and asks only for the full legal name first", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: undefined,
      last_name: undefined,
      kyc_country_code: undefined,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 73.1, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 60 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_kyc_full_name");
  assert.equal(res.session.status, "blocked");
  assert.match(res.reply, /UNIGOX needs KYC first/i);
  assert.match(res.reply, /before every transfer, whatever the amount/i);
  assert.match(res.reply, /1\. You give me your full legal name and country\./i);
  assert.match(res.reply, /2\. I give you a secure link to the verification page\./i);
  assert.match(res.reply, /First, what full legal name should I use for the verification\?/i);
  assert.ok(client.calls.includes("getProfile"));
  assert.ok(client.calls.includes("getKycVerificationStatus"));
  assert.ok(!client.calls.includes("createTradeRequest"));
});

test("saved payment details question during KYC keeps asking for the legal name", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: undefined,
      last_name: undefined,
      kyc_country_code: undefined,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 73.1, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 60 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_kyc_full_name");

  res = await advanceTransferFlow(res.session, "Don't we have payment details saved for Aleksandr?", deps);

  assert.equal(res.session.stage, "awaiting_kyc_full_name");
  assert.equal(res.session.auth.kycFullName, undefined);
  assert.match(res.reply, /First, what full legal name should I use for the verification\?/i);
  assert.match(res.reply, /I can check saved payout details for Aleksandr right after that\./i);
});

test("generic KYC intent during the legal-name step does not get mistaken for a name", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: undefined,
      last_name: undefined,
      kyc_country_code: undefined,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 73.1, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 60 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_kyc_full_name");

  res = await advanceTransferFlow(res.session, "I wanna do KYC on the platform", deps);

  assert.equal(res.session.stage, "awaiting_kyc_full_name");
  assert.equal(res.session.auth.kycFullName, undefined);
  assert.match(res.reply, /I can do that\./i);
  assert.match(res.reply, /First, what full legal name should I use for the verification\?/i);
});

test("preflight KYC gating asks only for country when the full name is already known", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: undefined,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 73.1, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 60 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_kyc_country");
  assert.equal(res.session.auth.kycFullName, "Alex Grape");
  assert.match(res.reply, /Which country should I use for KYC\?/i);
  assert.match(res.reply, /Send the country name or the 2-letter country code/i);
  assert.ok(!client.calls.includes("createTradeRequest"));
});

test("known KYC name and country start the verification link and resume after approval", async () => {
  const { file } = makeTempContactsFile();
  let verificationState: KycVerificationData = {
    status: "not_started",
  };
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 73.1, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  client.getKycVerificationStatus = async () => {
    client.calls.push(`getKycVerificationStatus:${verificationState.status}`);
    return verificationState;
  };
  client.initializeKycVerification = async (params: { fullName: string; country: string }) => {
    client.calls.push(`initializeKycVerification:${params.fullName}:${params.country}`);
    verificationState = {
      status: "in_progress",
      verification_url: "https://verify.example/kyc-session",
      verification_seconds_left: 900,
    };
    return verificationState;
  };
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 60 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /The verification link is ready\./i);
  assert.match(res.reply, /https:\/\/verify\.example\/kyc-session/i);
  assert.doesNotMatch(res.reply, /You give me your full name and country/i);
  assert.ok(client.calls.includes("initializeKycVerification:Alex Grape:EE"));
  assert.ok(!client.calls.includes("createTradeRequest"));

  verificationState = {
    status: "VERIFIED",
    verification_url: "https://verify.example/kyc-session",
  };

  res = await advanceTransferFlow(res.session, "done", deps);

  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.status, "active");
  assert.match(res.reply, /KYC is approved now\./i);
  assert.match(res.reply, /Reply 'confirm' to place the trade/i);
  assert.ok(!client.calls.includes("createTradeRequest"));
});

test("generic KYC intent during awaiting_kyc_completion repeats the verification link", async () => {
  const { file } = makeTempContactsFile();
  let verificationState: KycVerificationData = {
    status: "not_started",
  };
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 73.1, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  client.getKycVerificationStatus = async () => {
    client.calls.push(`getKycVerificationStatus:${verificationState.status}`);
    return verificationState;
  };
  client.initializeKycVerification = async (params: { fullName: string; country: string }) => {
    client.calls.push(`initializeKycVerification:${params.fullName}:${params.country}`);
    verificationState = {
      status: "in_progress",
      verification_url: "https://verify.example/kyc-session",
      verification_seconds_left: 900,
    };
    return verificationState;
  };
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 60 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_kyc_completion");

  res = await advanceTransferFlow(res.session, "I wanna do KYC on the platform", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /The verification link is ready\./i);
  assert.match(res.reply, /https:\/\/verify\.example\/kyc-session/i);
});

test("KYC FAQ says verification is required before every transfer and repeats the open link", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 20 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.ok(!client.calls.includes("createTradeRequest"));

  res = await advanceTransferFlow(res.session, "Do I need to do KYC?", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /requires the sender's identity to be verified before any transfer, whatever the amount/i);
  assert.match(res.reply, /https:\/\/verify\.example\/kyc-session/i);
});

test("KYC FAQ offers to start verification right away, and says nothing is needed once verified", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 20 EUR to Aleksandr", deps);
  res = await advanceTransferFlow(res.session, "Can I do KYC earlier?", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /You can do it right away, before sending anything/i);
  assert.match(res.reply, /give me the KYC link/i);

  const verifiedDeps = makeDeps(file, makeClient());
  let verified = await startTransferFlow("send 20 EUR to Aleksandr", verifiedDeps);
  verified = await advanceTransferFlow(verified.session, "Do I need to do KYC?", verifiedDeps);
  assert.match(verified.reply, /already verified on UNIGOX/i);
  assert.doesNotMatch(verified.reply, /right away/i);
});

test("asking to do KYC up front returns the live verification link", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
  });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("I wanna do KYC on the platform", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /requires the sender's identity to be verified before any transfer/i);
  assert.match(res.reply, /The verification link is ready\./i);
  assert.match(res.reply, /https:\/\/verify\.example\/kyc-session/i);
  assert.ok(client.calls.includes("initializeKycVerification:Alex Grape:EE"));
});

test("verified profile is not downgraded by a stale active KYC session", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
    kycStatus: {
      status: "initial",
      verification_url: "https://verify.example/stale-session",
      verification_seconds_left: 900,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 85.3, feeCryptoAmount: 0.42, vendorOfferRate: 0.828 },
      USDT: { totalCryptoAmount: 84.7, feeCryptoAmount: 0.42, vendorOfferRate: 0.828 },
    },
  });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 70 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.status, "active");
  assert.equal(res.session.auth.kycStatus, "VERIFIED");
  assert.match(res.reply, /Reply 'confirm' to place the trade/i);
  assert.doesNotMatch(res.reply, /KYC needs/i);
});

test("awaiting_kyc_completion trusts verified profile even if /kyc still looks active", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
    kycStatus: {
      status: "initial",
      verification_url: "https://verify.example/stale-session",
      verification_seconds_left: 900,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 85.3, feeCryptoAmount: 0.42, vendorOfferRate: 0.828 },
      USDT: { totalCryptoAmount: 84.7, feeCryptoAmount: 0.42, vendorOfferRate: 0.828 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 70 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  res.session.stage = "awaiting_kyc_completion";

  res = await advanceTransferFlow(res.session, "KYC is approved", deps);

  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.status, "active");
  assert.equal(res.session.auth.kycStatus, "VERIFIED");
  assert.match(res.reply, /KYC is approved now\./i);
  assert.match(res.reply, /Reply 'confirm' to place the trade/i);
});

test("existing active KYC verification link is reused instead of asking for KYC details again", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: null,
      last_name: null,
      kyc_country_code: null,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 85.3, feeCryptoAmount: 0.42, vendorOfferRate: 0.828 },
      USDT: { totalCryptoAmount: 84.7, feeCryptoAmount: 0.42, vendorOfferRate: 0.828 },
    },
  });
  client.getKycVerificationStatus = async () => {
    client.calls.push("getKycVerificationStatus:existing_link");
    return {
      status: "initial",
      verification_url: "https://verify.example/existing-session",
      verification_seconds_left: 900,
    };
  };
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 70 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /The verification link is ready\./i);
  assert.match(res.reply, /https:\/\/verify\.example\/existing-session/i);
  assert.doesNotMatch(res.reply, /what full legal name should I use/i);
  assert.doesNotMatch(res.reply, /Which country should I use for KYC\?/i);
  assert.doesNotMatch(res.reply, /You give me your full name and country/i);
  assert.ok(!client.calls.some((call) => call.startsWith("initializeKycVerification:")));
});

test("combined KYC full-name and country reply starts verification in one turn", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: undefined,
      last_name: undefined,
      kyc_country_code: undefined,
    },
    preflightQuotesByAsset: {
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 60 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_kyc_full_name");

  res = await advanceTransferFlow(
    res.session,
    "My full legal name is Alex Grape and my country is Estonia",
    deps
  );

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.equal(res.session.auth.kycFullName, "Alex Grape");
  assert.equal(res.session.auth.kycCountryCode, "EE");
  assert.match(res.reply, /The verification link is ready\./i);
  assert.match(res.reply, /https:\/\/verify\.example\/kyc-session/i);
  assert.ok(client.calls.includes("initializeKycVerification:Alex Grape:EE"));
});

test("comma-separated KYC full-name and country reply starts verification in one turn", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: undefined,
      last_name: undefined,
      kyc_country_code: undefined,
    },
    preflightQuotesByAsset: {
      USDT: { totalCryptoAmount: 72.55, feeCryptoAmount: 0.36, vendorOfferRate: 0.827 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 60 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_kyc_full_name");

  res = await advanceTransferFlow(
    res.session,
    "Aleksandr Example, Estonia",
    deps
  );

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.equal(res.session.auth.kycFullName, "Aleksandr Example");
  assert.equal(res.session.auth.kycCountryCode, "EE");
  assert.match(res.reply, /The verification link is ready\./i);
  assert.match(res.reply, /https:\/\/verify\.example\/kyc-session/i);
  assert.ok(client.calls.includes("initializeKycVerification:Aleksandr Example:EE"));
});

test("KYC start refetches verification status so the link is returned even if the initial response omits it", async () => {
  const { file } = makeTempContactsFile();
  let verificationState: KycVerificationData = {
    status: "not_started",
  };
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
  });
  client.getKycVerificationStatus = async () => {
    client.calls.push(`getKycVerificationStatus:${verificationState.status}`);
    return verificationState;
  };
  client.initializeKycVerification = async (params: { fullName: string; country: string }) => {
    client.calls.push(`initializeKycVerification:${params.fullName}:${params.country}`);
    verificationState = {
      status: "in_progress",
      verification_url: "https://verify.example/from-refetch",
      verification_seconds_left: 900,
    };
    return {
      status: "in_progress",
      verification_seconds_left: 900,
    };
  };
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 60 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /https:\/\/verify\.example\/from-refetch/i);
  assert.equal(res.session.auth.kycVerificationUrl, "https://verify.example/from-refetch");
  assert.ok(client.calls.includes("initializeKycVerification:Alex Grape:EE"));
  assert.ok(client.calls.includes("getKycVerificationStatus:in_progress"));
});

test("KYC start keeps polling until the verification link appears", async () => {
  const { file } = makeTempContactsFile();
  let pollCount = 0;
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
  });
  client.initializeKycVerification = async (params: { fullName: string; country: string }) => {
    client.calls.push(`initializeKycVerification:${params.fullName}:${params.country}`);
    return {
      status: "in_progress",
      verification_seconds_left: 900,
    };
  };
  client.getKycVerificationStatus = async () => {
    pollCount += 1;
    const response = pollCount >= 3
      ? {
          status: "in_progress",
          verification_url: "https://verify.example/from-polling",
          verification_seconds_left: 897,
        }
      : {
          status: "in_progress",
          verification_seconds_left: 900 - pollCount,
        };
    client.calls.push(`getKycVerificationStatus:${pollCount}:${response.verification_url ? "with_link" : "without_link"}`);
    return response;
  };
  const deps = makeDeps(file, client, {
    kycVerificationPollIntervalMs: 0,
    kycVerificationPollTimeoutMs: 10,
    sleep: async () => {},
  });

  const res = await startTransferFlow("send 60 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /https:\/\/verify\.example\/from-polling/i);
  assert.equal(res.session.auth.kycVerificationUrl, "https://verify.example/from-polling");
  assert.ok(client.calls.includes("getKycVerificationStatus:1:without_link"));
  assert.ok(client.calls.includes("getKycVerificationStatus:2:without_link"));
  assert.ok(client.calls.includes("getKycVerificationStatus:3:with_link"));
});

test("awaiting KYC completion keeps polling until the verification link becomes available", async () => {
  const { file } = makeTempContactsFile();
  let pollCount = 0;
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
  });
  client.getKycVerificationStatus = async () => {
    pollCount += 1;
    const response = pollCount >= 3
      ? {
          status: "pending",
          verification_url: "https://verify.example/from-awaiting-completion",
          verification_seconds_left: 500,
        }
      : {
          status: "pending",
          verification_seconds_left: 500 - pollCount,
        };
    client.calls.push(`getKycVerificationStatus:${pollCount}:${response.verification_url ? "with_link" : "without_link"}`);
    return response;
  };
  const deps = makeDeps(file, client, {
    kycVerificationPollIntervalMs: 0,
    kycVerificationPollTimeoutMs: 0,
    sleep: async () => {},
  });

  client.initializeKycVerification = async (params: { fullName: string; country: string }) => {
    client.calls.push(`initializeKycVerification:${params.fullName}:${params.country}`);
    return {
      status: "pending",
      verification_seconds_left: 500,
    };
  };

  const initial = await startTransferFlow("send 60 EUR to Aleksandr", deps);
  assert.equal(initial.session.stage, "awaiting_kyc_completion");
  assert.doesNotMatch(initial.reply, /https:\/\/verify\.example\/from-awaiting-completion/i);

  const res = await advanceTransferFlow(initial.session, "status", {
    ...deps,
    kycVerificationPollTimeoutMs: 10,
  });

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /https:\/\/verify\.example\/from-awaiting-completion/i);
  assert.equal(res.session.auth.kycVerificationUrl, "https://verify.example/from-awaiting-completion");
  assert.ok(client.calls.includes("getKycVerificationStatus:1:without_link"));
  assert.ok(client.calls.includes("getKycVerificationStatus:2:without_link"));
  assert.ok(client.calls.includes("getKycVerificationStatus:3:with_link"));
});

test("trade placement KYC failure falls back into the guided KYC flow", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: "3413",
        fiat_currency_code: "EUR",
        payment_method: { name: "Wise", slug: "wise" },
        payment_network: { name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 51.1, feeCryptoAmount: 0.3, vendorOfferRate: 0.823 },
      USDT: { totalCryptoAmount: 50.8, feeCryptoAmount: 0.3, vendorOfferRate: 0.823 },
    },
    createTradeRequestFailure: "kyc_required",
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 50 EUR to Aleksandr", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");

  res = await advanceTransferFlow(res.session, "confirm", deps);

  assert.equal(res.session.stage, "awaiting_kyc_full_name");
  assert.equal(res.session.status, "blocked");
  assert.match(res.reply, /UNIGOX needs KYC first/i);
  assert.match(res.reply, /First, what full legal name should I use for the verification\?/i);
  assert.ok(client.calls.includes("createTradeRequest"));
});

test("awaiting confirmation accepts natural confirm phrases with the amount", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      aleksandr: {
        name: "Aleksandr Example",
        aliases: ["alex", "sasha"],
        paymentMethods: {
          EUR: {
            method: "Wise",
            methodId: 9,
            methodSlug: "wise",
            networkId: 48,
            network: "European Transfer (SEPA)",
            networkSlug: "iban-sepa",
            details: { iban: "EE382200221020145685", full_name: "Aleksandr Example" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 51.5, feeCryptoAmount: 0.5, vendorOfferRate: 0.97 },
      USDT: { totalCryptoAmount: 50.9, feeCryptoAmount: 0.4, vendorOfferRate: 0.98 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 50 EUR to Aleksandr Example", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.match(res.reply, /Reply 'confirm' to place the trade/i);

  res = await advanceTransferFlow(res.session, "Confirm send 50", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.equal(res.session.status, "active");
  assert.ok(res.events.some((event) => event.type === "trade_request_created"));
  assert.equal(client.lastCreateTradeRequestParams?.cryptoCurrencyCode, "USDT");
});

test("saved contact partial name asks for disambiguation when multiple contacts match", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      "aleksandr-v": {
        name: "Aleksandr Example",
        aliases: ["alex v"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "alex_vino" },
          },
        },
      },
      "aleksandr-p": {
        name: "Aleksandr Sample",
        aliases: ["aleksandr p"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "alex_petrov" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient();
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("saved contact Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_recipient_name");
  assert.match(res.reply, /multiple saved contacts matching 'Aleksandr'/i);
  assert.match(res.reply, /Aleksandr Example/i);
  assert.match(res.reply, /Aleksandr Sample/i);
  assert.deepEqual(res.options, ["Aleksandr Example", "Aleksandr Sample"]);
});

test("save-contact-only flow collects details, allows skip on optional field, and never executes a transfer", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("Please save a contact for later", deps);
  assert.equal(res.session.goal, "save_contact_only");

  res = await advanceTransferFlow(res.session, "new recipient", deps);
  res = await advanceTransferFlow(res.session, "Alice Example", deps);
  res = await advanceTransferFlow(res.session, "NGN", deps);
  assert.equal(res.session.stage, "awaiting_payment_method");

  res = await advanceTransferFlow(res.session, "Kuda Bank", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");

  res = await advanceTransferFlow(res.session, "0123456789", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /Optional/i);

  res = await advanceTransferFlow(res.session, "skip", deps);
  assert.equal(res.session.stage, "awaiting_save_contact_decision");

  res = await advanceTransferFlow(res.session, "yes", deps);
  assert.equal(res.session.stage, "completed");
  assert.equal(res.session.status, "completed");
  assert.deepEqual(client.calls, []);
});


test("payment method collection stays stepwise for providers with multiple payout routes", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("save a new contact", deps);
  res = await advanceTransferFlow(res.session, "new recipient", deps);
  res = await advanceTransferFlow(res.session, "Wise Person", deps);
  res = await advanceTransferFlow(res.session, "EUR", deps);

  assert.equal(res.session.stage, "awaiting_payment_method");
  assert.match(res.reply, /provider \/ bank first/i);

  res = await advanceTransferFlow(res.session, "Wise", deps);
  assert.equal(res.session.stage, "awaiting_payment_network");
  assert.match(res.reply, /Wise has multiple payout routes/i);
  assert.match(res.reply, /username\/tag or a bank account \/ IBAN/i);

  res = await advanceTransferFlow(res.session, "European Transfer (SEPA)", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /IBAN/i);
  assert.match(res.reply, /SEPA IBAN transfer/i);

  res = await advanceTransferFlow(res.session, "EE382200221020145685", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /Full Name/i);
});

test("EUR SEPA flows skip bank_name — SEPA clears via IBAN alone", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("save a contact", deps);
  res = await advanceTransferFlow(res.session, "new recipient", deps);
  res = await advanceTransferFlow(res.session, "Bank Person", deps);
  res = await advanceTransferFlow(res.session, "EUR", deps);
  res = await advanceTransferFlow(res.session, "Other Bank", deps);

  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /IBAN/i);
  assert.match(res.reply, /SEPA IBAN transfer/i);

  res = await advanceTransferFlow(res.session, "EE382200221020145685", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /Full Name/i);

  // bank_name should be skipped for EUR SEPA — goes straight to save contact decision
  res = await advanceTransferFlow(res.session, "Bank Person", deps);
  assert.equal(res.session.stage, "awaiting_save_contact_decision");
  assert.doesNotMatch(res.reply, /Which bank should receive/i);
});

test("awaiting confirmation re-resolves a natural bank or provider correction before trade placement", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    preflightQuote: {
      paymentMethodName: "Other Bank",
      paymentNetworkName: "European Transfer (SEPA)",
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send money", deps);
  res = await advanceTransferFlow(res.session, "new recipient", deps);
  res = await advanceTransferFlow(res.session, "Aleksandr Vinogradov", deps);
  res = await advanceTransferFlow(res.session, "EUR", deps);
  res = await advanceTransferFlow(res.session, "Other Bank", deps);
  res = await advanceTransferFlow(res.session, "BE70967067003825", deps);
  res = await advanceTransferFlow(res.session, "Aleksandr Vinogradov", deps);
  // bank_name is skipped for EUR SEPA — details collection is now complete
  res = await advanceTransferFlow(res.session, "no", deps);
  res = await advanceTransferFlow(res.session, "50", deps);

  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.payment?.methodSlug, "other-bank");
  assert.equal(res.session.payment?.networkSlug, "iban-sepa");
  assert.match(res.reply, /Send 50 EUR to Aleksandr Vinogradov via Other Bank via European Transfer \(SEPA\)\?/i);

  res = await advanceTransferFlow(res.session, "No, the bank is Wise! SEPA", deps);

  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.execution.confirmed, false);
  assert.equal(res.session.payment?.methodSlug, "wise");
  assert.equal(res.session.payment?.networkSlug, "iban-sepa");
  assert.deepEqual(res.session.details, {
    iban: "BE70967067003825",
    full_name: "Aleksandr Vinogradov",
  });
  assert.match(res.reply, /I'll use Wise via European Transfer \(SEPA\) instead/i);
  assert.match(res.reply, /Send 50 EUR to Aleksandr Vinogradov via Wise via European Transfer \(SEPA\)\?/i);
  assert.equal(client.calls.includes("createTradeRequest"), false);
  assert.ok(client.calls.filter((call) => call === "ensurePaymentDetail").length >= 2);
});

test("India IMPS details validate and normalize placeholder IMPS payout fields", () => {
  const config = FIELD_CONFIGS["INR:imps-or-neft-transfer:imps-neft-india"];
  assert.ok(config);

  const result = validatePaymentDetailInput({
    bank_name: "Example Bank",
    ifsc_code: "test0001234",
    account_number: "123456789012",
    full_name: "Bhim Example",
  }, config.fields);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalizedDetails.bank_name, "Example Bank");
  assert.equal(result.normalizedDetails.ifsc_code, "TEST0001234");
  assert.equal(result.normalizedDetails.account_number, "123456789012");
  assert.equal(result.normalizedDetails.full_name, "Bhim Example");
  assert.equal(result.normalizedDetails.vpa, undefined);
  assert.equal(result.normalizedDetails.communication_address, undefined);
});

test("India IMPS flow reaches confirmation with placeholder bank details", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    preflightQuote: {
      fiatCurrencyCode: "INR",
      fiatAmount: 45,
      totalCryptoAmount: 54.8676,
      feeCryptoAmount: 0.273,
      vendorOfferRate: 0.820156,
      paymentMethodName: "IMPS or NEFT Transfer",
      paymentNetworkName: "IMPS or NEFT India",
    },
  });
  const deps = makeDeps(file, client);

  {
    let res = await startTransferFlow("send 45 INR to Bhim", deps);
    assert.equal(res.session.stage, "awaiting_payment_method");
    assert.match(res.reply, /Available examples for INR: IMPS or NEFT Transfer/i);

    res = await advanceTransferFlow(res.session, "IMPS or NEFT Transfer", deps);
    assert.equal(res.session.stage, "awaiting_payment_details");
    assert.match(res.reply, /Which bank should receive this payout/i);

    res = await advanceTransferFlow(res.session, "Example Bank", deps);
    assert.equal(res.session.stage, "awaiting_payment_details");
    assert.match(res.reply, /IFSC Code/i);

    res = await advanceTransferFlow(res.session, "test0001234", deps);
    assert.equal(res.session.stage, "awaiting_payment_details");
    assert.match(res.reply, /Account Number/i);

    res = await advanceTransferFlow(res.session, "123456789012", deps);
    assert.equal(res.session.stage, "awaiting_payment_details");
    assert.match(res.reply, /Full Name/i);

    res = await advanceTransferFlow(res.session, "Bhim Example", deps);
    assert.equal(res.session.stage, "awaiting_save_contact_decision");
    assert.match(res.reply, /save/i);

    res = await advanceTransferFlow(res.session, "no", deps);
    assert.equal(res.session.stage, "awaiting_confirmation");
    assert.match(res.reply, /Send 45 INR to Bhim via IMPS or NEFT Transfer/i);
    assert.match(res.reply, /Recipient details:/i);
    assert.match(res.reply, /Full Name: Bhim Example/i);
    assert.match(res.reply, /Bank Name: Example Bank/i);
    assert.match(res.reply, /IFSC Code: TEST0001234/i);
    assert.match(res.reply, /Account Number: 123456789012/i);
  }
});

test("insufficient balance blocks before trade creation and says how to fund the partner wallet", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({ balance: 10 });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 25 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_balance_resolution");
  assert.equal(res.session.status, "blocked");
  assert.ok(res.events.some((event) => event.type === "balance_checked"));
  assert.ok(res.events.some((event) => event.type === "blocked_insufficient_balance"));
  assert.match(res.reply, /Current best-offer estimate:/i);
  assert.match(res.reply, /26\.25 USDC total to deliver 25 EUR/i);
  assert.match(res.reply, /1 USDC ≈ 0\.95 EUR/i);
  assert.match(res.reply, /You need about 16\.25 USD more in one asset/i);
  assert.match(res.reply, /not a locked quote/i);
  assert.match(res.reply, /will not place the transfer/i);
  assert.match(res.reply, /Add USDC or USDT to the partner wallet in My Wallet on unigox\.com/i);
  assert.deepEqual(res.options, ["recheck balance", "change amount"]);
  assert.ok(!client.calls.includes("createTradeRequest"));
  assert.deepEqual(client.calls, [
    "getProfile",
    "getWalletBalance",
    "listInitiatorTrades",
    "getProfile",
    "getWalletBalance",
    "ensurePaymentDetail",
    "getPreflightQuote:USDC:25",
    "getPreflightQuote:USDT:25",
  ]);
});

test("a natural topped-up reply refreshes the balance and resumes with a fresh quote", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({ balance: 10, username: "alexwallet" });
  let currentUsdc = 10;
  let currentUsdt = 0;
  client.getWalletBalance = async (): Promise<WalletBalance> => {
    client.calls.push("getWalletBalance");
    return {
      usdc: currentUsdc,
      usdt: currentUsdt,
      totalUsd: currentUsdc + currentUsdt,
      assets: [
        { assetCode: "USDC", amount: currentUsdc },
        { assetCode: "USDT", amount: currentUsdt },
      ],
    };
  };
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_balance_resolution");
  assert.match(res.reply, /You need about 16\.25 USD more in one asset/i);

  currentUsdc = 1;
  currentUsdt = 71;

  res = await advanceTransferFlow(res.session, "I added more, I wanna send 50 euro", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.equal(res.session.amount, 50);
  assert.equal(res.session.status, "active");
  assert.match(res.reply, /Current wallet balance: 72\.00 USD total/i);
  assert.match(res.reply, /USDT: 71\.00 USD/i);
  assert.match(res.reply, /Current best-offer estimate:/i);
  assert.match(res.reply, /to deliver 50 EUR/i);
  assert.match(res.reply, /This transfer is currently coverable with USDT/i);
  assert.ok(client.calls.filter((entry) => entry === "getWalletBalance").length >= 3);
});

test("trade creation reuses the preflight quote amount instead of the raw fiat amount", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    balance: 100,
    preflightQuote: {
      fiatAmount: 25,
      totalCryptoAmount: 26.25,
      feeCryptoAmount: 0.25,
      vendorOfferRate: 0.95,
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.match(res.reply, /Current best-offer estimate:/i);
  assert.match(res.reply, /not a locked quote/i);

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(client.lastCreateTradeRequestParams?.cryptoAmount, 26.25);
  assert.equal(client.lastCreateTradeRequestParams?.fiatAmount, 25);
});

test("preflight selects the single asset that can cover the trade and execution uses that asset", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    balances: { USDC: 20, USDT: 40 },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 26.25, feeCryptoAmount: 0.25, vendorOfferRate: 0.95 },
      USDT: { totalCryptoAmount: 25.75, feeCryptoAmount: 0.25, vendorOfferRate: 0.97 },
    },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.match(res.reply, /Current wallet balance: 60\.00 USD total/i);
  assert.match(res.reply, /USDC: 20\.00 USD/i);
  assert.match(res.reply, /USDT: 40\.00 USD/i);
  assert.match(res.reply, /25\.75 USDT total to deliver 25 EUR/i);
  assert.match(res.reply, /currently coverable with USDT/i);

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(client.lastCreateTradeRequestParams?.cryptoCurrencyCode, "USDT");
  assert.equal(client.lastCreateTradeRequestParams?.cryptoAmount, 25.75);
});

test("aggregate balance is not treated as sellable when no single asset covers the trade", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    balances: { USDC: 20, USDT: 10 },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 26.25, feeCryptoAmount: 0.25, vendorOfferRate: 0.95 },
      USDT: { totalCryptoAmount: 26.75, feeCryptoAmount: 0.25, vendorOfferRate: 0.94 },
    },
  });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 25 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_balance_resolution");
  assert.equal(res.session.status, "blocked");
  assert.match(res.reply, /Current wallet balance: 30\.00 USD total/i);
  assert.match(res.reply, /USDC: 20\.00 USD/i);
  assert.match(res.reply, /USDT: 10\.00 USD/i);
  assert.match(res.reply, /high enough in aggregate/i);
  assert.match(res.reply, /single asset/i);
  assert.match(res.reply, /USDC: 20\.00 available, needs about 26\.25/i);
  assert.match(res.reply, /USDT: 10\.00 available, needs about 26\.75/i);
  assert.match(res.reply, /You need about 6\.25 USD more in one asset/i);
  assert.match(res.reply, /Until one asset covers that current estimate on its own/i);
});

test("changing currency mid-flow resets payment selection and asks for a new method", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("I want to make a transfer", deps);
  res = await advanceTransferFlow(res.session, "new recipient", deps);
  res = await advanceTransferFlow(res.session, "Bob", deps);
  res = await advanceTransferFlow(res.session, "NGN", deps);
  res = await advanceTransferFlow(res.session, "Kuda Bank", deps);
  res = await advanceTransferFlow(res.session, "0123456789", deps);
  res = await advanceTransferFlow(res.session, "skip", deps);
  assert.equal(res.session.stage, "awaiting_save_contact_decision");

  res = await advanceTransferFlow(res.session, "no", deps);
  assert.equal(res.session.stage, "awaiting_amount");

  res = await advanceTransferFlow(res.session, "change currency to KES", deps);
  assert.equal(res.session.currency, "KES");
  assert.equal(res.session.payment, undefined);
  assert.equal(res.session.stage, "awaiting_payment_method");
});

test("received confirmation uses confirm-payment and moves to release monitoring", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "fiat_payment_proof_submitted_by_buyer",
    getTradeStatuses: [
      "fiat_payment_proof_submitted_by_buyer",
      "fiat_payment_proof_submitted_by_buyer",
      "fiat_payment_confirmed_by_seller_escrow_release_started",
    ],
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 20 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_receipt_confirmation");

  res = await advanceTransferFlow(res.session, "received", deps);
  assert.equal(res.session.stage, "awaiting_release_completion");
  assert.equal(res.session.status, "active");
  assert.ok(res.events.some((event) => event.type === "receipt_confirmed"));
  assert.match(res.reply, /release has started|release should now be in progress/i);
  assert.ok(client.calls.includes("confirmFiatReceived"));
});

test("not received keeps escrow locked and enters manual follow-up placeholder", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "fiat_payment_proof_submitted_by_buyer",
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 20 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_receipt_confirmation");

  res = await advanceTransferFlow(res.session, "not received", deps);
  assert.equal(res.session.stage, "awaiting_manual_settlement_followup");
  assert.equal(res.session.status, "active");
  assert.ok(res.events.some((event) => event.type === "receipt_not_received"));
  assert.match(res.reply, /keeping the transfer protected/i);
  assert.ok(!client.calls.includes("confirmFiatReceived"));
});

test("unsupported post-match response goes to safe deferred placeholder", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "fiat_payment_proof_submitted_by_buyer",
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 20 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  res = await advanceTransferFlow(res.session, "need more time", deps);

  assert.equal(res.session.stage, "awaiting_manual_settlement_followup");
  assert.ok(res.events.some((event) => event.type === "settlement_placeholder_deferred"));
  assert.match(res.reply, /not automating that response path yet/i);
});

test("status check emits receipt timeout reminder when user does not respond", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });

  const client = makeClient({
    matchedTradeStatus: "fiat_payment_proof_submitted_by_buyer",
  });
  const base = new Date("2026-03-25T14:00:00.000Z");
  let current = base.getTime();
  const deps = makeDeps(file, client, {
    now: () => new Date(current),
    receiptReminderMs: 60_000,
    receiptTimeoutMs: 120_000,
  });

  let res = await startTransferFlow("send 20 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_receipt_confirmation");

  current += 3 * 60_000;
  res = await advanceTransferFlow(res.session, "status", deps);
  assert.ok(res.events.some((event) => event.type === "receipt_confirmation_timeout"));
  assert.match(res.reply, /keep the transfer protected/i);
});

test("no vendor match lands in explicit retry/change branch", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({ waitMode: "no_match" });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 20 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_confirmation");

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_no_match_resolution");
  assert.equal(res.session.status, "blocked");
  assert.ok(res.events.some((event) => event.type === "blocked_no_vendor_match"));
});

test("funding refused for balance after a provider accepted keeps the transfer open and hides the API text", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "awaiting_escrow_funding_by_seller",
    fundTradeEscrowFailure: "insufficient_balance",
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);

  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.equal(res.session.status, "active");
  assert.ok(client.calls.includes("fundTradeEscrow:8801"));
  assert.match(res.reply, /does not hold enough USDC to fund it, so nothing has left the wallet/i);
  assert.match(res.reply, /ask me for status and I'll fund it/i);
  assert.doesNotMatch(res.reply, /engineering detail/i);
  assert.ok(res.events.some((event) => event.type === "blocked_insufficient_balance"));
});

test("a transfer that cannot be placed is explained without the backend's wording", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  for (const [failure, expected] of [
    ["no_match", /No provider can take this transfer right now, so nothing was sent/i],
    ["price_changed", /The price moved while I was placing the transfer, so nothing was sent/i],
  ] as const) {
    const client = makeClient({ createTradeRequestFailure: failure });
    const deps = makeDeps(file, client);

    let res = await startTransferFlow("send 25 EUR to mom", deps);
    res = await advanceTransferFlow(res.session, "confirm", deps);

    assert.equal(res.session.stage, "awaiting_no_match_resolution");
    assert.match(res.reply, expected);
    assert.doesNotMatch(res.reply, /engineering detail/i);
    assert.ok(!client.calls.includes("waitForTradeMatch"));
  }
});

test("a stopped trade with crypto still in escrow gets its refund signed without asking", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    getTradeStatuses: ["escrow_funded_or_reserved_awaiting_payment_proof_from_buyer", "escrow_refund_authorization_required"],
    tradeOverrides: { possible_actions: ["action_authorize_refund"] },
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  res = await advanceTransferFlow(res.session, "status", deps);

  assert.ok(client.calls.includes("authorizeRefund:8801"));
  assert.match(res.reply, /I signed the refund, so the funds are on their way back to the partner wallet/i);
  assert.equal(res.session.execution.tradeStatus, "escrow_refunded_to_seller");
  assert.equal(res.session.status, "completed");
});

test("without Partner API settings the flow stops with setup instructions and resumes once they exist", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const missing = makeDeps(file, client, { authState: { hasReplayableAuth: false, missingSettings: ["UNIGOX_API_KEY", "UNIGOX_WALLET_PRIVATE_KEY"] } });

  let res = await startTransferFlow("send 25 EUR to mom", missing);

  assert.equal(res.session.stage, "awaiting_setup");
  assert.equal(res.session.status, "blocked");
  assert.match(res.reply, /not connected to UNIGOX yet/i);
  assert.match(res.reply, /Missing settings: UNIGOX_API_KEY, UNIGOX_WALLET_PRIVATE_KEY\./);
  assert.match(res.reply, /don't paste keys into this chat/i);
  assert.ok(res.events.some((event) => event.type === "blocked_missing_auth"));
  assert.deepEqual(client.calls, []);

  res = await advanceTransferFlow(res.session, "send 25 EUR to mom", makeDeps(file, client));

  assert.notEqual(res.session.stage, "awaiting_setup");
  assert.equal(res.session.auth.available, true);
  assert.ok(client.calls.includes("getWalletBalance"));
});

test("saving a contact needs no Partner API settings", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, { authState: { hasReplayableAuth: false, missingSettings: ["UNIGOX_API_KEY"] } });

  const res = await startTransferFlow("save a new contact John for EUR", deps);

  assert.notEqual(res.session.stage, "awaiting_setup");
  assert.deepEqual(client.calls, []);
});

test("detectAuthState reports which Partner API settings are missing", () => {
  const complete = {
    UNIGOX_API_KEY: "test-key",
    UNIGOX_WALLET_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
    UNIGOX_XAI_RPC_URL: "https://rpc.example.test",
    UNIGOX_SENDER_EMAIL: "sender@example.test",
  };

  withEnv(complete, () => {
    assert.deepEqual(detectAuthState(), { hasReplayableAuth: true, missingSettings: [] });
  });
  withEnv({ ...complete, UNIGOX_WALLET_PRIVATE_KEY: undefined, UNIGOX_SENDER_EMAIL: " " }, () => {
    assert.deepEqual(detectAuthState(), {
      hasReplayableAuth: false,
      missingSettings: ["UNIGOX_WALLET_PRIVATE_KEY", "UNIGOX_SENDER_EMAIL"],
    });
  });
});

test("a failed receipt confirmation keeps the escrow locked and does not show the backend's error text", async () => {
  const { file } = makeTempContactsFile({
    contacts: {
      mom: {
        name: "Mom",
        aliases: ["mom"],
        paymentMethods: {
          EUR: {
            method: "Revolut",
            methodId: 2,
            methodSlug: "revolut",
            networkId: 47,
            network: "Revolut Username",
            networkSlug: "revolut-username",
            details: { revtag: "mom_ok" },
          },
        },
      },
    },
    _meta: { lastUpdated: "" },
  });
  const client = makeClient({
    matchedTradeStatus: "fiat_payment_proof_submitted_by_buyer",
    confirmFiatReceivedError: "INVALID_STATUS: order b2c3 at /api/v1/partner/orders is not confirmable",
  });
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_receipt_confirmation");

  res = await advanceTransferFlow(res.session, "received", deps);

  assert.equal(res.session.stage, "awaiting_manual_settlement_followup");
  assert.match(res.reply, /did not accept the receipt confirmation just now, so nothing was released/i);
  assert.doesNotMatch(res.reply, /INVALID_STATUS|\/api\/v1|b2c3/);
  assert.match(res.session.execution.lastError ?? "", /INVALID_STATUS/);
});
