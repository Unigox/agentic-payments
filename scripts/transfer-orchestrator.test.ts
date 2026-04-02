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
  DepositFlowSelection,
  InitiatorTradeSummary,
  KycVerificationData,
  NetworkFieldConfig,
  PartnerPaymentDetailsDiffData,
  PaymentDetail,
  PreflightQuote,
  ResolvedPaymentMethodFieldConfig,
  SupportedDepositAssetOption,
  TradeRequest,
  UserProfile,
  WalletBalance,
} from "./unigox-client.ts";
import type { TransferExecutionClient, TransferFlowDeps } from "./transfer-orchestrator.ts";

const VALID_LOGIN_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const VALID_SIGNING_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const ANOTHER_VALID_KEY = "0x3333333333333333333333333333333333333333333333333333333333333333";
const VALID_TON_MNEMONIC = "hospital stove relief fringe tongue always charge angry urge sentence again match nerve inquiry senior coconut label tumble carry category beauty bean road solution";
const VALID_TON_PRIVATE_KEY = "4444444444444444444444444444444444444444444444444444444444444444";

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
  INR: {
    currency: { code: "INR", name: "Indian Rupee" },
    paymentMethods: [
      {
        id: 2001,
        name: "IMPS or NEFT Transfer",
        slug: "imps-or-neft-transfer",
        type: "Traditional Banks",
        typeSlug: "traditional-banks",
        fiatCurrencyCodes: ["INR"],
        networks: [
          { id: 551, name: "IMPS or NEFT India", slug: "imps-neft-india", fiatCurrencyCode: "INR", default: true },
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
  "INR:imps-or-neft-transfer:imps-neft-india": {
    currency: PAYMENT_DATA.INR.currency,
    method: PAYMENT_DATA.INR.paymentMethods[0],
    network: PAYMENT_DATA.INR.paymentMethods[0].networks[0],
    selectedFormatId: undefined,
    networkConfig: {
      slug: "imps-neft-india",
      name: "IMPS or NEFT India",
      description: "IMPS or NEFT India",
      countryCode: "IN",
      fields: [
        {
          field: "bank_name",
          label: "Bank Name",
          description: "Receiving bank name",
          placeholder: "Example Bank",
          type: "text",
          required: true,
          validators: [],
        },
        {
          field: "ifsc_code",
          label: "IFSC Code",
          description: "Recipient bank IFSC code",
          placeholder: "TEST0001234",
          type: "text",
          required: true,
          validators: [{ validatorName: "ifscCode", message: "IFSC code must be 11 characters (e.g., HDFC0001234)" }],
        },
        {
          field: "account_number",
          label: "Account Number",
          description: "Recipient bank account number",
          placeholder: "123456789012",
          type: "text",
          required: true,
          validators: [{ validatorName: "indiaBankAccount", message: "Account number must be 10-16 digits" }],
        },
        {
          field: "full_name",
          label: "Full Name",
          description: "Recipient legal name",
          placeholder: "Bhim Example",
          type: "text",
          required: true,
          validators: [{ validatorName: "fullName", message: "Invalid full name" }],
        },
      ],
      formats: [],
    },
    fields: [
      {
        field: "bank_name",
        label: "Bank Name",
        description: "Receiving bank name",
        placeholder: "Example Bank",
        type: "text",
        required: true,
        validators: [],
      },
      {
        field: "ifsc_code",
        label: "IFSC Code",
        description: "Recipient bank IFSC code",
        placeholder: "TEST0001234",
        type: "text",
        required: true,
        validators: [{ validatorName: "ifscCode", message: "IFSC code must be 11 characters (e.g., HDFC0001234)" }],
      },
      {
        field: "account_number",
        label: "Account Number",
        description: "Recipient bank account number",
        placeholder: "123456789012",
        type: "text",
        required: true,
        validators: [{ validatorName: "indiaBankAccount", message: "Account number must be 10-16 digits" }],
      },
      {
        field: "full_name",
        label: "Full Name",
        description: "Recipient legal name",
        placeholder: "Bhim Example",
        type: "text",
        required: true,
        validators: [{ validatorName: "fullName", message: "Invalid full name" }],
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

const DEPOSIT_OPTIONS: SupportedDepositAssetOption[] = [
  {
    assetCode: "USDC",
    tokenCodes: ["USDC"],
    chains: [
      {
        assetCode: "USDC",
        tokenCode: "USDC",
        tokenName: "USD Coin",
        tokenAddress: "0xusdc",
        chainId: 1,
        chainName: "Ethereum",
        chainType: "EVM",
        addressKey: "evmAddress",
      },
      {
        assetCode: "USDC",
        tokenCode: "USDC",
        tokenName: "USD Coin",
        tokenAddress: "So11111111111111111111111111111111111111112",
        chainId: 1399811149,
        chainName: "Solana",
        chainType: "Solana",
        addressKey: "solanaAddress",
      },
    ],
  },
  {
    assetCode: "USDT",
    tokenCodes: ["USDT"],
    chains: [
      {
        assetCode: "USDT",
        tokenCode: "USDT",
        tokenName: "Tether USD",
        tokenAddress: "TetherTronToken",
        chainId: 728126428,
        chainName: "Tron",
        chainType: "TVM",
        addressKey: "tronAddress",
      },
      {
        assetCode: "USDT",
        tokenCode: "USDT",
        tokenName: "Tether USD",
        tokenAddress: "TonTokenAddress",
        chainId: -239,
        chainName: "TON",
        chainType: "TON",
        addressKey: "tonAddress",
      },
    ],
  },
];

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
  balances?: Partial<Record<"USDC" | "USDT", number>>;
  paymentDetails?: PaymentDetail[];
  initiatorTrades?: InitiatorTradeSummary[];
  waitMode?: "matched" | "no_match" | "timeout" | "new_price";
  matchedTradeStatus?: string;
  getTradeStatuses?: string[];
  tradeOverrides?: Record<string, unknown>;
  tradeRequestOverrides?: Partial<TradeRequest>;
  fundTradeEscrowStatusAfter?: string;
  fundTradeEscrowError?: string;
  revalidateTradeStatusAfter?: string;
  partnerPaymentDetailsDiff?: PartnerPaymentDetailsDiffData;
  confirmFiatReceivedStatus?: string;
  confirmFiatReceivedError?: string;
  username?: string;
  depositOptions?: SupportedDepositAssetOption[];
  preflightQuote?: Partial<PreflightQuote>;
  preflightQuotesByAsset?: Partial<Record<"USDC" | "USDT", Partial<PreflightQuote> | null>>;
  profile?: Partial<UserProfile>;
  kycStatus?: KycVerificationData;
  initializeKycResponse?: KycVerificationData;
  createTradeRequestError?: string;
  requestEmailOtpError?: string;
  verifyEmailOtpError?: string;
  verifyEmailOtpToken?: string;
} = {}): TransferExecutionClient & {
  calls: string[];
  lastCreateTradeRequestParams?: {
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
  };
} {
  const calls: string[] = [];
  const usdcBalance = options.balances?.USDC ?? options.balance ?? 1000;
  const usdtBalance = options.balances?.USDT ?? 0;
  const totalBalance = usdcBalance + usdtBalance;
  const paymentDetails = options.paymentDetails ?? [];
  const initiatorTrades = options.initiatorTrades ?? [];
  const waitMode = options.waitMode ?? "matched";
  const username = options.username ?? "grape404";
  const depositOptions = options.depositOptions ?? DEPOSIT_OPTIONS;
  const profile: UserProfile = {
    user_id: 42,
    evm_address: "0xprofile",
    username,
    first_name: undefined,
    last_name: undefined,
    kyc_country_code: undefined,
    id_verification_status: "NOT_VERIFIED",
    total_traded_volume_usd: 0,
    ...options.profile,
    username,
  };
  let currentTradeStatus = options.matchedTradeStatus ?? "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer";
  const tradeStatuses = [...(options.getTradeStatuses || [currentTradeStatus])];
  const fundTradeEscrowStatusAfter = options.fundTradeEscrowStatusAfter ?? "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer";
  const revalidateTradeStatusAfter = options.revalidateTradeStatusAfter ?? "awaiting_escrow_funding_by_seller";
  const partnerPaymentDetailsDiff = options.partnerPaymentDetailsDiff;
  let tradeStatusIndex = 0;

  const client: TransferExecutionClient & { calls: string[]; lastCreateTradeRequestParams?: any } = {
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
      return { id: 9001, fiat_currency_code: "EUR", details: {} } as PaymentDetail;
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
    async requestEmailOTP(): Promise<void> {
      calls.push("requestEmailOTP");
      if (options.requestEmailOtpError) {
        throw new Error(options.requestEmailOtpError);
      }
    },
    async verifyEmailOTP(code: string): Promise<string> {
      calls.push(`verifyEmailOTP:${code}`);
      if (options.verifyEmailOtpError) {
        throw new Error(options.verifyEmailOtpError);
      }
      return options.verifyEmailOtpToken ?? "email-token";
    },
    async getPreflightQuote(params): Promise<PreflightQuote | undefined> {
      const assetCode = (params.cryptoCurrencyCode || "USDC") as "USDC" | "USDT";
      calls.push(`getPreflightQuote:${assetCode}:${params.fiatAmount}`);
      const override = options.preflightQuotesByAsset?.[assetCode];
      if (override === null) return undefined;
      return {
        quoteType: "estimate",
        source: "best_offer",
        cryptoCurrencyCode: assetCode,
        fiatCurrencyCode: "EUR",
        fiatAmount: params.fiatAmount,
        totalCryptoAmount: params.fiatAmount + 1.25,
        feeCryptoAmount: 0.25,
        vendorOfferRate: 0.95,
        paymentMethodName: "Revolut",
        paymentNetworkName: "Revolut Username",
        ...options.preflightQuote,
        ...override,
        cryptoCurrencyCode: override?.cryptoCurrencyCode || options.preflightQuote?.cryptoCurrencyCode || assetCode,
      };
    },
    async createTradeRequest(params): Promise<TradeRequest> {
      calls.push("createTradeRequest");
      if (options.createTradeRequestError) {
        throw new Error(options.createTradeRequestError);
      }
      client.lastCreateTradeRequestParams = params;
      return { id: 7001, status: "created", trade_type: "SELL", ...options.tradeRequestOverrides } as TradeRequest;
    },
    async waitForTradeMatch(): Promise<TradeRequest> {
      calls.push("waitForTradeMatch");
      if (waitMode === "matched") {
        return {
          id: 7001,
          status: "accepted_by_vendor",
          trade_type: "SELL",
          trade: { id: 8801, status: currentTradeStatus },
          ...options.tradeRequestOverrides,
        } as TradeRequest;
      }
      if (waitMode === "new_price") {
        return {
          id: 7001,
          status: "new_price_confirming_by_initiator",
          trade_type: "SELL",
          fiat_currency_code: "EUR",
          crypto_currency_code: "USDT",
          fiat_amount: 40.82,
          total_crypto_amount: 50,
          best_deal_fiat_amount: 50,
          best_deal_crypto_amount: 60.795681,
          vendor_offer_rate: 0.8164,
          payment_method_name: "Wise",
          payment_network_name: "European Transfer (SEPA)",
          ...options.tradeRequestOverrides,
        } as TradeRequest;
      }
      if (waitMode === "no_match") {
        throw new Error("Trade request 7001 ended: not_accepted_by_any_vendor");
      }
      throw new Error("Trade request 7001 timed out after 120s");
    },
    async getTradeRequest(): Promise<TradeRequest> {
      calls.push("getTradeRequest");
      return {
        id: 7001,
        status: waitMode === "matched"
          ? "accepted_by_vendor"
          : waitMode === "new_price"
            ? "new_price_confirming_by_initiator"
            : "created",
        trade_type: "SELL",
        trade: { id: 8801, status: currentTradeStatus },
        fiat_currency_code: "EUR",
        crypto_currency_code: "USDT",
        fiat_amount: 40.82,
        total_crypto_amount: 50,
        best_deal_fiat_amount: 50,
        best_deal_crypto_amount: 60.795681,
        vendor_offer_rate: 0.8164,
        payment_method_name: "Wise",
        payment_network_name: "European Transfer (SEPA)",
        ...options.tradeRequestOverrides,
      } as TradeRequest;
    },
    async confirmTradeRequestPrice(): Promise<TradeRequest> {
      calls.push("confirmTradeRequestPrice");
      return {
        id: 7001,
        status: "accepted_by_vendor",
        trade_type: "SELL",
        trade: { id: 8801, status: currentTradeStatus },
        ...options.tradeRequestOverrides,
      } as TradeRequest;
    },
    async refuseTradeRequestPrice(): Promise<TradeRequest> {
      calls.push("refuseTradeRequestPrice");
      return {
        id: 7001,
        status: "new_price_refused_by_initiator",
        trade_type: "SELL",
        ...options.tradeRequestOverrides,
      } as TradeRequest;
    },
    async getTrade() {
      calls.push("getTrade");
      const next = tradeStatuses[Math.min(tradeStatusIndex, tradeStatuses.length - 1)] || currentTradeStatus;
      tradeStatusIndex += 1;
      currentTradeStatus = next;
      return {
        id: 8801,
        status: currentTradeStatus,
        escrow_address: "0xEscrowAddress0000000000000000000000000000001",
        payment_window_seconds_left: 900,
        claim_autorelease_seconds_left: 1800,
        ...options.tradeOverrides,
      };
    },
    async getPartnerPaymentDetailsDiff() {
      calls.push("getPartnerPaymentDetailsDiff");
      if (!partnerPaymentDetailsDiff) {
        return {
          payment_details_id: 9001,
          differences: {
            missing_fields: [],
            invalid_fields: [],
          },
        };
      }
      return partnerPaymentDetailsDiff;
    },
    async createOrUpdatePartnerPaymentDetails(params: { internalDetailsId: number; partner: string; details: Record<string, string> }) {
      calls.push(`createOrUpdatePartnerPaymentDetails:${params.internalDetailsId}:${params.partner}`);
      return {
        internal_details_id: params.internalDetailsId,
        partner: params.partner,
        details: params.details,
      };
    },
    async revalidateTradePaymentDetails() {
      calls.push("revalidateTradePaymentDetails");
      currentTradeStatus = revalidateTradeStatusAfter;
      tradeStatuses.push(currentTradeStatus);
      return {
        trade: {
          id: 8801,
          status: currentTradeStatus,
        },
      };
    },
    async fundTradeEscrow(tokenCode: "USDC" | "USDT", amount: string, escrowAddress: string) {
      calls.push(`fundTradeEscrow:${tokenCode}:${amount}:${escrowAddress}`);
      if (options.fundTradeEscrowError) {
        throw new Error(options.fundTradeEscrowError);
      }
      currentTradeStatus = fundTradeEscrowStatusAfter;
      tradeStatuses.push(currentTradeStatus);
      return { txId: 5001, txHash: "0xescrowfunded" };
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
    async getSupportedDepositOptions(): Promise<SupportedDepositAssetOption[]> {
      calls.push("getSupportedDepositOptions");
      return depositOptions;
    },
    async describeDepositSelection(selection: DepositFlowSelection) {
      calls.push(`describeDepositSelection:${selection.assetCode}:${selection.chainId}`);
      const asset = depositOptions.find((entry) => entry.assetCode === selection.assetCode);
      const chain = asset?.chains.find((entry) => entry.chainId === selection.chainId);
      if (!asset || !chain) throw new Error(`Unsupported test deposit selection: ${JSON.stringify(selection)}`);
      const addresses = {
        evmAddress: "0xEvmDepositAddress",
        solanaAddress: "So1anaDepositAddress111111111111111111111111111",
        tronAddress: "TRON-DEPOSIT-ADDRESS",
        tonAddress: "TON-DEPOSIT-ADDRESS",
      } as const;
      return {
        ...chain,
        depositAddress: addresses[chain.addressKey],
      };
    },
  };

  return client;
}

function makeDeps(contactsFilePath: string, client: ReturnType<typeof makeClient>, overrides: Partial<TransferFlowDeps> = {}): TransferFlowDeps {
  return {
    contactsFilePath,
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: true, evmSigningKeyAvailable: true },
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
  assert.match(res.reply, /@grape404/i);

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
  assert.ok(client.calls.includes("fundTradeEscrow:USDT:60.768185:0xEscrowAddress0000000000000000000000000000001"));
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
      payment_details_id: 9001,
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
  assert.ok(client.calls.includes("fundTradeEscrow:USDC:60.740716:0xEscrowAddress0000000000000000000000000000001"));
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
      payment_details_id: 9001,
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
  assert.ok(client.calls.includes("fundTradeEscrow:USDC:60.740716:0xEscrowAddress0000000000000000000000000000001"));
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
      payment_details_id: 9001,
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

test("new vendor price requires explicit confirmation before funding", async () => {
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
  assert.match(res.reply, /40\.82 EUR/i);
  assert.match(res.reply, /50 USDT/i);
  assert.match(res.reply, /I have not funded escrow/i);
  assert.ok(res.events.some((event) => event.type === "trade_price_changed"));
  assert.ok(!client.calls.some((call) => call.startsWith("fundTradeEscrow:")));

  res = await advanceTransferFlow(res.session, "confirm new price", deps);
  assert.equal(res.session.stage, "awaiting_trade_settlement");
  assert.ok(client.calls.includes("confirmTradeRequestPrice"));
  assert.ok(client.calls.includes("fundTradeEscrow:USDT:60.795681:0xEscrowAddress0000000000000000000000000000001"));
  assert.match(res.reply, /The transfer is live and escrow is funded/i);
});

test("new vendor price can be cancelled cleanly", async () => {
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
  assert.ok(client.calls.includes("refuseTradeRequestPrice"));
  assert.match(res.reply, /cancelled that updated quote/i);
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

test("remote saved UNIGOX payout details resolve directly when the send amount is already specified", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 71 },
    paymentDetails: [
      {
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
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
  assert.match(res.reply, /signed in as @grape404/i);
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
        id: 7098,
        status: "fiat_payment_proof_submitted_by_buyer",
        fiat_amount: 50,
        fiat_currency_code: "EUR",
        status_changed_at: "2026-03-27T01:02:03.000Z",
        initiator_payment_details: {
          id: 3413,
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
        id: 7098,
        status: "fiat_payment_proof_submitted_by_buyer",
        fiat_amount: 50,
        fiat_currency_code: "EUR",
        status_changed_at: "2026-03-27T01:02:03.000Z",
        initiator_payment_details: {
          id: 3413,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
  assert.match(res.reply, /1\. You give me your full name and country\./i);
  assert.match(res.reply, /2\. I give you a secure link for the third-party KYC service\./i);
  assert.match(res.reply, /You can also complete the same KYC directly in the UNIGOX website or app if you prefer\./i);
  assert.match(res.reply, /First, what full legal name should I use for the verification\?/i);
  assert.ok(client.calls.includes("getProfile"));
  assert.ok(client.calls.includes("getKycVerificationStatus"));
  assert.ok(!client.calls.includes("createTradeRequest"));
});

test("preflight KYC gating asks only for country when the full name is already known", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
  assert.match(res.reply, /You can also complete the same KYC directly from the UNIGOX website or app/i);
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

test("verified profile is not downgraded by a stale active KYC session", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "VERIFIED",
      total_traded_volume_usd: 58,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "VERIFIED",
      total_traded_volume_usd: 58,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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

test("KYC start surfaces auth failure instead of pretending the verification link is on the way", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
      first_name: "Alex",
      last_name: "Grape",
      kyc_country_code: "EE",
    },
    initializeKycResponse: {
      error_key: "invalid_auth_token",
    },
    kycStatus: {
      error_key: "invalid_auth_token",
    },
  });
  const deps = makeDeps(file, client);

  const res = await startTransferFlow("send 60 EUR to Aleksandr", deps);

  assert.equal(res.session.stage, "awaiting_kyc_completion");
  assert.match(res.reply, /couldn't fetch the secure verification link from chat on this machine right now/i);
  assert.match(res.reply, /open KYC directly in the UNIGOX website or app/i);
  assert.doesNotMatch(res.reply, /verification link is ready/i);
  assert.doesNotMatch(res.reply, /has started the verification/i);
});

test("awaiting KYC completion keeps polling until the verification link becomes available", async () => {
  const { file } = makeTempContactsFile();
  let pollCount = 0;
  const client = makeClient({
    balances: { USDC: 1, USDT: 110.2 },
    paymentDetails: [
      {
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 40,
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
        id: 3413,
        fiat_currency_code: "EUR",
        payment_method: { id: 1, name: "Wise", slug: "wise" },
        payment_network: { id: 48, name: "European Transfer (SEPA)", slug: "iban-sepa" },
        details: {
          iban: "EE382200221020145685",
          full_name: "Aleksandr Example",
        },
      },
    ],
    profile: {
      id_verification_status: "NOT_VERIFIED",
      total_traded_volume_usd: 0,
      first_name: undefined,
      last_name: undefined,
      kyc_country_code: undefined,
    },
    preflightQuotesByAsset: {
      USDC: { totalCryptoAmount: 51.1, feeCryptoAmount: 0.3, vendorOfferRate: 0.823 },
      USDT: { totalCryptoAmount: 50.8, feeCryptoAmount: 0.3, vendorOfferRate: 0.823 },
    },
    createTradeRequestError: "kyc_verification_needed",
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

test("India IMPS details validate and normalize placeholder IMPS payout fields", () => {
  const config = FIELD_CONFIGS["INR:imps-or-neft-transfer:imps-neft-india"];
  assert.ok(config);

  const result = validatePaymentDetailInput({
    bank_name: "Example Bank",
    ifsc_code: "test0001234",
    account_number: "123456789012",
    full_name: "Bhim Example",
  }, config.fields, {
    countryCode: config.networkConfig.countryCode,
    formatId: config.selectedFormatId,
  });

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

  await withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: VALID_LOGIN_KEY,
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: VALID_SIGNING_KEY,
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, async () => {
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
  });
});

test("insufficient balance blocks before trade creation and asks for top-up method first", async () => {
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
  assert.equal(res.session.stage, "awaiting_topup_method");
  assert.equal(res.session.status, "blocked");
  assert.ok(res.events.some((event) => event.type === "balance_checked"));
  assert.ok(res.events.some((event) => event.type === "blocked_insufficient_balance"));
  assert.match(res.reply, /Current best-offer estimate:/i);
  assert.match(res.reply, /26\.25 USDC total to deliver 25 EUR/i);
  assert.match(res.reply, /1 USDC ≈ 0\.95 EUR/i);
  assert.match(res.reply, /You need about 16\.25 USD more in one asset/i);
  assert.match(res.reply, /not a locked quote/i);
  assert.match(res.reply, /will not place the trade/i);
  assert.match(res.reply, /How would you like to top up the wallet/i);
  assert.match(res.reply, /Another UNIGOX user sends funds directly to your username/i);
  assert.match(res.reply, /External \/ on-chain deposit/i);
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

test("internal UNIGOX top-up shows username and skips token-chain questions", async () => {
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
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_topup_method");

  res = await advanceTransferFlow(res.session, "top up from another UNIGOX wallet", deps);
  assert.equal(res.session.stage, "awaiting_balance_resolution");
  assert.equal(res.session.topUp?.method, "internal_username");
  assert.match(res.reply, /@alexwallet/i);
  assert.match(res.reply, /Current best-offer estimate:/i);
  assert.match(res.reply, /You need about 16\.25 USD more in one asset/i);
  assert.match(res.reply, /send about 16\.25 USD more directly to @alexwallet inside UNIGOX/i);
  assert.match(res.reply, /not a locked quote/i);
  assert.doesNotMatch(res.reply, /Which token do you want to deposit/i);
  assert.doesNotMatch(res.reply, /Which network should I use/i);
  assert.deepEqual(client.calls, [
    "getProfile",
    "getWalletBalance",
    "listInitiatorTrades",
    "getProfile",
    "getWalletBalance",
    "ensurePaymentDetail",
    "getPreflightQuote:USDC:25",
    "getPreflightQuote:USDT:25",
    "getProfile",
  ]);
});

test("top-up flow accepts a natural topped-up reply, refreshes balance, and resumes with a fresh quote", async () => {
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
  assert.equal(res.session.stage, "awaiting_topup_method");
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

test("external top-up keeps token then chain then single-address flow", async () => {
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
  const deps = makeDeps(file, client);

  let res = await startTransferFlow("send 25 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_topup_method");

  res = await advanceTransferFlow(res.session, "external / on-chain deposit", deps);
  assert.equal(res.session.stage, "awaiting_external_deposit_asset");
  assert.match(res.reply, /which token do you want to deposit/i);
  assert.match(res.reply, /USDC, USDT/i);

  res = await advanceTransferFlow(res.session, "USDT", deps);
  assert.equal(res.session.stage, "awaiting_external_deposit_chain");
  assert.match(res.reply, /Which network should I use for USDT/i);
  assert.match(res.reply, /Tron, TON/i);

  res = await advanceTransferFlow(res.session, "Tron", deps);
  assert.equal(res.session.stage, "awaiting_balance_resolution");
  assert.match(res.reply, /Send USDT on Tron to this deposit address: TRON-DEPOSIT-ADDRESS/i);
  assert.match(res.reply, /single relevant address/i);
  assert.doesNotMatch(res.reply, /TON-DEPOSIT-ADDRESS/i);
  assert.deepEqual(client.calls, [
    "getProfile",
    "getWalletBalance",
    "listInitiatorTrades",
    "getProfile",
    "getWalletBalance",
    "ensurePaymentDetail",
    "getPreflightQuote:USDC:25",
    "getPreflightQuote:USDT:25",
    "getSupportedDepositOptions",
    "getSupportedDepositOptions",
    "getSupportedDepositOptions",
    "describeDepositSelection:USDT:728126428",
  ]);
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
  assert.equal(res.session.stage, "awaiting_topup_method");
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

test("detectAuthState recognizes split EVM login and signing keys", () => {
  const result = withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: "0xlogin",
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, () => detectAuthState());

  assert.equal(result.hasReplayableAuth, true);
  assert.equal(result.authMode, "evm");
  assert.equal(result.evmSigningKeyAvailable, true);
  assert.equal(result.emailFallbackAvailable, true);
});

test("detectAuthState recognizes TON private-key auth without requiring mnemonic env", () => {
  const result = withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: undefined,
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_PRIVATE_KEY: VALID_TON_PRIVATE_KEY,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, () => detectAuthState());

  assert.equal(result.hasReplayableAuth, true);
  assert.equal(result.authMode, "ton");
  assert.equal(result.evmSigningKeyAvailable, true);
  assert.equal(result.emailFallbackAvailable, true);
});

test("loadUnigoxConfigFromEnv returns split EVM config when both EVM keys are available", () => {
  const result = withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: "0xlogin",
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, () => loadUnigoxConfigFromEnv());

  assert.equal(result.authMode, "evm");
  assert.equal(result.evmLoginPrivateKey, "0xlogin");
  assert.equal(result.evmSigningPrivateKey, "0xsign");
  assert.equal(result.email, "agent@example.com");
});

test("loadUnigoxConfigFromEnv prefers TON private-key auth when present", () => {
  const result = withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: undefined,
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_PRIVATE_KEY: VALID_TON_PRIVATE_KEY,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_TON_ADDRESS: "0:abcd",
    UNIGOX_EMAIL: "agent@example.com",
  }, () => loadUnigoxConfigFromEnv());

  assert.equal(result.authMode, "ton");
  assert.equal(result.tonPrivateKey, VALID_TON_PRIVATE_KEY);
  assert.equal(result.tonAddress, "0:abcd");
  assert.equal(result.evmSigningPrivateKey, "0xsign");
  assert.equal(result.email, "agent@example.com");
});

test("stored split EVM auth overrides stale injected auth state and shows username plus split balance at flow start", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({ username: "stateful", balances: { USDC: 200, USDT: 50 } });

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
  assert.match(res.reply, /Current wallet balance: 250\.00 USD total/i);
  assert.match(res.reply, /USDC: 200\.00 USD/i);
  assert.match(res.reply, /USDT: 50\.00 USD/i);
  assert.doesNotMatch(res.reply, /Which wallet connection path should I use/i);
  assert.deepEqual(client.calls.slice(0, 2), ["getProfile", "getWalletBalance"]);
  assert.equal(res.events.some((event) => event.type === "blocked_missing_auth"), false);
});

test("stored EVM login without signing key skips auth-choice questions and asks only for the missing key", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient({ username: "stateful", balances: { USDC: 200, USDT: 50 } });

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
  assert.match(res.reply, /Current wallet balance: 250\.00 USD total/i);
  assert.match(res.reply, /USDC: 200\.00 USD/i);
  assert.match(res.reply, /USDT: 50\.00 USD/i);
  assert.match(res.reply, /UNIGOX-exported EVM signing key/i);
  assert.match(res.reply, /funding trade escrow|confirming fiat received|releasing escrow/i);
  assert.match(res.reply, /early beta access for agentic payments/i);
  assert.match(res.reply, /hello@unigox\.com|Intercom chat/i);
  assert.match(res.reply, /beta feature/i);
  assert.doesNotMatch(res.reply, /Which wallet connection path should I use/i);
  assert.deepEqual(client.calls.slice(0, 2), ["getProfile", "getWalletBalance"]);
});

test("stored auth added after a session starts still skips onboarding on the next turn", async () => {
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
  const client = makeClient({ username: "stateful", balances: { USDC: 200, USDT: 50 } });
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
  });

  let res = await withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: undefined,
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: undefined,
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: undefined,
  }, async () => startTransferFlow("send 20 EUR to mom", deps));

  assert.equal(res.session.stage, "awaiting_auth_choice");
  assert.match(res.reply, /Which wallet connection path should I use/i);

  res = await withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: "0xlogin",
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: "0xsign",
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "agent@example.com",
  }, async () => advanceTransferFlow(res.session, "continue", deps));

  assert.equal(res.session.stage, "awaiting_confirmation");
  assert.match(res.reply, /@stateful/i);
  assert.match(res.reply, /Current wallet balance: 250\.00 USD total/i);
  assert.doesNotMatch(res.reply, /Which wallet connection path should I use/i);
  assert.equal(res.events.some((event) => event.type === "blocked_missing_auth"), false);
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

test("email OTP choice asks for an email address when none is configured, then blocks early on the missing signing key after OTP verification", async () => {
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
  const client = makeClient({ username: "emailuser", verifyEmailOtpToken: "email-login-token" });
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
  });

  const res = await withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: undefined,
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: undefined,
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: undefined,
  }, async () => {
    let result = await startTransferFlow("send 20 EUR to mom", deps);
    assert.equal(result.session.stage, "awaiting_auth_choice");

    result = await advanceTransferFlow(result.session, "email OTP", deps);
    assert.equal(result.session.stage, "awaiting_email_address");
    assert.match(result.reply, /What email address should I use/i);

    result = await advanceTransferFlow(result.session, "eyesonaleks@gmail.com", deps);
    assert.equal(result.session.stage, "awaiting_email_otp");
    assert.match(result.reply, /I sent a 6-digit code to eyesonaleks@gmail.com/i);

    result = await advanceTransferFlow(result.session, "123456", deps);
    assert.equal(result.session.stage, "awaiting_evm_signing_key");
    assert.equal(result.session.auth.mode, "email");
    assert.equal(result.session.auth.emailAddress, "eyesonaleks@gmail.com");
    assert.equal(result.session.auth.emailAuthToken, "email-login-token");
    assert.match(result.reply, /UNIGOX-exported EVM signing key/i);
    assert.match(result.reply, /early beta access for agentic payments/i);
    assert.match(result.reply, /hello@unigox\.com|Intercom chat/i);
    return result;
  });

  assert.ok(client.calls.includes("requestEmailOTP"));
  assert.ok(client.calls.includes("verifyEmailOTP:123456"));
  assert.equal(res.session.stage, "awaiting_evm_signing_key");
});

test("configured recovery email skips the email-address step and still blocks early on the missing signing key after OTP verification", async () => {
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
  const client = makeClient({ username: "emailuser" });
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: true },
  });

  await withEnv({
    UNIGOX_EVM_LOGIN_PRIVATE_KEY: undefined,
    UNIGOX_EVM_SIGNING_PRIVATE_KEY: undefined,
    UNIGOX_PRIVATE_KEY: undefined,
    UNIGOX_TON_MNEMONIC: undefined,
    UNIGOX_EMAIL: "eyesonaleks@gmail.com",
  }, async () => {
    let result = await startTransferFlow("send 20 EUR to mom", deps);
    result = await advanceTransferFlow(result.session, "email OTP", deps);
    assert.equal(result.session.stage, "awaiting_email_otp");
    assert.equal(result.session.auth.emailAddress, "eyesonaleks@gmail.com");
    assert.match(result.reply, /I sent a 6-digit code to eyesonaleks@gmail.com/i);

    result = await advanceTransferFlow(result.session, "123456", deps);
    assert.equal(result.session.stage, "awaiting_evm_signing_key");
    assert.match(result.reply, /UNIGOX-exported EVM signing key/i);
    assert.match(result.reply, /early beta access for agentic payments/i);
    assert.match(result.reply, /hello@unigox\.com|Intercom chat/i);
  });

  assert.ok(client.calls.includes("requestEmailOTP"));
  assert.ok(client.calls.includes("verifyEmailOTP:123456"));
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
  res = await advanceTransferFlow(res.session, VALID_LOGIN_KEY, deps);
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
    verifyEvmLoginKey: async (loginKey) => ({ success: loginKey === VALID_LOGIN_KEY }),
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
  res = await advanceTransferFlow(res.session, VALID_LOGIN_KEY, deps);

  assert.equal(res.session.stage, "awaiting_secret_cleanup_confirmation");
  assert.match(res.reply, /delete the message/i);
  assert.deepEqual(persisted.login, []);

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /Login works/i);
  assert.match(res.reply, /@grape404/i);
  assert.match(res.reply, /separate UNIGOX EVM signing key/i);
  assert.match(res.reply, /funding trade escrow|confirming fiat received|releasing escrow/i);
  assert.match(res.reply, /early beta access for agentic payments/i);
  assert.match(res.reply, /hello@unigox\.com|Intercom chat/i);
  assert.match(res.reply, /must NOT be your main wallet/i);
  assert.deepEqual(persisted.login, [VALID_LOGIN_KEY]);

  res = await advanceTransferFlow(res.session, VALID_SIGNING_KEY, deps);
  assert.equal(res.session.stage, "awaiting_secret_cleanup_confirmation");
  assert.match(res.reply, /UNIGOX-exported signing key/i);

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.deepEqual(persisted.signing, [VALID_SIGNING_KEY]);
  assert.equal(res.session.stage, "awaiting_payment_method");
  assert.match(res.reply, /Which payout method should mom receive in EUR/i);
});

