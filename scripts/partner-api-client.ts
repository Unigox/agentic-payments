/**
 * UNIGOX Partner API client.
 *
 * Owns every request this skill sends to the Partner API on behalf of one sender who pays from the
 * partner wallet: request construction, the `X-API-Key` header, response envelope interpretation,
 * and the two local EIP-712 signatures (escrow funding and refund). It does not sequence a
 * transfer; `transfer-orchestrator.ts` does that.
 *
 * Reference: https://developers.unigox.com (API reference, Off Ramp Playbook, Funding your wallet).
 */

import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";

/**
 * EIP-712 domain name of the forwarder that relays escrow funding.
 * Source: official SDK `Unigox/sdk_javascript` (`signForwardRequest`) and the `eip712_domain`
 * example in the Non-custodial customers guide.
 */
const FORWARDER_DOMAIN_NAME = "SyntheticAssetForwarder";

/** EIP-712 domain version of the same forwarder. Same sources as `FORWARDER_DOMAIN_NAME`. */
const FORWARDER_DOMAIN_VERSION = "1";

/**
 * EIP-712 struct the forwarder verifies. Field order and types are part of the signature.
 * Source: official SDK `Unigox/sdk_javascript` (`signForwardRequest`).
 */
const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

/**
 * Slug of the chain the partner wallet lives on, as `/api/v1/supported/blockchains` names it.
 * Source: "Funding your wallet" guide ("Your wallet address is on the XAI chain").
 */
const SETTLEMENT_CHAIN_SLUG = "xai";

/** Tokens that can fund an order. Source: "Funding your wallet" ("only USDC and USDT can fund orders"). */
const FUNDING_ASSET_CODES = ["USDC", "USDT"] as const;

/** Read-only ERC-20 fragment used for the partner wallet balance. */
const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"] as const;

const MILLISECONDS_PER_SECOND = 1000;

/** A token that can fund an order, as the Partner API spells it. */
export type FundingAssetCode = (typeof FUNDING_ASSET_CODES)[number];

/** Which liquidity providers a quote may match. Mirrors the API's `provider_scope`. */
export type ProviderScope = "all" | "licensed_only" | "p2p_only";

/**
 * Connection settings for unauthenticated ("public") Partner API endpoints.
 * Created by the configuration boundary and consumed by `partnerApiRequest`.
 */
export interface PartnerApiTransport {
  /** Base URL with no trailing slash, e.g. the documented production or staging host. */
  apiUrl: string;
  /** Partner API key sent as `X-API-Key`. Omit for public endpoints. */
  apiKey?: string;
  /** HTTP implementation. Defaults to the global `fetch`; tests inject a fake. */
  fetchImpl?: typeof fetch;
}

/**
 * Everything the client needs to act for one sender paying from the partner wallet.
 * Created by the configuration boundary (`loadPartnerApiConfigFromEnv`), consumed by
 * `PartnerApiClient`. All fields are required: there are no fallbacks.
 */
export interface PartnerApiConfig extends PartnerApiTransport {
  /** Partner API key. Required for every method of the client. */
  apiKey: string;
  /** Private key of the partner wallet, 0x-prefixed hex. Signs locally and never leaves the process. */
  walletPrivateKey: string;
  /** JSON-RPC URL of an XAI node, used only to read the partner wallet's token balances. */
  xaiRpcUrl: string;
  /** Email of the one real, KYC-verified person this installation sends for. Also used as `user_ref`. */
  senderEmail: string;
  /** Clock used for signature deadlines. Defaults to the system clock; tests inject a fixed one. */
  now?: () => Date;
  /**
   * Reads an ERC-20 balance in base units. Defaults to an `eth_call` through `xaiRpcUrl`; tests
   * inject a fake so no node is contacted.
   */
  readErc20Balance?: (params: { rpcUrl: string; tokenAddress: string; ownerAddress: string }) => Promise<bigint>;
}

/**
 * A refusal or failure reported by the Partner API, or a response that could not be read.
 * `code` is the API's machine code and is what callers branch on; `message` is engineering
 * evidence for logs and must not be shown to the person as-is.
 */
export class PartnerApiError extends Error {
  /** HTTP status of the response, or 0 when no response was received. */
  readonly status: number;
  /** Machine-readable code such as `NO_OFFERS_AVAILABLE`, or `HTTP_<status>` when the body carried none. */
  readonly code: string;
  /** The API's `error.details` object, when present. */
  readonly details?: Record<string, unknown>;

