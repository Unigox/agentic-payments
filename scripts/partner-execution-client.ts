/**
 * Transfer execution on the UNIGOX Partner API.
 *
 * Implements the flow's `TransferExecutionClient` port with Partner API orders: it translates the
 * flow's vocabulary (trade request, trade, settlement status) to and from the API's (quote, order,
 * order status) and maps API refusals to the failures the flow handles. It holds no conversation
 * state, so a new instance per chat turn behaves the same as a long-lived one.
 */

import { PartnerApiError } from "./partner-api-client.ts";
import type {
  FundingAssetCode,
  PartnerApiClient,
  PartnerKycVerification,
  PartnerOrder,
  PartnerPaymentDetails,
  ProviderScope,
} from "./partner-api-client.ts";
import { TransferExecutionError } from "./transfer-execution.ts";
import type {
  KycVerificationData,
  PartnerPaymentDetailsDiffData,
  PaymentDetail,
  PreflightQuote,
  SettlementTrade,
  TradePartnerPreference,
  TradeRequest,
  TransferExecutionClient,
  UserProfile,
  WalletBalance,
} from "./transfer-execution.ts";

/** Order statuses in which no provider has accepted the order yet. Source: Partner API order status list. */
const UNMATCHED_ORDER_STATUSES = new Set(["created", "awaiting_liquidity_provider"]);

/** Order statuses that end an unmatched order without a provider. Source: Partner API order status list. */
const ENDED_ORDER_STATUSES = new Set(["cancelled", "failed"]);

/**
 * Settlement status the flow uses for each Partner API order status that maps one-to-one.
 * Statuses that depend on other order fields are handled in `toSettlementStatus`. An order status
 * missing here is passed through unchanged, which the settlement monitor treats as "manual
 * follow-up": the flow then keeps the funds where they are.
 */
const SETTLEMENT_STATUS_BY_ORDER_STATUS: Record<string, string> = {
  crypto_transfer_authorization_pending: "trade_created",
  crypto_received: "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer",
  awaiting_fiat_received_confirmation: "fiat_payment_proof_accepted_by_system",
  fiat_received_confirmed: "fiat_payment_confirmed_by_seller_escrow_release_started",
  crypto_release_pending: "fiat_payment_confirmed_by_seller_escrow_release_started",
  completed: "escrow_released_to_buyer",
  failed: "escrow_funding_error",
};

/** Settlement status for an order whose escrow must be signed back to the paying wallet. */
const REFUND_AUTHORIZATION_REQUIRED_STATUS = "escrow_refund_authorization_required";

/** Settlement status for a next-day (T+1) order, which this flow does not operate. */
const DELAYED_SETTLEMENT_STATUS = "delayed_settlement_not_supported";

/** Name the flow sees as the party asking for extra payout details. */
const DETAILS_REQUESTER_NAME = "unigox";

/** How the flow's provider preference is spelled in the API's `provider_scope`. */
const PROVIDER_SCOPE_BY_PREFERENCE: Record<TradePartnerPreference, ProviderScope> = {
  licensed: "licensed_only",
  p2p: "p2p_only",
  all: "all",
};

/** Timing the client needs from its caller. */
export interface PartnerExecutionClientOptions {
  /** Pause between order reads while waiting for a provider, in milliseconds. */
  matchPollIntervalMs: number;
  /** Waits the given milliseconds. Defaults to a real timer; tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `TransferExecutionClient` backed by one `PartnerApiClient`.
 * Created by the orchestrator's client factory.
 */
export class PartnerExecutionClient implements TransferExecutionClient {
  private readonly api: PartnerApiClient;
  private readonly options: PartnerExecutionClientOptions;

  /**
   * @param api Authenticated Partner API client for the sender.
   * @param options Polling interval and optional timer.
   */
  constructor(api: PartnerApiClient, options: PartnerExecutionClientOptions) {
    this.api = api;
    this.options = options;
  }

