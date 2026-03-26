import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { detectAuthState, loadUnigoxConfigFromEnv, startTransferFlow, advanceTransferFlow } from "./transfer-orchestrator.ts";

process.env.SEND_MONEY_DISABLE_ENV_FILE_LOOKUP = "1";
import { validatePaymentDetailInput } from "./unigox-client.ts";
import type {
  CurrencyPaymentData,
  NetworkFieldConfig,
  PaymentDetail,
  ResolvedPaymentMethodFieldConfig,
  TradeRequest,
  WalletBalance,
} from "./unigox-client.ts";
import type { TransferExecutionClient, TransferFlowDeps } from "./transfer-orchestrator.ts";

function makeTempContactsFile(initialContacts: any = { contacts: {}, _meta: { lastUpdated: "" } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-flow-"));
  const file = path.join(dir, "contacts.json");
  fs.writeFileSync(file, JSON.stringify(initialContacts, null, 2));
  return { dir, file };
}

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
    currency: { code: "EUR", name: "Euro" },
    paymentMethods: [
      {
        id: 2,
        name: "Revolut",
        slug: "revolut",
        type: "Digital Banks",
        typeSlug: "digital-banks",
        fiatCurrencyCodes: ["EUR"],
        networks: [
          { id: 3, name: "European Transfer (SEPA)", slug: "iban-sepa", fiatCurrencyCode: "EUR", default: true },
          { id: 47, name: "Revolut Username", slug: "revolut-username", fiatCurrencyCode: "EUR", default: false },
        ],
      },
      {
        id: 1,
        name: "Wise",
        slug: "wise",
        type: "Digital Banks",
        typeSlug: "digital-banks",
        fiatCurrencyCodes: ["EUR"],
        networks: [
          { id: 46, name: "Wise Tag", slug: "wise-tag", fiatCurrencyCode: "EUR", default: true },
          { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa", fiatCurrencyCode: "EUR", default: false },
        ],
      },
      {
        id: 519,
        name: "Other Bank",
        slug: "other-bank",
        type: "Traditional Banks",
        typeSlug: "traditional-banks",
        fiatCurrencyCodes: ["EUR"],
        networks: [
          { id: 49, name: "European Transfer (SEPA)", slug: "iban-sepa", fiatCurrencyCode: "EUR", default: true },
        ],
      },
    ],
  },
  NGN: {
    currency: { code: "NGN", name: "Nigerian Naira" },
    paymentMethods: [
      {
        id: 1001,
        name: "Kuda Bank",
        slug: "kuda-bank",
        type: "Digital Banks",
        typeSlug: "digital-banks",
        fiatCurrencyCodes: ["NGN"],
        networks: [
          { id: 501, name: "NIP Nigeria", slug: "nip-nigeria", fiatCurrencyCode: "NGN", default: true },
        ],
      },
    ],
  },
  KES: {
    currency: { code: "KES", name: "Kenyan Shilling" },
    paymentMethods: [
      {
        id: 3001,
        name: "M-PESA",
        slug: "m-pesa",
        type: "Mobile Money",
        typeSlug: "mobile-money",
        fiatCurrencyCodes: ["KES"],
        networks: [
          { id: 601, name: "Pesalink", slug: "pesalink", fiatCurrencyCode: "KES", default: true },
        ],
      },
    ],
  },
};