  /**
   * @param params.status HTTP status, or 0 for a transport failure.
   * @param params.code Machine-readable code.
   * @param params.message Engineering detail from the API or the transport.
   * @param params.details Optional structured context from the API.
   */
  constructor(params: { status: number; code: string; message: string; details?: Record<string, unknown> }) {
    super(params.message);
    this.name = "PartnerApiError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }
}

/** The sender as the Partner API knows them. Returned by `PartnerApiClient.ensureSender`. */
export interface PartnerSender {
  /** Public UUID used in every `/partner/users/{user_uuid}/…` path. */
  userUuid: string;
  /** Email the sender was registered with. */
  email: string;
  /** KYC status at registration time, e.g. `NOT_INITIATED` or `VERIFIED`. */
  kycStatus: string;
}

/** Result of a KYC start or status read. */
export interface PartnerKycVerification {
  /** API status, e.g. `IN_PROGRESS`, `VERIFIED`, `VERIFICATION_REJECTED`. */
  status: string;
  /** Hosted verification page for the sender. Absent when no session is open. */
  verificationUrl?: string;
  /** Seconds left on the verification session. Absent when the API does not report it. */
  verificationSecondsLeft?: number;
  /** Provider notes such as rejection reasons. Empty when there are none. */
  providerMessages: string[];
}

/** Bank or wallet details saved under the sender, usable as a payout target. */
export interface PartnerPaymentDetails {
  /** Id to pass as `payment_details_id` in a quote. */
  paymentDetailsId: string;
  /** Payment rail slug, e.g. `iban-sepa`. */
  rail: string;
  /** Fiat currency code. */
  currency: string;
  /** Institution display name. Empty when the API returns none. */
  institutionName: string;
  /** Institution slug. Empty when the API returns none. */
  institutionId: string;
  /** Rail-specific fields as saved, e.g. `{ iban, full_name }`. */
  details: Record<string, string>;
}

/** Fee components of an estimate, quote or order. Amounts are in the crypto asset, as decimal strings. */
export interface PartnerFeeBreakdown {
  /** UNIGOX fee in crypto. */
  platformFee: string;
  /** Partner markup in crypto. */
  partnerFee: string;
  /** Sum of both in crypto. */
  totalFee: string;
}

/** Indicative price. Binds nothing and reserves nothing. */
export interface PartnerEstimate {
  /** Crypto-to-fiat rate as a decimal string. */
  rate: string;
  /** Total crypto the order would cost, fees included, as a decimal string. */
  cryptoAmount: string;
  /** Fiat the recipient would receive, as a decimal string. */
  fiatAmount: string;
  /** Fee components. */
  feeBreakdown: PartnerFeeBreakdown;
}

/** Executable price, valid until `expiresAt`. */
export interface PartnerQuote extends PartnerEstimate {
  /** Id to pass to `initiateOfframp`. */
  quoteId: string;
  /** ISO timestamp after which the quote can no longer be initiated. */
  expiresAt: string;
  /** True when the matched provider confirms delivery itself, so no manual confirmation is needed. */
  hasFiatSettlementNotification: boolean;
  /** True when initiating would open a next-day (T+1) order. */
  delayedSettlement: boolean;
}

/** What the order still needs from the partner, when the API names an endpoint and fields. */
export interface PartnerOrderActionRequired {
  /** Machine-readable action identifier. */
  type: string;
  /** Fields the API asks for, in the order it lists them. */
  fields: Array<{ field: string; label: string }>;
}

/** An off-ramp order as returned by initiate and by order reads. */
export interface PartnerOrder {
  /** Order UUID. */
  orderId: string;
  /** Partner-facing status, e.g. `awaiting_liquidity_provider`, `crypto_received`, `completed`. */
  status: string;
  /** Action the partner must take next. Absent when the order waits on someone else. */
  nextAction?: string;
  /** Actions the partner may take at this status, e.g. `confirm-fiat-received`, `cancel`. */
  allowedActions: string[];
  /** Present when the API names an endpoint and fields to supply. */
  actionRequired?: PartnerOrderActionRequired;
  /** True when the matched provider confirms delivery itself. */
  hasFiatSettlementNotification: boolean;
  /** True when the order settles next-day (T+1). */
  delayedSettlement: boolean;
  /** Seconds left to fund the escrow. Absent outside the funding statuses. */
  cryptoTransferAuthorizationSecondsLeft?: number;
  /** Total crypto, fees included, as a decimal string. */
  cryptoAmount: string;
  /** Crypto asset code. */
  cryptoCurrency: string;
  /** Fiat the recipient receives, as a decimal string. */
  fiatAmount: string;
  /** Fiat currency code. */
  fiatCurrency: string;
  /** Crypto-to-fiat rate as a decimal string. */
  rate: string;
}

/** Partner wallet holdings on the settlement chain, in whole token units. */
export interface PartnerWalletBalance {
  /** Address derived from the configured wallet key. */
  walletAddress: string;
  /** Balance per funding asset, in whole units (not base units). */
  assets: Array<{ assetCode: FundingAssetCode; amount: number }>;
}

/**
 * Sends one request to the Partner API and returns the `data` of a successful envelope.
 *
 * @param transport Base URL, optional API key and HTTP implementation.
 * @param request.method HTTP method.
 * @param request.path Path beginning with `/api/v1/…`.
 * @param request.query Query parameters; `undefined` values are omitted.
 * @param request.body JSON body for POST and PATCH.
 * @returns The envelope's `data` value, typed by the caller.
 * @throws PartnerApiError when the transport fails, the body is not JSON, the HTTP status is not
 *   2xx, or the envelope reports `success: false`.
 */
export async function partnerApiRequest<T>(
  transport: PartnerApiTransport,
  request: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }
): Promise<T> {
  const url = buildRequestUrl(transport.apiUrl, request.path, request.query);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (transport.apiKey) headers["X-API-Key"] = transport.apiKey;
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  const fetchImpl = transport.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  } catch (error) {
    throw new PartnerApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const envelope = await readJsonEnvelope(response);
  if (!response.ok || envelope.success === false) {
    throw toPartnerApiError(response.status, envelope);
  }
  return envelope.data as T;
}