  /**
   * Reads the sender's display name and verification state.
   *
   * @returns `username` is the sender's email; `id_verification_status` is the current KYC state in
   *   the flow's vocabulary.
   * @throws PartnerApiError when the API refuses the requests.
   */
  async getProfile(): Promise<UserProfile> {
    const sender = await this.api.ensureSender();
    const verification = await this.api.getKycVerification();
    return {
      username: sender.email,
      id_verification_status: toKycStatus(verification.status),
    };
  }

  /**
   * Reads the partner wallet's USDC and USDT.
   *
   * @returns Holdings in whole units and their sum.
   * @throws PartnerApiError or a node error when the balance cannot be read.
   */
  async getWalletBalance(): Promise<WalletBalance> {
    const balance = await this.api.getWalletBalance();
    const amountOf = (assetCode: FundingAssetCode): number =>
      balance.assets.find((asset) => asset.assetCode === assetCode)?.amount ?? 0;
    return {
      usdc: amountOf("USDC"),
      usdt: amountOf("USDT"),
      totalUsd: balance.assets.reduce((sum, asset) => sum + asset.amount, 0),
      assets: balance.assets.map((asset) => ({ assetCode: asset.assetCode, amount: asset.amount })),
    };
  }

  /**
   * Reads the state of the sender's identity verification.
   *
   * @returns Status in the flow's vocabulary and the hosted link while a session is open.
   * @throws PartnerApiError when the API refuses the request.
   */
  async getKycVerificationStatus(): Promise<KycVerificationData> {
    return toKycVerificationData(await this.api.getKycVerification());
  }

  /**
   * Starts UNIGOX-hosted identity verification for the sender.
   *
   * @param params.fullName Legal name. The first word is sent as the first name and the rest as the
   *   last name, because the API takes the two separately.
   * @param params.country ISO alpha-2 country of residence.
   * @returns Status and the hosted verification link.
   * @throws PartnerApiError when the API refuses the submission.
   */
  async initializeKycVerification(params: { fullName: string; country: string }): Promise<KycVerificationData> {
    const [firstName, ...rest] = params.fullName.trim().split(/\s+/);
    const verification = await this.api.startKycHandoff({
      firstName,
      lastName: rest.join(" "),
      countryCode: params.country.toUpperCase(),
    });
    return toKycVerificationData(verification);
  }

  /**
   * Lists payout details saved under the sender.
   *
   * @returns Saved details; empty when there are none.
   * @throws PartnerApiError when the API refuses the request.
   */
  async listPaymentDetails(): Promise<PaymentDetail[]> {
    return (await this.api.listPaymentDetails()).map(toPaymentDetail);
  }

  /**
   * Returns saved payout details equal to the given ones, saving them first when none exist.
   *
   * Existing details count as equal when currency, rail and institution match and every given field
   * has the same saved value.
   *
   * @param params.fiatCurrencyCode Fiat currency of the payout account.
   * @param params.paymentMethodSlug Institution slug.
   * @param params.paymentNetworkSlug Rail slug.
   * @param params.details Rail-specific fields.
   * @returns The saved details with their id.
   * @throws PartnerApiError when the API refuses the fields for the rail.
   */
  async ensurePaymentDetail(params: {
    fiatCurrencyCode: string;
    paymentMethodSlug: string;
    paymentNetworkSlug: string;
    details: Record<string, string>;
  }): Promise<PaymentDetail> {
    const existing = (await this.api.listPaymentDetails()).find(
      (saved) =>
        saved.currency === params.fiatCurrencyCode
        && saved.rail === params.paymentNetworkSlug
        && saved.institutionId === params.paymentMethodSlug
        && Object.entries(params.details).every(([key, value]) => saved.details[key] === value)
    );
    if (existing) return toPaymentDetail(existing);

    const created = await this.api.createPaymentDetails({
      currency: params.fiatCurrencyCode,
      rail: params.paymentNetworkSlug,
      institutionId: params.paymentMethodSlug,
      details: params.details,
    });
    return toPaymentDetail(created);
  }