test("invalid text at the signing-key step is rejected instead of being stored as a private key", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const persisted = { signing: [] as string[] };
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: true, evmSigningKeyAvailable: false },
    persistEvmSigningKey: async (signingKey) => {
      persisted.signing.push(signingKey);
    },
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /doesn’t look like a valid EVM private key/i);
  assert.deepEqual(persisted.signing, []);
  assert.equal(res.session.auth.pendingSecret, undefined);
});

test("invalid text at the login-key step is rejected before secret-cleanup handling", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "evm", deps);
  res = await advanceTransferFlow(res.session, "done", deps);
  assert.equal(res.session.stage, "awaiting_evm_login_key");

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_evm_login_key");
  assert.match(res.reply, /doesn’t look like a valid EVM private key/i);
  assert.doesNotMatch(res.reply, /delete the message/i);
  assert.equal(res.session.auth.pendingSecret, undefined);
});

test("address-like input at the signing-key step is explained as an address, not a missing 0x prefix", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: true, evmSigningKeyAvailable: false },
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");

  res = await advanceTransferFlow(res.session, "0x50443A732F5766270427C14C652243D3e09B84E2", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /looks like an EVM address, not a private key/i);
  assert.match(res.reply, /with or without 0x/i);
  assert.equal(res.session.auth.pendingSecret, undefined);
});