const FIELD_CONFIGS: Record<string, ResolvedPaymentMethodFieldConfig> = {
  "EUR:revolut:revolut-username": {
    currency: PAYMENT_DATA.EUR.currency,
    method: PAYMENT_DATA.EUR.paymentMethods[0],
    network: PAYMENT_DATA.EUR.paymentMethods[0].networks[1],
    selectedFormatId: undefined,
    networkConfig: {
      slug: "revolut-username",
      name: "Revolut Username",
      description: "Revolut Username",
      fields: [
        {
          field: "revtag",
          label: "RevTag",
          description: "Recipient's Revolut tag",
          placeholder: "Enter @username",
          type: "text",
          required: true,
          validators: [
            {
              validatorName: "revTag",
              pattern: "^[a-zA-Z0-9_-]+$",
              message: "RevTag must contain only letters, numbers, underscores or hyphens",
            },
          ],
        },
      ],
      formats: [],
    },
    fields: [
      {
        field: "revtag",
        label: "RevTag",
        description: "Recipient's Revolut tag",
        placeholder: "Enter @username",
        type: "text",
        required: true,
        validators: [
          {
            validatorName: "revTag",
            pattern: "^[a-zA-Z0-9_-]+$",
            message: "RevTag must contain only letters, numbers, underscores or hyphens",
          },
        ],
      },
    ],
  },
  "EUR:wise:wise-tag": {
    currency: PAYMENT_DATA.EUR.currency,
    method: PAYMENT_DATA.EUR.paymentMethods[1],
    network: PAYMENT_DATA.EUR.paymentMethods[1].networks[0],
    selectedFormatId: undefined,
    networkConfig: {
      slug: "wise-tag",
      name: "Wise Tag",
      description: "Wise Tag",
      fields: [
        {
          field: "email",
          label: "Wise Email",
          description: "Email linked to the recipient's Wise account",
          placeholder: "name@example.com",
          type: "text",
          required: true,
          validators: [{ validatorName: "email", message: "Invalid email format" }],
        },
      ],
      formats: [],
    },
    fields: [
      {
        field: "email",
        label: "Wise Email",
        description: "Email linked to the recipient's Wise account",
        placeholder: "name@example.com",
        type: "text",
        required: true,
        validators: [{ validatorName: "email", message: "Invalid email format" }],
      },
    ],
  },
  "EUR:wise:iban-sepa": {
    currency: PAYMENT_DATA.EUR.currency,
    method: PAYMENT_DATA.EUR.paymentMethods[1],
    network: PAYMENT_DATA.EUR.paymentMethods[1].networks[1],
    selectedFormatId: undefined,
    networkConfig: {
      slug: "iban-sepa",
      name: "European Transfer (SEPA)",
      description: "European Transfer (SEPA)",
      fields: [
        {
          field: "iban",
          label: "IBAN",
          description: "Recipient IBAN",
          placeholder: "EE382200221020145685",
          type: "text",
          required: true,
          validators: [{ validatorName: "iban", message: "Invalid IBAN format" }],
        },
        {
          field: "full_name",
          label: "Full Name",
          description: "Recipient legal name",
          placeholder: "Recipient full name",
          type: "text",
          required: true,
          validators: [{ validatorName: "fullName", message: "Invalid full name" }],
        },
      ],
      formats: [],
    },
    fields: [
      {
        field: "iban",
        label: "IBAN",
        description: "Recipient IBAN",
        placeholder: "EE382200221020145685",
        type: "text",
        required: true,
        validators: [{ validatorName: "iban", message: "Invalid IBAN format" }],
      },
      {
        field: "full_name",
        label: "Full Name",
        description: "Recipient legal name",
        placeholder: "Recipient full name",
        type: "text",
        required: true,
        validators: [{ validatorName: "fullName", message: "Invalid full name" }],
      },
    ],
  },
  "EUR:other-bank:iban-sepa": {
    currency: PAYMENT_DATA.EUR.currency,
    method: PAYMENT_DATA.EUR.paymentMethods[2],
    network: PAYMENT_DATA.EUR.paymentMethods[2].networks[0],
    selectedFormatId: undefined,
    networkConfig: {
      slug: "iban-sepa",
      name: "European Transfer (SEPA)",
      description: "European Transfer (SEPA)",
      fields: [
        {
          field: "iban",
          label: "IBAN",
          description: "Recipient IBAN",
          placeholder: "EE382200221020145685",
          type: "text",
          required: true,
          validators: [{ validatorName: "iban", message: "Invalid IBAN format" }],
        },
        {
          field: "full_name",
          label: "Full Name",
          description: "Recipient legal name",
          placeholder: "Recipient full name",
          type: "text",
          required: true,
          validators: [{ validatorName: "fullName", message: "Invalid full name" }],
        },
        {
          field: "bank_name",
          label: "Bank Name",
          description: "Receiving bank name",
          placeholder: "Bank name",
          type: "text",
          required: true,
          validators: [],
        },
      ],
      formats: [],
    },
    fields: [
      {
        field: "iban",
        label: "IBAN",
        description: "Recipient IBAN",
        placeholder: "EE382200221020145685",
        type: "text",
        required: true,
        validators: [{ validatorName: "iban", message: "Invalid IBAN format" }],
      },
      {
        field: "full_name",
        label: "Full Name",
        description: "Recipient legal name",
        placeholder: "Recipient full name",
        type: "text",
        required: true,
        validators: [{ validatorName: "fullName", message: "Invalid full name" }],
      },
      {
        field: "bank_name",
        label: "Bank Name",
        description: "Receiving bank name",
        placeholder: "Bank name",
        type: "text",
        required: true,
        validators: [],
      },
    ],
  },
  "NGN:kuda-bank:nip-nigeria": {
    currency: PAYMENT_DATA.NGN.currency,
    method: PAYMENT_DATA.NGN.paymentMethods[0],
    network: PAYMENT_DATA.NGN.paymentMethods[0].networks[0],
    selectedFormatId: "banks",
    networkConfig: {
      slug: "nip-nigeria",
      name: "NIP Nigeria",
      description: "NIP Nigeria",
      countryCode: "NG",
      fields: [
        {
          field: "account_number",
          label: "Account Number",
          description: "10-digit account number",
          placeholder: "0123456789",
          type: "text",
          required: true,
          validators: [{ validatorName: "accountNumber", pattern: "^\\d{10}$", message: "Account number must be 10 digits" }],
        },
        {
          field: "full_name",
          label: "Full Name",
          description: "Optional account name",
          placeholder: "Recipient full name",
          type: "text",
          required: false,
          validators: [{ validatorName: "fullName", message: "Invalid full name" }],
        },
      ],
      formats: [],
    },
    fields: [
      {
        field: "account_number",
        label: "Account Number",
        description: "10-digit account number",
        placeholder: "0123456789",
        type: "text",
        required: true,
        validators: [{ validatorName: "accountNumber", pattern: "^\\d{10}$", message: "Account number must be 10 digits" }],
      },
      {
        field: "full_name",
        label: "Full Name",
        description: "Optional account name",
        placeholder: "Recipient full name",
        type: "text",
        required: false,
        validators: [{ validatorName: "fullName", message: "Invalid full name" }],
      },
    ],
  },
  "KES:m-pesa:pesalink": {
    currency: PAYMENT_DATA.KES.currency,
    method: PAYMENT_DATA.KES.paymentMethods[0],
    network: PAYMENT_DATA.KES.paymentMethods[0].networks[0],
    selectedFormatId: "mobile-money",
    networkConfig: {
      slug: "pesalink",
      name: "Pesalink",
      description: "Pesalink",
      countryCode: "KE",
      fields: [
        {
          field: "phone_number",
          label: "Phone Number",
          description: "Kenyan mobile number",
          placeholder: "+254712345678",
          type: "text",
          required: true,
          validators: [{ validatorName: "internationalPhone", message: "Invalid phone number" }],
        },
      ],
      formats: [],
    },
    fields: [
      {
        field: "phone_number",
        label: "Phone Number",
        description: "Kenyan mobile number",
        placeholder: "+254712345678",
        type: "text",
        required: true,
        validators: [{ validatorName: "internationalPhone", message: "Invalid phone number" }],
      },
    ],
  },
};