  /**
   * Prices a payout without placing it.
   *
   * @param params.cryptoCurrencyCode Asset that would be spent (`USDC` or `USDT`).
   * @param params.fiatCurrencyCode Fiat currency to pay out.
   * @param params.fiatAmount Fiat the recipient should receive, in whole units.
   * @param params.paymentMethodSlug Institution slug, to price on that institution's route.
   * @param params.paymentNetworkSlug Rail slug, to price on that rail.
   * @param params.tradePartner Providers the payout may be matched to.
   * @returns The estimate, or `undefined` when no provider serves the payout right now.
   * @throws PartnerApiError for any refusal other than "no offers".
   */
  async getPreflightQuote(params: {
    cryptoCurrencyCode: string;
    fiatCurrencyCode: string;
    fiatAmount: number;
    paymentMethodSlug?: string;
    paymentNetworkSlug?: string;
    tradePartner: TradePartnerPreference;
  }): Promise<PreflightQuote | undefined> {
    try {
      const estimate = await this.api.estimateOfframp({
        cryptoCurrency: params.cryptoCurrencyCode as FundingAssetCode,
        fiatCurrency: params.fiatCurrencyCode,
        fiatAmount: String(params.fiatAmount),
        institutionId: params.paymentMethodSlug,
        rail: params.paymentNetworkSlug,
        providerScope: PROVIDER_SCOPE_BY_PREFERENCE[params.tradePartner],
      });
      return {
        quoteType: "estimate",
        source: "best_offer",
        cryptoCurrencyCode: params.cryptoCurrencyCode,
        fiatCurrencyCode: params.fiatCurrencyCode,
        fiatAmount: Number(estimate.fiatAmount),
        totalCryptoAmount: Number(estimate.cryptoAmount),
        feeCryptoAmount: Number(estimate.feeBreakdown.totalFee),
        vendorOfferRate: Number(estimate.rate),
      };
    } catch (error) {
      if (error instanceof PartnerApiError && error.code === "NO_OFFERS_AVAILABLE") return undefined;
      throw error;
    }
  }

  /**
   * Places a payout, unless the live quote costs more crypto than the person approved.
   *
   * Takes an executable quote and initiates it at once. A quote that would open a next-day (T+1)
   * order is treated as no match, because this flow does not sign the release such orders need.
   *
   * @param params.cryptoCurrencyCode Asset to spend (`USDC` or `USDT`).
   * @param params.fiatCurrencyCode Fiat currency to pay out.
   * @param params.fiatAmount Fiat the recipient receives, in whole units.
   * @param params.cryptoAmount Largest total crypto cost the person approved, in whole units.
   * @param params.paymentDetailsId Saved details to pay.
   * @param params.tradePartner Providers the payout may be matched to.
   * @returns The placed request, or one with status `new_price_confirming_by_initiator`, an empty
   *   id and the live amounts when the quote exceeds `cryptoAmount`; then nothing was placed.
   * @throws TransferExecutionError `kyc_required`, `no_match` or `price_changed`.
   * @throws PartnerApiError for any other refusal.
   */
  async createTradeRequest(params: {
    cryptoCurrencyCode: string;
    fiatCurrencyCode: string;
    fiatAmount: number;
    cryptoAmount: number;
    paymentDetailsId: string;
    tradePartner: TradePartnerPreference;
  }): Promise<TradeRequest> {
    try {
      const quote = await this.api.quoteOfframp({
        paymentDetailsId: params.paymentDetailsId,
        cryptoCurrency: params.cryptoCurrencyCode as FundingAssetCode,
        fiatCurrency: params.fiatCurrencyCode,
        fiatAmount: String(params.fiatAmount),
        providerScope: PROVIDER_SCOPE_BY_PREFERENCE[params.tradePartner],
      });
      if (quote.delayedSettlement) {
        throw new TransferExecutionError("no_match", "only a delayed settlement offer covers this payout");
      }
      if (Number(quote.cryptoAmount) > params.cryptoAmount) {
        return {
          id: "",
          status: "new_price_confirming_by_initiator",
          crypto_currency_code: params.cryptoCurrencyCode,
          fiat_currency_code: params.fiatCurrencyCode,
          fiat_amount: Number(quote.fiatAmount),
          total_crypto_amount: Number(quote.cryptoAmount),
          vendor_offer_rate: Number(quote.rate),
        };
      }
      return toTradeRequest(await this.api.initiateOfframp(quote.quoteId));
    } catch (error) {
      throw toExecutionError(error);
    }
  }