test("invalid pending signing key is rejected at cleanup confirmation instead of being persisted", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const persisted = { signing: [] as string[] };
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: true, evmSigningKeyAvailable: false },
    persistEvmSigningKey: async (signingKey) => {
      persisted.signing.push(signingKey);
    },
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res.session.stage = "awaiting_secret_cleanup_confirmation";
  res.session.auth.pendingSecret = {
    kind: "evm_signing_key",
    value: "deleted",
  };

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /doesn’t look like a valid EVM private key/i);
  assert.deepEqual(persisted.signing, []);
  assert.equal(res.session.auth.pendingSecret, undefined);
});


test("automatic secret deletion hook skips manual cleanup confirmation", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const persisted = { login: [] as string[], signing: [] as string[] };
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
    verifyEvmLoginKey: async (loginKey) => ({ success: loginKey === VALID_LOGIN_KEY, username: "autodelete" }),
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
  res = await advanceTransferFlow(res.session, VALID_LOGIN_KEY, deps);

  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.ok(res.events.some((event) => event.type === "secret_message_deleted"));
  assert.deepEqual(persisted.login, [VALID_LOGIN_KEY]);

  res = await advanceTransferFlow(res.session, VALID_SIGNING_KEY, deps);
  assert.equal(res.session.stage, "awaiting_payment_method");
  assert.ok(res.events.some((event) => event.type === "secret_message_deleted"));
  assert.deepEqual(persisted.signing, [VALID_SIGNING_KEY]);
});