function makeFieldConfigKey(currency: string, methodSlug?: string, networkSlug?: string) {
  return `${currency.toUpperCase()}:${methodSlug}:${networkSlug}`;
}

async function stubGetPaymentMethodsForCurrency(currency: string): Promise<CurrencyPaymentData> {
  const data = PAYMENT_DATA[currency.toUpperCase()];
  if (!data) throw new Error(`Unsupported test currency ${currency}`);
  return data;
}

async function stubGetPaymentMethodFieldConfig(params: {
  currency: string;
  methodSlug?: string;
  methodId?: number;
  networkSlug?: string;
  networkId?: number;
}): Promise<ResolvedPaymentMethodFieldConfig> {
  const data = PAYMENT_DATA[params.currency.toUpperCase()];
  const method = data.paymentMethods.find((entry) => entry.id === params.methodId || entry.slug === params.methodSlug);
  if (!method) throw new Error(`Method not found for test config: ${JSON.stringify(params)}`);
  const network = params.networkId
    ? method.networks.find((entry) => entry.id === params.networkId)
    : params.networkSlug
      ? method.networks.find((entry) => entry.slug === params.networkSlug)
      : method.networks.find((entry) => entry.default) || method.networks[0];
  if (!network) throw new Error(`Network not found for test config: ${JSON.stringify(params)}`);
  const config = FIELD_CONFIGS[makeFieldConfigKey(params.currency, method.slug, network.slug)];
  if (!config) throw new Error(`Field config not found for test config: ${JSON.stringify(params)}`);
  return config;
}