  /**
   * Waits until a provider accepts a placed order, reading it at the configured interval.
   *
   * @param tradeRequestId Order id from `createTradeRequest`.
   * @param timeoutMs How long to wait, in milliseconds.
   * @returns The request with its `trade` set.
   * @throws TransferExecutionError `match_timeout` when the wait ends first, `no_match` when the
   *   order ended without a provider.
   * @throws PartnerApiError when an order read is refused.
   */
  async waitForTradeMatch(tradeRequestId: string, timeoutMs: number): Promise<TradeRequest> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let waitedMs = 0;
    for (;;) {
      const order = await this.api.getOrder(tradeRequestId);
      if (ENDED_ORDER_STATUSES.has(order.status)) {
        throw new TransferExecutionError("no_match", `order ended as ${order.status} before a provider accepted it`);
      }
      if (!UNMATCHED_ORDER_STATUSES.has(order.status)) return toTradeRequest(order);
      if (waitedMs >= timeoutMs) {
        throw new TransferExecutionError("match_timeout", `no provider accepted within ${timeoutMs} ms`);
      }
      await sleep(this.options.matchPollIntervalMs);
      waitedMs += this.options.matchPollIntervalMs;
    }
  }

  /**
   * Funds the order's escrow from the partner wallet by signing the transfer locally.
   *
   * @param tradeId Order id.
   * @returns Nothing; the order moves on once the transfer confirms on chain.
   * @throws TransferExecutionError `insufficient_balance` when the wallet cannot cover the order.
   * @throws PartnerApiError for any other refusal.
   */
  async fundTradeEscrow(tradeId: string): Promise<void> {
    try {
      await this.api.authorizeCryptoTransfer(tradeId);
    } catch (error) {
      throw toExecutionError(error);
    }
  }

  /**
   * Reads a placed order as a trade request.
   *
   * @param tradeRequestId Order id.
   * @returns Current state, with `trade` set once a provider accepted.
   * @throws PartnerApiError when the read is refused.
   */
  async getTradeRequest(tradeRequestId: string): Promise<TradeRequest> {
    return toTradeRequest(await this.api.getOrder(tradeRequestId));
  }

  /**
   * Reads an order as a trade.
   *
   * @param tradeId Order id.
   * @returns Current settlement state.
   * @throws PartnerApiError when the read is refused.
   */
  async getTrade(tradeId: string): Promise<SettlementTrade> {
    return toSettlementTrade(await this.api.getOrder(tradeId));
  }

  /**
   * Lists the personal details an order is waiting for (the API's `update_kyc_address` action).
   *
   * @param tradeId Order id.
   * @returns One required missing field per field the API lists; none when the order asks for nothing.
   * @throws PartnerApiError when the read is refused.
   */
  async getPartnerPaymentDetailsDiff(tradeId: string): Promise<PartnerPaymentDetailsDiffData> {
    const order = await this.api.getOrder(tradeId);
    return {
      payment_details_id: "",
      differences: {
        missing_fields: (order.actionRequired?.fields ?? []).map((entry) => ({
          partner_field_name: entry.field,
          required: true,
          hint: entry.label || undefined,
        })),
      },
    };
  }