test("successful TON login verification persists TON address and private key, then asks for the EVM signing key", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const persisted = { tonAddress: [] as string[], tonPrivateKey: [] as string[], signing: [] as string[] };
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
    verifyTonLogin: async ({ tonPrivateKey, tonAddress }) => ({
      success: tonPrivateKey === VALID_TON_PRIVATE_KEY && tonAddress?.includes("0:"),
      username: "tonuser",
    }),
    persistTonAddress: async (tonAddress) => {
      persisted.tonAddress.push(tonAddress);
    },
    persistTonPrivateKey: async (tonPrivateKey) => {
      persisted.tonPrivateKey.push(tonPrivateKey);
    },
    persistEvmSigningKey: async (signingKey) => {
      persisted.signing.push(signingKey);
    },
  });

  const tonAddress = "UQDcx3iPA77JqK6a5tHK8PsE77HDdt_SGsx7O9IjWpMQAVEK";

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "ton", deps);
  assert.equal(res.session.stage, "awaiting_ton_address");
  assert.match(res.reply, /raw TON address/i);

  res = await advanceTransferFlow(res.session, tonAddress, deps);
  assert.equal(res.session.stage, "awaiting_ton_address_confirmation");
  assert.match(res.reply, /I’ll use this exact raw TON address/i);

  res = await advanceTransferFlow(res.session, "this address is correct", deps);
  assert.equal(res.session.stage, "awaiting_ton_private_key");
  assert.match(res.reply, /TON private key/i);

  res = await advanceTransferFlow(res.session, VALID_TON_PRIVATE_KEY, deps);
  assert.equal(res.session.stage, "awaiting_secret_cleanup_confirmation");
  assert.match(res.reply, /delete the message/i);

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /TON login works/i);
  assert.match(res.reply, /UNIGOX EVM signing key/i);
  assert.match(res.reply, /funding trade escrow|confirming fiat received|releasing escrow/i);
  assert.match(res.reply, /early beta access for agentic payments/i);
  assert.match(res.reply, /hello@unigox\.com|Intercom chat/i);
  assert.match(res.reply, /@tonuser/i);
  assert.equal(persisted.tonAddress.length, 1);
  assert.ok(persisted.tonAddress[0]?.startsWith("0:"));
  assert.deepEqual(persisted.tonPrivateKey, [VALID_TON_PRIVATE_KEY]);

  res = await advanceTransferFlow(res.session, ANOTHER_VALID_KEY, deps);
  assert.equal(res.session.stage, "awaiting_secret_cleanup_confirmation");

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.deepEqual(persisted.signing, [ANOTHER_VALID_KEY]);
  assert.equal(res.session.stage, "awaiting_payment_method");
});