function makeClient(options: {
  balance?: number;
  waitMode?: "matched" | "no_match" | "timeout";
  matchedTradeStatus?: string;
  getTradeStatuses?: string[];
  confirmFiatReceivedStatus?: string;
  confirmFiatReceivedError?: string;
  username?: string;
} = {}): TransferExecutionClient & { calls: string[] } {
  const calls: string[] = [];
  const balance = options.balance ?? 1000;
  const waitMode = options.waitMode ?? "matched";
  const username = options.username ?? "grape404";
  let currentTradeStatus = options.matchedTradeStatus ?? "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer";
  const tradeStatuses = [...(options.getTradeStatuses || [currentTradeStatus])];
  let tradeStatusIndex = 0;

  return {
    calls,
    async getProfile() {
      calls.push("getProfile");
      return { username };
    },
    async getWalletBalance(): Promise<WalletBalance> {
      calls.push("getWalletBalance");
      return { usdc: balance, usdt: 0, totalUsd: balance };
    },
    async ensurePaymentDetail(): Promise<PaymentDetail> {
      calls.push("ensurePaymentDetail");
      return { id: 9001, fiat_currency_code: "EUR", details: {} } as PaymentDetail;
    },
    async createTradeRequest(): Promise<TradeRequest> {
      calls.push("createTradeRequest");
      return { id: 7001, status: "created", trade_type: "SELL" } as TradeRequest;
    },
    async waitForTradeMatch(): Promise<TradeRequest> {
      calls.push("waitForTradeMatch");
      if (waitMode === "matched") {
        return {
          id: 7001,
          status: "accepted_by_vendor",
          trade_type: "SELL",
          trade: { id: 8801, status: currentTradeStatus },
        } as TradeRequest;
      }
      if (waitMode === "no_match") {
        throw new Error("Trade request 7001 ended: not_accepted_by_any_vendor");
      }
      throw new Error("Trade request 7001 timed out after 120s");
    },
    async getTradeRequest(): Promise<TradeRequest> {
      calls.push("getTradeRequest");
      return { id: 7001, status: waitMode === "matched" ? "accepted_by_vendor" : "created", trade_type: "SELL", trade: { id: 8801, status: currentTradeStatus } } as TradeRequest;
    },
    async getTrade() {
      calls.push("getTrade");
      const next = tradeStatuses[Math.min(tradeStatusIndex, tradeStatuses.length - 1)] || currentTradeStatus;
      tradeStatusIndex += 1;
      currentTradeStatus = next;
      return { id: 8801, status: currentTradeStatus, payment_window_seconds_left: 900, claim_autorelease_seconds_left: 1800 };
    },
    async confirmFiatReceived() {
      calls.push("confirmFiatReceived");
      if (options.confirmFiatReceivedError) {
        throw new Error(options.confirmFiatReceivedError);
      }
      currentTradeStatus = options.confirmFiatReceivedStatus ?? "fiat_payment_confirmed_by_seller_escrow_release_started";
      tradeStatuses.push(currentTradeStatus);
      return { id: 8801, status: currentTradeStatus };
    },
  };
}

function makeDeps(contactsFilePath: string, client: ReturnType<typeof makeClient>, overrides: Partial<TransferFlowDeps> = {}): TransferFlowDeps {
  return {
    contactsFilePath,
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: true, evmSigningKeyAvailable: true },
    client,
    waitForSettlementTimeoutMs: 1,
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
  assert.match(res.reply, /@grape404/i);

  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.equal(res.session.status, "active");
  assert.ok(res.events.some((event) => event.type === "trade_request_created"));
  assert.ok(res.events.some((event) => event.type === "trade_matched"));
  assert.ok(res.events.some((event) => event.type === "settlement_monitor_started"));
  assert.match(res.reply, /keep escrow locked/i);
  assert.deepEqual(client.calls.slice(0, 8), ["getProfile", "getWalletBalance", "getWalletBalance", "ensurePaymentDetail", "createTradeRequest", "waitForTradeMatch", "getTradeRequest", "getTrade"]);

  const contacts = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(contacts.contacts["john-doe"].paymentMethods.EUR.methodSlug, "revolut");
  assert.equal(contacts.contacts["john-doe"].paymentMethods.EUR.networkSlug, "revolut-username");
  assert.equal(contacts.contacts["john-doe"].paymentMethods.EUR.details.revtag, "john_doe");
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
  assert.match(res.reply, /IBAN \/ bank account/i);

  res = await advanceTransferFlow(res.session, "EE382200221020145685", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /Full Name/i);
});