  /**
   * Supplies the personal details an order is waiting for by adding them to the sender's KYC record.
   *
   * @param params.internalDetailsId Unused: the fields attach to the sender, not to saved payment details.
   * @param params.partner Unused: the API has one requester.
   * @param params.details Field values keyed as `getPartnerPaymentDetailsDiff` named them.
   * @returns The values as sent.
   * @throws PartnerApiError when a value is refused; the API then stores none of them.
   */
  async createOrUpdatePartnerPaymentDetails(params: {
    internalDetailsId: string;
    partner: string;
    details: Record<string, string>;
  }): Promise<{ details?: Record<string, string> }> {
    await this.api.updateKycFields(params.details);
    return { details: params.details };
  }

  /**
   * Re-reads an order after extra details were supplied.
   *
   * @param tradeId Order id.
   * @returns The refreshed trade.
   * @throws PartnerApiError when the read is refused.
   */
  async revalidateTradePaymentDetails(tradeId: string): Promise<{ trade?: SettlementTrade }> {
    return { trade: await this.getTrade(tradeId) };
  }

  /**
   * Confirms the recipient received the fiat, which releases the escrow to the provider.
   *
   * @param tradeId Order id.
   * @returns The refreshed trade.
   * @throws PartnerApiError when the order cannot be confirmed in its current status.
   */
  async confirmFiatReceived(tradeId: string): Promise<SettlementTrade> {
    await this.api.confirmFiatReceived(tradeId);
    return this.getTrade(tradeId);
  }

  /**
   * Signs a stopped order's escrow back to the partner wallet.
   *
   * @param tradeId Order id.
   * @returns Nothing; the order's `authorize_refund` action clears once the refund executes.
   * @throws PartnerApiError when the order owes no refund or the signature is refused.
   */
  async authorizeRefund(tradeId: string): Promise<void> {
    await this.api.authorizeRefund(tradeId);
  }
}

/**
 * Converts an API refusal to the failure the flow handles, when there is one.
 *
 * @param error Anything thrown while placing or funding an order.
 * @returns A `TransferExecutionError` for KYC, no-offer, price-change and balance refusals;
 *   otherwise the original error, unchanged.
 */
function toExecutionError(error: unknown): unknown {
  if (!(error instanceof PartnerApiError)) return error;
  switch (error.code) {
    case "KYC_NOT_CLEARED":
      return new TransferExecutionError("kyc_required", error.message);
    case "NO_OFFERS_AVAILABLE":
      return new TransferExecutionError("no_match", error.message);
    case "PRICE_CHANGED_REQUOTE":
    case "QUOTE_EXPIRED":
      return new TransferExecutionError("price_changed", error.message);
    case "INSUFFICIENT_BALANCE":
      return new TransferExecutionError("insufficient_balance", error.message);
    default:
      return error;
  }
}

/**
 * Describes an order as a trade request.
 *
 * @param order Order as read from the API.
 * @returns Request carrying the order's amounts. `trade` is set, with the same id, once a provider
 *   accepted the order.
 */
function toTradeRequest(order: PartnerOrder): TradeRequest {
  const matched = !UNMATCHED_ORDER_STATUSES.has(order.status) && !ENDED_ORDER_STATUSES.has(order.status);
  return {
    id: order.orderId,
    status: order.status,
    crypto_currency_code: order.cryptoCurrency || undefined,
    fiat_currency_code: order.fiatCurrency || undefined,
    fiat_amount: order.fiatAmount ? Number(order.fiatAmount) : undefined,
    total_crypto_amount: order.cryptoAmount ? Number(order.cryptoAmount) : undefined,
    vendor_offer_rate: order.rate ? Number(order.rate) : undefined,
    trade: matched ? { id: order.orderId, status: toSettlementStatus(order) } : undefined,
  };
}

/**
 * Describes an order as a trade for the settlement monitor.
 *
 * @param order Order as read from the API.
 * @returns Trade with its settlement status, the actions the flow may take, and a marker while the
 *   order waits for extra personal details.
 */