test("mnemonic text is rejected during new TON onboarding and the flow asks for a private key instead", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
  });

  const tonAddress = "UQDcx3iPA77JqK6a5tHK8PsE77HDdt_SGsx7O9IjWpMQAVEK";

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res = await advanceTransferFlow(res.session, "ton", deps);
  res = await advanceTransferFlow(res.session, tonAddress, deps);
  res = await advanceTransferFlow(res.session, "this address is correct", deps);
  assert.equal(res.session.stage, "awaiting_ton_private_key");

  res = await advanceTransferFlow(res.session, VALID_TON_MNEMONIC, deps);
  assert.equal(res.session.stage, "awaiting_ton_private_key");
  assert.match(res.reply, /Please do not send a TON mnemonic here/i);
  assert.doesNotMatch(res.reply, /delete the message/i);
  assert.equal(res.session.auth.pendingSecret, undefined);
});

test("legacy pending TON mnemonic is discarded at cleanup confirmation and the flow asks for a private key instead", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const persisted = { tonPrivateKey: [] as string[] };
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: false, emailFallbackAvailable: false },
    persistTonPrivateKey: async (tonPrivateKey) => {
      persisted.tonPrivateKey.push(tonPrivateKey);
    },
  });

  let res = await startTransferFlow("send 50 EUR to mom", deps);
  res.session.stage = "awaiting_secret_cleanup_confirmation";
  res.session.auth.tonAddress = "0:1234";
  res.session.auth.pendingSecret = {
    kind: "ton_mnemonic",
    value: "deleted",
  };

  res = await advanceTransferFlow(res.session, "deleted", deps);
  assert.equal(res.session.stage, "awaiting_ton_private_key");
  assert.match(res.reply, /Please do not send a TON mnemonic here/i);
  assert.deepEqual(persisted.tonPrivateKey, []);
  assert.equal(res.session.auth.pendingSecret, undefined);
});

test("stored TON auth without a signing key prompts for the UNIGOX signing key instead of failing later", async () => {
  const { file } = makeTempContactsFile();
  const client = makeClient();
  const deps = makeDeps(file, client, {
    authState: { hasReplayableAuth: true, authMode: "ton", emailFallbackAvailable: false, evmSigningKeyAvailable: false },
  });

  const res = await startTransferFlow("send 50 EUR to mom", deps);

  assert.equal(res.session.stage, "awaiting_evm_signing_key");
  assert.match(res.reply, /UNIGOX-exported EVM signing key/i);
  assert.doesNotMatch(res.reply, /Save it as UNIGOX_EVM_SIGNING_PRIVATE_KEY/i);
});