test("bank-style SEPA flows collect bank name when required", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("save a contact", deps);
  res = await advanceTransferFlow(res.session, "new recipient", deps);
  res = await advanceTransferFlow(res.session, "Bank Person", deps);
  res = await advanceTransferFlow(res.session, "EUR", deps);
  res = await advanceTransferFlow(res.session, "Other Bank", deps);

  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /IBAN \/ bank account/i);

  res = await advanceTransferFlow(res.session, "EE382200221020145685", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /Full Name/i);

  res = await advanceTransferFlow(res.session, "Bank Person", deps);
  assert.equal(res.session.stage, "awaiting_payment_details");
  assert.match(res.reply, /Which bank should receive this payout/i);
});

test("insufficient balance blocks before trade creation and before confirmation", async () => {
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
  assert.match(res.reply, /will not place the trade/i);
  assert.deepEqual(client.calls, ["getProfile", "getWalletBalance", "getWalletBalance"]);
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
    getTradeStatuses: ["fiat_payment_proof_submitted_by_buyer", "fiat_payment_confirmed_by_seller_escrow_release_started"],
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
  const client = makeClient();
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 20 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");

  res = await advanceTransferFlow(res.session, "not received", deps);
  assert.equal(res.session.stage, "awaiting_manual_settlement_followup");
  assert.equal(res.session.status, "active");
  assert.ok(res.events.some((event) => event.type === "receipt_not_received"));
  assert.match(res.reply, /keeping escrow locked/i);
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
  const client = makeClient();
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

  const client = makeClient();
  const base = new Date("2026-03-25T14:00:00.000Z");
  let current = base.getTime();
  const deps = makeDeps(file, client, {
    now: () => new Date(current),
    receiptReminderMs: 60_000,
    receiptTimeoutMs: 120_000,
  });

  let res = await startTransferFlow("send 20 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "confirm", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");

  current += 3 * 60_000;
  res = await advanceTransferFlow(res.session, "status", deps);
  assert.ok(res.events.some((event) => event.type === "receipt_confirmation_timeout"));
  assert.match(res.reply, /keep escrow locked/i);
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

test("detectAuthState recognizes split EVM login and signing keys", () => {
  const result = withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: "0xlogin",
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, () => detectAuthState());

  assert.equal(result.hasReplayableAuth, true);
  assert.equal(result.authMode, "evm");
  assert.equal(result.evmSigningKeyAvailable, true);
  assert.equal(result.emailFallbackAvailable, true);
});

test("loadUnigoxConfigFromEnv returns split EVM config when both EVM keys are available", () => {
  const result = withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: "0xlogin",
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, () => loadUnigoxConfigFromEnv());

  assert.equal(result.authMode, "evm");
  assert.equal(result.evmLoginPrivateKey, "0xlogin");
  assert.equal(result.evmSigningPrivateKey, "0xsign");
  assert.equal(result.email, "agent@example.com");
});

test("stored split EVM auth overrides stale injected auth state and shows username plus balance at flow start", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({ username: "stateful", balance: 250 });

  const res = await withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: "0xlogin",
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, async () => startTransferFlow("Hey I want to make a transfer", makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
  })));

  assert.equal(res.session.stage, "awaiting_recipient_mode");
  assert.match(res.reply, /@stateful/i);
  assert.match(res.reply, /Current wallet balance: 250\.00 USD/i);
  assert.doesNotMatch(res.reply, /Which wallet connection path should I use/i);
  assert.deepEqual(client.calls.slice(0, 2), ["getProfile", "getWalletBalance"]);
  assert.equal(res.events.some((event) => event.type === "blocked_missing_auth"), false);
});

test("stored EVM login without signing key skips auth-choice questions and asks only for the missing key", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({ username: "stateful", balance: 250 });

  const res = await withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: "0xlogin",
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: undefined,
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, async () => startTransferFlow("Hey I want to make a transfer", makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
  })));

  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /@stateful/i);
  assert.match(res.reply, /Current wallet balance: 250\.00 USD/i);
  assert.match(res.reply, /UNIGOX-exported EVM signing key/i);
  assert.doesNotMatch(res.reply, /Which wallet connection path should I use/i);
  assert.deepEqual(client.calls.slice(0, 2), ["getProfile", "getWalletBalance"]);
});