function toSettlementTrade(order: PartnerOrder): SettlementTrade {
  const needsDetails = order.nextAction === "update_kyc_address";
  const possibleActions: string[] = [];
  if (order.nextAction === "authorize_crypto_transfer") possibleActions.push("action_fund_escrow");
  if (order.nextAction === "authorize_refund") possibleActions.push("action_authorize_refund");
  return {
    id: order.orderId,
    status: toSettlementStatus(order),
    total_crypto_amount: order.cryptoAmount ? Number(order.cryptoAmount) : null,
    possible_actions: possibleActions,
    partner_short_name: needsDetails ? DETAILS_REQUESTER_NAME : null,
    partner_details_checked_at: needsDetails ? null : undefined,
    payment_window_seconds_left: order.cryptoTransferAuthorizationSecondsLeft ?? null,
  };
}

/**
 * Chooses the flow's settlement status for an order.
 *
 * @param order Order as read from the API.
 * @returns A status the settlement monitor classifies. Orders this flow cannot operate (next-day
 *   settlement, disputes, unknown statuses) get a status the monitor treats as manual follow-up.
 */
function toSettlementStatus(order: PartnerOrder): string {
  if (order.delayedSettlement) return DELAYED_SETTLEMENT_STATUS;
  switch (order.status) {
    case "awaiting_crypto_transfer_authorization":
      return order.nextAction === "authorize_crypto_transfer" ? "awaiting_escrow_funding_by_seller" : "trade_created";
    case "fiat_payment_started":
    case "fiat_payment_review_started":
      // A provider that confirms delivery itself completes the order without the person's answer.
      return order.hasFiatSettlementNotification
        ? "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer"
        : "fiat_payment_proof_submitted_by_buyer";
    case "cancelled":
      return order.nextAction === "authorize_refund" ? REFUND_AUTHORIZATION_REQUIRED_STATUS : "canceled_by_seller";
    default:
      return SETTLEMENT_STATUS_BY_ORDER_STATUS[order.status] ?? order.status;
  }
}

/**
 * Describes saved Partner API payment details in the flow's shape.
 *
 * @param saved Details as the API returns them.
 * @returns Details with the institution as payment method and the rail as payment network. The API
 *   returns no rail display name, so the rail slug is used for both name and slug.
 */
function toPaymentDetail(saved: PartnerPaymentDetails): PaymentDetail {
  return {
    id: saved.paymentDetailsId,
    fiat_currency_code: saved.currency,
    payment_method: saved.institutionId ? { name: saved.institutionName || saved.institutionId, slug: saved.institutionId } : undefined,
    payment_network: saved.rail ? { name: saved.rail, slug: saved.rail } : undefined,
    details: saved.details,
  };
}

/**
 * Describes a Partner API verification state in the flow's shape.
 *
 * @param verification Verification as the API returns it.
 * @returns Status in the flow's vocabulary, link, time left and provider notes.
 */
function toKycVerificationData(verification: PartnerKycVerification): KycVerificationData {
  return {
    status: toKycStatus(verification.status),
    verification_url: verification.verificationUrl ?? null,
    verification_seconds_left: verification.verificationSecondsLeft,
    provider_messages: verification.providerMessages,
  };
}

/**
 * Translates a Partner API KYC status to the flow's vocabulary.
 *
 * @param status API status such as `VERIFIED`, `IN_PROGRESS`, `NOT_STARTED`, `VERIFICATION_REJECTED`.
 * @returns `VERIFIED` when cleared; `in_progress` while a session is open or under review
 *   (`COMPLETED` means the provider finished but UNIGOX has not approved yet); `rejected` when
 *   refused or failed; `not_started` otherwise.
 */
function toKycStatus(status: string): string {
  switch (status) {
    case "VERIFIED":
      return "VERIFIED";
    case "PENDING":
    case "IN_PROGRESS":
    case "COMPLETED":
    case "UNDER_REVIEW":
      return "in_progress";
    case "FAILED":
    case "VERIFICATION_REJECTED":
      return "rejected";
    default:
      return "not_started";
  }
}