/**
 * Builds the absolute request URL.
 *
 * @param apiUrl Base URL with or without a trailing slash.
 * @param path Path beginning with `/`.
 * @param query Query parameters; `undefined` values are omitted.
 * @returns Absolute URL string.
 */
function buildRequestUrl(
  apiUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(`${apiUrl.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Reads a response body as the API's JSON envelope.
 *
 * @param response HTTP response.
 * @returns Parsed object. A body that is empty yields `{}`.
 * @throws PartnerApiError with code `INVALID_RESPONSE` when the body is not a JSON object.
 */
async function readJsonEnvelope(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported below with the HTTP status.
  }
  throw new PartnerApiError({
    status: response.status,
    code: "INVALID_RESPONSE",
    message: `Partner API answered HTTP ${response.status} with a body that is not a JSON object`,
  });
}

/**
 * Converts a failed envelope into a `PartnerApiError`.
 *
 * The API reports failures in three shapes: `error: { code, message, details }`, `error: "<text>"`
 * on request validation, and `data: { error_key }` on some authentication failures.
 *
 * @param status HTTP status of the response.
 * @param envelope Parsed response body.
 * @returns Error carrying the machine code, or `HTTP_<status>` when the body names none.
 */
function toPartnerApiError(status: number, envelope: Record<string, unknown>): PartnerApiError {
  const error = envelope.error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return new PartnerApiError({
      status,
      code: typeof record.code === "string" && record.code ? record.code : `HTTP_${status}`,
      message: typeof record.message === "string" ? record.message : "",
      details: record.details && typeof record.details === "object" ? (record.details as Record<string, unknown>) : undefined,
    });
  }
  const data = envelope.data as Record<string, unknown> | undefined;
  const errorKey = data && typeof data === "object" && typeof data.error_key === "string" ? data.error_key : undefined;
  return new PartnerApiError({
    status,
    code: errorKey ? errorKey.toUpperCase() : `HTTP_${status}`,
    message: typeof error === "string" ? error : "",
  });
}

/**
 * Partner API operations for one sender paying from the partner wallet.
 *
 * Created by the orchestrator's client factory from a validated `PartnerApiConfig`. Holds the
 * wallet key in memory only for local signing.
 */
export class PartnerApiClient {
  private readonly config: PartnerApiConfig;
  private readonly wallet: Wallet;
  private sender?: PartnerSender;

  /**
   * @param config Validated configuration. The wallet key must be a valid private key.
   * @throws Error from ethers when `walletPrivateKey` is not a valid private key.
   */
  constructor(config: PartnerApiConfig) {
    this.config = config;
    this.wallet = new Wallet(config.walletPrivateKey);
  }

  /**
   * Address of the partner wallet derived from the configured key.
   *
   * @returns Checksummed EVM address. No network call.
   */
  getWalletAddress(): string {
    return this.wallet.address;
  }

  /**
   * Checks that the configured API key authenticates.
   *
   * @returns Nothing on success. Calls `GET /partner/verify-auth`.
   * @throws PartnerApiError (`UNAUTHORIZED` or `HTTP_401`) when the key is refused.
   */
  async verifyApiKey(): Promise<void> {
    await this.request<unknown>({ method: "GET", path: "/api/v1/partner/verify-auth" });
  }

  /**
   * Registers the configured sender, or returns the existing registration.
   *
   * The API call is idempotent for a given `user_ref`, and the result is kept for the lifetime of
   * this instance so later calls cost no request.
   *
   * @returns The sender's UUID, email and KYC status at registration time.
   * @throws PartnerApiError when the API refuses the request.
   */
  async ensureSender(): Promise<PartnerSender> {
    if (this.sender) return this.sender;
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/partner/users",
      body: { user_ref: this.config.senderEmail, email: this.config.senderEmail },
    });
    this.sender = {
      userUuid: readString(data.user_uuid) || readString(data.id),
      email: readString(data.email) || this.config.senderEmail,
      kycStatus: readString(data.kyc_status),
    };
    return this.sender;
  }

  /**
   * Reads the sender's current KYC verification state.
   *
   * @returns Status, and the hosted verification link while a session is open.
   * @throws PartnerApiError when the API refuses the request.
   */
  async getKycVerification(): Promise<PartnerKycVerification> {
    const sender = await this.ensureSender();
    const data = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/v1/partner/users/${sender.userUuid}/verification-status`,
    });
    return toKycVerification(data, readString(data.status));
  }

  /**
   * Starts UNIGOX-hosted KYC for the sender (the API's `handoff` method).
   *
   * @param params.firstName Legal first name.
   * @param params.lastName Legal last name.
   * @param params.countryCode ISO 3166-1 alpha-2 country of residence.
   * @returns Status and the hosted verification link the sender must open.
   * @throws PartnerApiError when the API refuses the submission.
   */
  async startKycHandoff(params: { firstName: string; lastName: string; countryCode: string }): Promise<PartnerKycVerification> {
    const sender = await this.ensureSender();
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: `/api/v1/partner/users/${sender.userUuid}/kyc-submissions`,
      body: {
        method: "handoff",
        data: {
          pii: {
            first_name: params.firstName,
            last_name: params.lastName,
            country_code: params.countryCode,
          },
        },
      },
    });
    return toKycVerification(data, readString(data.kyc_status));
  }

  /**
   * Adds optional personal fields to the sender's KYC record without re-running verification.
   * Used when an order reports `update_kyc_address`.
   *
   * @param fields Keys and values exactly as the API names them, e.g. `address`, `city`, `postal_code`.
   * @returns Nothing. The write is all-or-nothing on the API side.
   * @throws PartnerApiError when a value is rejected.
   */
  async updateKycFields(fields: Record<string, string>): Promise<void> {
    const sender = await this.ensureSender();
    await this.request<unknown>({
      method: "PATCH",
      path: `/api/v1/partner/users/${sender.userUuid}/kyc`,
      body: fields,
    });
  }

  /**
   * Lists every set of bank or wallet details saved under the sender.
   *
   * @returns Saved payment details, in the API's order. Empty when none exist.
   * @throws PartnerApiError when the API refuses the request.
   */
  async listPaymentDetails(): Promise<PartnerPaymentDetails[]> {
    const sender = await this.ensureSender();
    const data = await this.request<unknown>({
      method: "GET",
      path: `/api/v1/partner/users/${sender.userUuid}/payment-details`,
    });
    return Array.isArray(data) ? data.map((entry) => toPaymentDetails(entry as Record<string, unknown>)) : [];
  }

  /**
   * Saves bank or wallet details under the sender. The API validates the fields for the corridor.
   *
   * @param params.currency Fiat currency code.
   * @param params.rail Payment rail slug from `/supported/payment-rails`.
   * @param params.institutionId Institution slug from `/supported/institutions`. Omit only for rails
   *   that do not require one.
   * @param params.countryCode Optional ISO alpha-2 country of the payout account.
   * @param params.details Rail-specific fields, keyed as the rail names them.
   * @returns The saved details including their `paymentDetailsId`.
   * @throws PartnerApiError when a field is missing or malformed for the rail.
   */
  async createPaymentDetails(params: {
    currency: string;
    rail: string;
    institutionId?: string;
    countryCode?: string;
    details: Record<string, string>;
  }): Promise<PartnerPaymentDetails> {
    const sender = await this.ensureSender();
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: `/api/v1/partner/users/${sender.userUuid}/payment-details`,
      body: {
        currency: params.currency,
        rail: params.rail,
        institution_id: params.institutionId,
        country_code: params.countryCode,
        details: params.details,
      },
    });
    return toPaymentDetails(data);
  }

  /**
   * Asks for an indicative price for an exact fiat amount. Reserves nothing.
   *
   * @param params.cryptoCurrency Asset the partner wallet would spend.
   * @param params.fiatCurrency Fiat currency the recipient receives.
   * @param params.fiatAmount Exact fiat amount, as a decimal string.
   * @param params.institutionId Optional institution slug to price on that bank's route.
   * @param params.rail Optional rail slug to price on that rail.
   * @param params.providerScope Which providers may be matched.
   * @returns Rate, total crypto cost and fees.
   * @throws PartnerApiError `NO_OFFERS_AVAILABLE` when nothing serves the pair and amount.
   */
  async estimateOfframp(params: {
    cryptoCurrency: FundingAssetCode;
    fiatCurrency: string;
    fiatAmount: string;
    institutionId?: string;
    rail?: string;
    providerScope: ProviderScope;
  }): Promise<PartnerEstimate> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/partner/offramp/estimate",
      body: {
        crypto_currency: params.cryptoCurrency,
        fiat_currency: params.fiatCurrency,
        fiat_amount: params.fiatAmount,
        payment_method_slug: params.institutionId,
        payment_network_slug: params.rail,
        provider_scope: params.providerScope,
      },
    });
    return toEstimate(data);
  }

  /**
   * Requests an executable quote for paying saved details an exact fiat amount.
   *
   * @param params.paymentDetailsId Id of details saved under the sender.
   * @param params.cryptoCurrency Asset the partner wallet spends.
   * @param params.fiatCurrency Fiat currency of the saved details.
   * @param params.fiatAmount Exact fiat amount, as a decimal string.
   * @param params.providerScope Which providers may be matched.
   * @returns Quote id, price, expiry and settlement flags.
   * @throws PartnerApiError e.g. `KYC_NOT_CLEARED`, `NO_OFFERS_AVAILABLE`, `INVALID_PAYMENT_DETAILS`.
   */
  async quoteOfframp(params: {
    paymentDetailsId: string;
    cryptoCurrency: FundingAssetCode;
    fiatCurrency: string;
    fiatAmount: string;
    providerScope: ProviderScope;
  }): Promise<PartnerQuote> {
    const sender = await this.ensureSender();
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/partner/offramp/quote",
      body: {
        user_uuid: sender.userUuid,
        payment_details_id: Number(params.paymentDetailsId),
        crypto_currency: params.cryptoCurrency,
        fiat_currency: params.fiatCurrency,
        fiat_amount: params.fiatAmount,
        provider_scope: params.providerScope,
      },
    });
    return {
      ...toEstimate(data),
      quoteId: readString(data.quote_id),
      expiresAt: readString(data.expires_at),
      hasFiatSettlementNotification: data.has_fiat_settlement_notification === true,
      delayedSettlement: data.delayed_settlement === true,
    };
  }

  /**
   * Turns a live quote into an order.
   *
   * @param quoteId Id from `quoteOfframp`. Each quote can be initiated once.
   * @returns The new order, normally at `awaiting_liquidity_provider`.
   * @throws PartnerApiError e.g. `QUOTE_EXPIRED`, `PRICE_CHANGED_REQUOTE`, `KYC_NOT_CLEARED`.
   */
  async initiateOfframp(quoteId: string): Promise<PartnerOrder> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/partner/offramp/initiate",
      body: { quote_id: quoteId },
    });
    return toOrder(data);
  }

  /**
   * Reads one order.
   *
   * @param orderId Order UUID.
   * @returns Current status, required and allowed actions, and amounts.
   * @throws PartnerApiError `ORDER_NOT_FOUND` when the id is unknown to this partner.
   */
  async getOrder(orderId: string): Promise<PartnerOrder> {
    const data = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/v1/partner/orders/${orderId}`,
    });
    return toOrder(data);
  }

  /**
   * Funds an order's escrow from the partner wallet.
   *
   * Fetches the server-built transfer, signs it locally as an EIP-712 `ForwardRequest`, and submits
   * the signature. UNIGOX relays the transaction and pays the gas.
   *
   * @param orderId Order UUID whose `nextAction` is `authorize_crypto_transfer`.
   * @returns Nothing. The order moves to `crypto_received` after on-chain confirmation.
   * @throws PartnerApiError `WALLET_MISMATCH` when the API expects a different sender address than
   *   the configured key, `INSUFFICIENT_BALANCE` when the wallet cannot cover the order, or
   *   `INVALID_STATUS` when no provider has accepted the order yet.
   */
  async authorizeCryptoTransfer(orderId: string): Promise<void> {
    const parameters = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/v1/partner/orders/${orderId}/transfer-authorization-parameters`,
    });
    this.requireWalletIs(readString(parameters.sender_address));

    const forwardRequest = {
      from: getAddress(readString(parameters.sender_address)),
      to: getAddress(readString(parameters.token_address)),
      value: "0",
      gas: requireField(parameters, "recommended_gas_limit"),
      nonce: requireField(parameters, "forwarder_nonce"),
      deadline: String(this.currentUnixSeconds() + Number(requireField(parameters, "recommended_ttl_seconds"))),
      data: requireField(parameters, "transfer_data"),
    };
    const signature = await this.wallet.signTypedData(
      {
        name: FORWARDER_DOMAIN_NAME,
        version: FORWARDER_DOMAIN_VERSION,
        chainId: Number(requireField(parameters, "chain_id")),
        verifyingContract: getAddress(requireField(parameters, "forwarder_address")),
      },
      FORWARD_REQUEST_TYPES,
      forwardRequest
    );

    await this.request<unknown>({
      method: "POST",
      path: `/api/v1/partner/orders/${orderId}/authorize-crypto-transfer`,
      body: { forward_request: forwardRequest, signature },
    });
  }

  /**
   * Returns a stopped order's escrow to the partner wallet.
   *
   * Fetches the server-built Safe transaction, signs it locally, and submits the signature. The
   * destination is fixed by the API to the partner wallet.
   *
   * @param orderId Order UUID whose `nextAction` is `authorize_refund`.
   * @returns Nothing. UNIGOX adds the second signature and executes the refund.
   * @throws PartnerApiError `WALLET_MISMATCH` when the API names a different signer than the
   *   configured key, or `INVALID_STATUS` when the order owes no refund.
   */
  async authorizeRefund(orderId: string): Promise<void> {
    const parameters = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/v1/partner/orders/${orderId}/refund-authorization-parameters`,
    });
    this.requireWalletIs(readString(parameters.signer_address));

    const signature = await this.wallet.signTypedData(
      parameters.domain as Record<string, unknown>,
      withoutDomainType(parameters.types),
      parameters.safe_params as Record<string, unknown>
    );
    await this.request<unknown>({
      method: "POST",
      path: `/api/v1/partner/orders/${orderId}/authorize-refund`,
      body: { signature },
    });
  }

  /**
   * Confirms that the recipient received the fiat, which releases the escrow to the provider.
   *
   * @param orderId Order UUID whose `allowedActions` include `confirm-fiat-received`.
   * @returns Nothing.
   * @throws PartnerApiError when the order is not in a confirmable status.
   */
  async confirmFiatReceived(orderId: string): Promise<void> {
    await this.request<unknown>({
      method: "POST",
      path: `/api/v1/partner/orders/${orderId}/confirm-fiat-received`,
    });
  }

  /**
   * Cancels an order that has not been funded yet.
   *
   * @param orderId Order UUID whose `allowedActions` include `cancel`.
   * @returns Nothing.
   * @throws PartnerApiError `OPERATION_NOT_ALLOWED` or `INVALID_STATUS` when cancellation is refused.
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request<unknown>({
      method: "POST",
      path: `/api/v1/partner/orders/${orderId}/cancel`,
    });
  }

  /**
   * Reads how much USDC and USDT the partner wallet holds on the settlement chain.
   *
   * Token addresses and decimals come from `GET /api/v1/supported/blockchains`; balances come from
   * the configured XAI node.
   *
   * @returns Wallet address and one balance per funding asset, in whole token units.
   * @throws PartnerApiError `SETTLEMENT_TOKEN_UNKNOWN` when the API does not list a funding asset
   *   on the settlement chain. Errors from the node propagate unchanged.
   */
  async getWalletBalance(): Promise<PartnerWalletBalance> {
    const blockchains = await this.request<unknown>({ method: "GET", path: "/api/v1/supported/blockchains" });
    const tokens = readSettlementTokens(blockchains);
    const readBalance = this.config.readErc20Balance ?? readErc20BalanceFromNode;

    const assets = await Promise.all(
      FUNDING_ASSET_CODES.map(async (assetCode) => {
        const token = tokens.get(assetCode);
        if (!token) {
          throw new PartnerApiError({
            status: 0,
            code: "SETTLEMENT_TOKEN_UNKNOWN",
            message: `The API does not list ${assetCode} on the ${SETTLEMENT_CHAIN_SLUG} chain`,
          });
        }
        const baseUnits = await readBalance({
          rpcUrl: this.config.xaiRpcUrl,
          tokenAddress: token.contract,
          ownerAddress: this.wallet.address,
        });
        return { assetCode, amount: Number(baseUnits) / 10 ** token.decimals };
      })
    );
    return { walletAddress: this.wallet.address, assets };
  }

  /**
   * Sends an authenticated request with this client's configuration.
   *
   * @param request Method, path, optional query and body.
   * @returns The envelope's `data`.
   * @throws PartnerApiError as `partnerApiRequest` does.
   */
  private request<T>(request: Parameters<typeof partnerApiRequest>[1]): Promise<T> {
    return partnerApiRequest<T>(this.config, request);
  }

  /**
   * Refuses to sign when the API expects a different wallet than the configured key.
   *
   * @param expectedAddress Address the API named as sender or signer.
   * @throws PartnerApiError `WALLET_MISMATCH` when the addresses differ.
   */
  private requireWalletIs(expectedAddress: string): void {
    if (expectedAddress.toLowerCase() !== this.wallet.address.toLowerCase()) {
      throw new PartnerApiError({
        status: 0,
        code: "WALLET_MISMATCH",
        message: `The API expects wallet ${expectedAddress} but the configured key is ${this.wallet.address}`,
      });
    }
  }

  /**
   * Current time as whole unix seconds, from the injected clock when present.
   *
   * @returns Seconds since the unix epoch.
   */
  private currentUnixSeconds(): number {
    const now = this.config.now ? this.config.now() : new Date();
    return Math.floor(now.getTime() / MILLISECONDS_PER_SECOND);
  }
}

/**
 * Reads an ERC-20 balance through a JSON-RPC node.
 *
 * @param params.rpcUrl JSON-RPC URL of the chain.
 * @param params.tokenAddress Token contract address.
 * @param params.ownerAddress Holder address.
 * @returns Balance in the token's base units.
 * @throws Error from ethers when the node cannot be reached or the call reverts.
 */
async function readErc20BalanceFromNode(params: {
  rpcUrl: string;
  tokenAddress: string;
  ownerAddress: string;
}): Promise<bigint> {
  const provider = new JsonRpcProvider(params.rpcUrl);
  try {
    const token = new Contract(params.tokenAddress, ERC20_BALANCE_ABI, provider);
    return (await token.balanceOf(params.ownerAddress)) as bigint;
  } finally {
    provider.destroy();
  }
}

/**
 * Prepares API-supplied EIP-712 type definitions for ethers.
 *
 * The API may list `EIP712Domain` among the types. ethers derives the domain type itself and
 * refuses a type set that names it, so it is removed; every other type is passed through.
 *
 * @param types `types` object from a signing-parameters response.
 * @returns The same definitions without `EIP712Domain`.
 * @throws PartnerApiError `INVALID_RESPONSE` when `types` is not an object.
 */
function withoutDomainType(types: unknown): Record<string, Array<{ name: string; type: string }>> {
  if (!types || typeof types !== "object" || Array.isArray(types)) {
    throw new PartnerApiError({
      status: 0,
      code: "INVALID_RESPONSE",
      message: "Partner API response is missing types",
    });
  }
  const { EIP712Domain: _domainType, ...signable } = types as Record<string, Array<{ name: string; type: string }>>;
  return signable;
}

/**
 * Extracts the funding tokens of the settlement chain from the blockchains listing.
 *
 * @param blockchains `data` of `GET /api/v1/supported/blockchains`.
 * @returns Map from asset code to its contract address and decimals on the settlement chain.
 *   Empty when the chain is not listed.
 */
function readSettlementTokens(blockchains: unknown): Map<string, { contract: string; decimals: number }> {
  const tokens = new Map<string, { contract: string; decimals: number }>();
  if (!Array.isArray(blockchains)) return tokens;
  const chain = blockchains.find(
    (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).slug === SETTLEMENT_CHAIN_SLUG
  ) as Record<string, unknown> | undefined;
  const currencies = chain && Array.isArray(chain.crypto_currencies) ? chain.crypto_currencies : [];
  for (const currency of currencies as Array<Record<string, unknown>>) {
    const code = readString(currency.code);
    const contract = readString(currency.contract);
    if (code && contract && typeof currency.decimals === "number") {
      tokens.set(code, { contract, decimals: currency.decimals });
    }
  }
  return tokens;
}

/**
 * Maps a KYC payload to `PartnerKycVerification`.
 *
 * @param data `data` of a KYC submission or verification-status response.
 * @param status The status value, which the two endpoints name differently.
 * @returns Normalized verification state.
 */
function toKycVerification(data: Record<string, unknown>, status: string): PartnerKycVerification {
  return {
    status,
    verificationUrl: readString(data.verification_url) || undefined,
    verificationSecondsLeft:
      typeof data.verification_seconds_left === "number" ? data.verification_seconds_left : undefined,
    providerMessages: Array.isArray(data.provider_messages)
      ? data.provider_messages.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

/**
 * Maps a payment profile payload to `PartnerPaymentDetails`.
 *
 * @param data One payment profile as the API returns it. Older responses name the id `id`.
 * @returns Normalized saved details; `details` values are coerced to strings.
 */
function toPaymentDetails(data: Record<string, unknown>): PartnerPaymentDetails {
  const rawDetails = data.details && typeof data.details === "object" ? (data.details as Record<string, unknown>) : {};
  const details: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawDetails)) {
    if (value !== null && value !== undefined) details[key] = String(value);
  }
  return {
    paymentDetailsId: readString(data.payment_details_id) || readString(data.id),
    rail: readString(data.rail),
    currency: readString(data.currency),
    institutionName: readString(data.institution_name),
    institutionId: readString(data.institution_id),
    details,
  };
}

/**
 * Maps a price payload to `PartnerEstimate`.
 *
 * @param data `data` of an estimate or quote response.
 * @returns Rate, amounts and fees as the API's decimal strings.
 */
function toEstimate(data: Record<string, unknown>): PartnerEstimate {
  const fees = data.fee_breakdown && typeof data.fee_breakdown === "object"
    ? (data.fee_breakdown as Record<string, unknown>)
    : {};
  return {
    rate: readString(data.rate),
    cryptoAmount: readString(data.crypto_amount),
    fiatAmount: readString(data.fiat_amount),
    feeBreakdown: {
      platformFee: readString(fees.platform_fee),
      partnerFee: readString(fees.partner_fee),
      totalFee: readString(fees.total_fee),
    },
  };
}

/**
 * Maps an order payload to `PartnerOrder`.
 *
 * @param data `data` of an initiate or order-read response.
 * @returns Normalized order. `nextAction` and `actionRequired` are absent when the API omits them.
 */
function toOrder(data: Record<string, unknown>): PartnerOrder {
  const amounts = data.amounts && typeof data.amounts === "object" ? (data.amounts as Record<string, unknown>) : {};
  const action = data.action_required && typeof data.action_required === "object"
    ? (data.action_required as Record<string, unknown>)
    : undefined;
  return {
    orderId: readString(data.order_id),
    status: readString(data.status),
    nextAction: readString(data.next_action) || undefined,
    allowedActions: Array.isArray(data.allowed_actions)
      ? data.allowed_actions.filter((entry): entry is string => typeof entry === "string")
      : [],
    actionRequired: action
      ? {
          type: readString(action.type),
          fields: Array.isArray(action.fields)
            ? (action.fields as Array<Record<string, unknown>>).map((entry) => ({
                field: readString(entry.field),
                label: readString(entry.label),
              }))
            : [],
        }
      : undefined,
    hasFiatSettlementNotification: data.has_fiat_settlement_notification === true,
    delayedSettlement: data.delayed_settlement === true,
    cryptoTransferAuthorizationSecondsLeft:
      typeof data.crypto_transfer_authorization_seconds_left === "number"
        ? data.crypto_transfer_authorization_seconds_left
        : undefined,
    cryptoAmount: readString(amounts.crypto_amount),
    cryptoCurrency: readString(amounts.crypto_currency),
    fiatAmount: readString(amounts.fiat_amount),
    fiatCurrency: readString(amounts.fiat_currency),
    rate: readString(amounts.rate),
  };
}

/**
 * Reads a JSON value as a string.
 *
 * @param value Any JSON value.
 * @returns The string itself, a number rendered as a string, or `""` for anything else.
 */
function readString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Reads a field the signing flow cannot proceed without.
 *
 * @param data Response `data` object.
 * @param field Field name as the API spells it.
 * @returns The field as a non-empty string.
 * @throws PartnerApiError `INVALID_RESPONSE` when the field is missing or empty.
 */
function requireField(data: Record<string, unknown>, field: string): string {
  const value = readString(data[field]);
  if (!value) {
    throw new PartnerApiError({
      status: 0,
      code: "INVALID_RESPONSE",
      message: `Partner API response is missing ${field}`,
    });
  }
  return value;
}