test("missing EVM auth asks the user to sign in on unigox.com before requesting the login key", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
  });

  const res = await startTransferFlow("send 50 EUR to mom", deps);
  const chooseEvm = await advanceTransferFlow(res.session, "evm", deps);

  assert.equal(chooseEvm.session.stage, "awaiting_evm_wallet_signin");
  assert.match(chooseEvm.reply, /Before I ask for any key/i);
  assert.match(chooseEvm.reply, /signed in on unigox\.com/i);
  assert.doesNotMatch(chooseEvm.reply, /paste the login wallet private key/i);

  const afterSignin = await advanceTransferFlow(chooseEvm.session, "done", deps);
  assert.equal(afterSignin.session.stage, "awaiting_evm_login_key");
  assert.match(afterSignin.reply, /Which wallet key did you use to sign in on UNIGOX/i);
  assert.match(afterSignin.reply, /NEWLY CREATED \/ ISOLATED wallet/i);
  assert.match(afterSignin.reply, /must NOT be your main wallet/i);
});

test("EVM login without exported signing key blocks before transfer execution", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, {
    authState: {
      hasReplayableAuth: true,
      authMode: "evm",
      emailFallbackAvailable: true,
      evmSigningKeyAvailable: false,
    },
  });

  const res = await startTransferFlow("send 50 EUR to mom", deps);

  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /UNIGOX-exported EVM signing key/i);
  assert.ok(res.events.some((event) => event.type === "blocked_missing_auth"));
});


test("failed EVM login verification stays on the login-key step and does not ask for the signing key", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
    verifyEvmLoginKey: async () => ({ success: false, message: "invalid key" }),
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "evm", deps);
  res = await advanceTransferFlow(res.session, "done", deps);
  res = await advanceTransferFlow(res.session, "0xbadlogin", deps);
  assert.equal(res.session.stage, "awaiting_secret_cleanup_confirmation");
  assert.match(res.reply, /delete the message/i);

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_evm_login_key");
  assert.match(res.reply, /didn't work/i);
  assert.doesNotMatch(res.reply, /UNIGOX EVM signing key/i);
});

test("successful EVM login verification asks for the separate signing key and then resumes the transfer flow", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const persisted = { login: [] as string[], signing: [] as string[] };
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
    verifyEvmLoginKey: async (loginKey) => ({ success: loginKey === "0xgoodlogin" }),
    persistEvmLoginKey: async (loginKey) => {
      persisted.login.push(loginKey);
    },
    persistEvmSigningKey: async (signingKey) => {
      persisted.signing.push(signingKey);
    },
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "evm", deps);
  res = await advanceTransferFlow(res.session, "done", deps);
  res = await advanceTransferFlow(res.session, "0xgoodlogin", deps);

  assert.equal(res.session.stage, "awaiting_secret_cleanup_confirmation");
  assert.match(res.reply, /delete the message/i);
  assert.deepEqual(persisted.login, []);

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /Login works/i);
  assert.match(res.reply, /@grape404/i);
  assert.match(res.reply, /separate UNIGOX EVM signing key/i);
  assert.match(res.reply, /must NOT be your main wallet/i);
  assert.deepEqual(persisted.login, ["0xgoodlogin"]);

  res = await advanceTransferFlow(res.session, "0xgoodsigning", deps);
  assert.equal(res.session.stage, "awaiting_secret_cleanup_confirmation");
  assert.match(res.reply, /UNIGOX-exported signing key/i);

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.deepEqual(persisted.signing, ["0xgoodsigning"]);
  assert.equal(res.session.stage, "awaiting_payment_method");
  assert.match(res.reply, /Which payout method should mom receive in EUR/i);
});


test("automatic secret deletion hook skips manual cleanup confirmation", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const persisted = { login: [] as string[], signing: [] as string[] };
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
    verifyEvmLoginKey: async (loginKey) => ({ success: loginKey === "0xgoodlogin", username: "autodelete" }),
    persistEvmLoginKey: async (loginKey) => {
      persisted.login.push(loginKey);
    },
    persistEvmSigningKey: async (signingKey) => {
      persisted.signing.push(signingKey);
    },
    handleSensitiveInput: async () => ({ deleted: true, note: "Deleted automatically." }),
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "evm", deps);
  res = await advanceTransferFlow(res.session, "done", deps);
  res = await advanceTransferFlow(res.session, "0xgoodlogin", deps);

  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.ok(res.events.some((event) => event.type === "secret_message_deleted"));
  assert.deepEqual(persisted.login, ["0xgoodlogin"]);

  res = await advanceTransferFlow(res.session, "0xgoodsigning", deps);
  assert.equal(res.session.stage, "awaiting_payment_method");
  assert.ok(res.events.some((event) => event.type === "secret_message_deleted"));
  assert.deepEqual(persisted.signing, ["0xgoodsigning"]);
});
