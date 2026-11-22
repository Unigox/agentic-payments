/**
 * Transfer execution port.
 *
 * The contract between the conversational flow (`transfer-orchestrator.ts`, `settlement-monitor.ts`)
 * and whatever backend moves the money. The flow owns this vocabulary: a "trade request" is a payout
 * being matched to a provider, and a "trade" is that payout once a provider accepted it.
 * `partner-execution-client.ts` implements the port on the UNIGOX Partner API; tests implement it
 * with in-memory fakes.
 */

/** Which providers may serve a payout. Read from `settings.json` by the orchestrator. */
export type TradePartnerPreference = "licensed" | "p2p" | "all";

/** Operator settings for the send-money flow. Loaded by the orchestrator from `settings.json`. */
export interface AgenticPaymentsSettings {
  /** Providers a payout may be matched to. */
  tradePartner: TradePartnerPreference;
}

/** Bank or wallet details saved with the backend and usable as a payout target. */
export interface PaymentDetail {
  /** Backend id of the saved details. */
  id: string;
  /** Fiat currency of the payout account. */
  fiat_currency_code: string;
  /** Institution the details belong to. Absent when the backend does not report one. */
  payment_method?: { name: string; slug: string };
  /** Rail the details are paid over. Absent when the backend does not report one. */
  payment_network?: { name: string; slug: string };
  /** Rail-specific fields as saved, e.g. `{ iban, full_name }`. */
  details: Record<string, string>;
}

/** A payout being placed and matched to a provider. */
export interface TradeRequest {
  /** Backend id. Empty while `status` is `new_price_confirming_by_initiator`: nothing was placed yet. */
  id: string;
  /**
   * Backend status, kept for display. The one value the flow branches on is
   * `new_price_confirming_by_initiator`: the live price costs more than the person approved.
   */
  status: string;
  /** Asset being spent. */
  crypto_currency_code?: string;
  /** Fiat currency being paid out. */
  fiat_currency_code?: string;
  /** Fiat the recipient receives, in whole units. */
  fiat_amount?: number;
  /** Total crypto cost including fees, in whole units. */
  total_crypto_amount?: number;
  /** Fiat received per unit of crypto. */
  vendor_offer_rate?: number;
  /** Institution name, when the backend reports it. */
  payment_method_name?: string;
  /** Rail name, when the backend reports it. */
  payment_network_name?: string;
  /** Present once a provider accepted the payout. `status` is a settlement status the monitor classifies. */
  trade?: { id: string; status: string };
}

/** A past or open payout started by this sender, as listed for startup reminders. */
export interface InitiatorTradeSummary {
  /** Backend id of the trade. */
  id: string;
  /** Settlement status the monitor classifies. */
  status: string;
  /** Fiat amount in whole units. */
  fiat_amount?: number;
  /** Fiat currency code. */
  fiat_currency_code?: string;
  /** Institution name. */
  payment_method_name?: string;
  /** Rail name. */
  payment_network_name?: string;
  /** ISO time of the last status change. */
  status_changed_at?: string;
  /** Provider short name when extra payout details may be required. */
  partner_short_name?: string | null;
  /** When the provider last accepted the payout details; null while they are still required. */
  partner_details_checked_at?: string | null;
  /** True for a payment-request style trade. */
  payment_request?: boolean;
  /** Actions the backend allows on the trade. */
  possible_actions?: string[];
  /** The payout details the trade pays to. */
  initiator_payment_details?: {
    id?: string;
    details?: Record<string, unknown>;
    payment_method_name?: string;
    payment_network_name?: string;
  } | null;
}

/** Indicative price shown before the person confirms. Never a locked quote. */
export interface PreflightQuote {
  /** Always `estimate`: the price is not reserved. */
  quoteType: "estimate";
  /** Always `best_offer`: priced on the best currently matching provider. */
  source: "best_offer";
  /** Asset that would be spent. */
  cryptoCurrencyCode: string;
  /** Fiat currency that would be paid out. */
  fiatCurrencyCode: string;
  /** Fiat the recipient would receive, in whole units. */
  fiatAmount: number;
  /** Total crypto cost including fees, in whole units. */
  totalCryptoAmount: number;
  /** Fee part of `totalCryptoAmount`, in whole units of the asset. */
  feeCryptoAmount: number;
  /** Fiat received per unit of crypto. */
  vendorOfferRate: number;
  /** Institution name the price was matched on, when known. */
  paymentMethodName?: string;
  /** Rail name the price was matched on, when known. */
  paymentNetworkName?: string;
}

/** One extra payout detail a provider asks for before the escrow can be funded. */
export interface PartnerPaymentFieldDiff {
  /** Field key as the backend names it. */
  partner_field_name: string;
  /** Local field key, when it differs from the backend's. */
  internal_field_name?: string;
  /** Whether the transfer cannot proceed without it. */
  required: boolean;
  /** Value currently on file, for an invalid field. */
  current_value?: string;
  /** Regular expression the value must match. */
  expected_pattern?: string;
  /** Example value. */
  example?: string;
  /** Short explanation of the field. */
  hint?: string;
  /** Allowed values for a choice field. */
  options?: Array<{ value: string; label: string }>;
}

/** The extra payout details a trade is waiting for. */
export interface PartnerPaymentDetailsDiffData {
  /** Id of the saved payment details the fields belong to. Empty when they attach to the sender instead. */
  payment_details_id: string;
  /** Fields still missing and fields on file that were refused. */
  differences: {
    missing_fields?: PartnerPaymentFieldDiff[];
    invalid_fields?: PartnerPaymentFieldDiff[];
  };
}

/** One asset held by the paying wallet. */
export interface WalletBalanceAsset {
  /** Asset code, e.g. `USDC`. */
  assetCode: string;
  /** Holding in whole units. */
  amount: number;
}

/** What the paying wallet holds. */
export interface WalletBalance {
  /** USDC holding in whole units. */
  usdc: number;
  /** USDT holding in whole units. */
  usdt: number;
  /** Sum of the holdings, treating each unit as one dollar. */
  totalUsd: number;
  /** Per-asset holdings. Absent when only the totals are known. */
  assets?: WalletBalanceAsset[];
}

/** The sender as shown in the conversation. */
export interface UserProfile {
  /** Name the sender is addressed by in prompts; the Partner API implementation uses the sender's email. */
  username?: string;
  /** Legal first name on the verified identity, when known. */
  first_name?: string;
  /** Legal last name on the verified identity, when known. */
  last_name?: string;
  /** ISO alpha-2 country of the verified identity, when known. */
  kyc_country_code?: string;
  /** Verification state; `VERIFIED` means cleared, `in_progress` means a session is open. */
  id_verification_status?: string;
}

/** State of the sender's identity verification. */
export interface KycVerificationData {
  /** `VERIFIED` when cleared; `initial`, `pending` or `in_progress` while a session is open. */
  status?: string;
  /** Hosted verification page, while a session is open. */
  verification_url?: string | null;
  /** Seconds left on the verification session. */
  verification_seconds_left?: number;
  /** True when no further attempts are allowed. */
  max_attempts_reached?: boolean;
  /** Machine key of a failure to read or start verification. */
  error_key?: string;
  /** Provider notes such as rejection reasons. */
  provider_messages?: string[];
}

/** A trade as the settlement monitor sees it. */
export interface SettlementTrade {
  /** Backend id of the trade. */
  id: string;
  /** Settlement status the monitor classifies into a phase. */
  status: string;
  /** Total crypto cost including fees, in whole units. */
  total_crypto_amount?: number | null;
  /** Actions the flow may take: `action_fund_escrow`, `action_authorize_refund`. */
  possible_actions?: string[];
  /** Set while the provider needs extra payout details. */
  partner_short_name?: string | null;
  /** Null while extra payout details are still required. */
  partner_details_checked_at?: string | null;
  /** The payout details the trade pays to, when the backend reports them. */
  initiator_payment_details?: Record<string, unknown> | null;
  /** True for a payment-request style trade. */
  payment_request?: boolean;
  /** Seconds until the buyer may claim an automatic release. */
  claim_autorelease_seconds_left?: number | null;
  /** Seconds left in the current payment or funding window. */
  payment_window_seconds_left?: number | null;
}

/**
 * Why a transfer step could not be carried out, in terms the flow can act on.
 *
 * - `kyc_required`: the sender must finish identity verification first.
 * - `no_match`: no provider can serve this currency, method and amount right now.
 * - `match_timeout`: no provider accepted within the wait; the request is still open.
 * - `price_changed`: the price moved while the order was being placed; nothing was placed.
 * - `insufficient_balance`: the paying wallet cannot cover the order.
 */
export type TransferExecutionFailure =
  | "kyc_required"
  | "no_match"
  | "match_timeout"
  | "price_changed"
  | "insufficient_balance";

/**
 * A transfer step failed for a reason the flow handles by name.
 * Thrown by implementations of `TransferExecutionClient`; caught by the orchestrator, which owns
 * the wording shown to the person. `message` is engineering detail only.
 */
export class TransferExecutionError extends Error {
  /** The reason, which the orchestrator branches on. */
  readonly reason: TransferExecutionFailure;

  /**
   * @param reason Why the step failed.
   * @param detail Engineering detail for logs. Never shown to the person.
   */
  constructor(reason: TransferExecutionFailure, detail = "") {
    super(detail || reason);
    this.name = "TransferExecutionError";
    this.reason = reason;
  }
}

/**
 * Everything the flow needs from a payments backend.
 * Implemented by `PartnerExecutionClient`; consumed by the orchestrator and the settlement monitor.
 * Optional methods are features the flow skips when a backend does not provide them.
 */
export interface TransferExecutionClient {
  /**
   * Reads the sender's display name and verification state.
   * @returns The profile. Fields the backend does not know are absent.
   */
  getProfile?(): Promise<UserProfile>;

  /**
   * Reads what the paying wallet holds.
   * @returns Holdings per asset and their sum.
   */
  getWalletBalance(): Promise<WalletBalance>;

  /**
   * Reads the state of the sender's identity verification.
   * @returns Status and, while a session is open, the hosted verification link.
   */
  getKycVerificationStatus?(): Promise<KycVerificationData>;

  /**
   * Starts identity verification for the sender.
   * @param params.fullName Legal name, first name first.
   * @param params.country ISO alpha-2 country of residence.
   * @returns Status and the hosted verification link when the backend issues one at once.
   */
  initializeKycVerification?(params: { fullName: string; country: string }): Promise<KycVerificationData>;

  /**
   * Lists payout details already saved with the backend.
   * @returns Saved details; empty when there are none.
   */
  listPaymentDetails?(): Promise<PaymentDetail[]>;

  /**
   * Lists the sender's trades for startup reminders.
   * @param filter Which trades to list.
   * @returns Matching trades.
   */
  listInitiatorTrades?(filter?: "action_required" | "waiting_other_party" | "history"): Promise<InitiatorTradeSummary[]>;

  /**
   * Returns saved payout details equal to the given ones, saving them first when none exist.
   * @param params.fiatCurrencyCode Fiat currency of the payout account.
   * @param params.paymentMethodSlug Institution slug.
   * @param params.paymentNetworkSlug Rail slug.
   * @param params.details Rail-specific fields.
   * @returns The saved details with their backend id.
   */
  ensurePaymentDetail(params: {
    fiatCurrencyCode: string;
    paymentMethodSlug: string;
    paymentNetworkSlug: string;
    details: Record<string, string>;
  }): Promise<PaymentDetail>;

  /**
   * Prices a payout without placing it.
   * @param params.cryptoCurrencyCode Asset that would be spent.
   * @param params.fiatCurrencyCode Fiat currency to pay out.
   * @param params.fiatAmount Fiat the recipient should receive, in whole units.
   * @param params.paymentMethodSlug Institution slug, to price on that institution's route.
   * @param params.paymentNetworkSlug Rail slug, to price on that rail.
   * @param params.tradePartner Providers the payout may be matched to.
   * @returns The estimate, or `undefined` when nothing can serve the payout right now.
   */
  getPreflightQuote?(params: {
    cryptoCurrencyCode: string;
    fiatCurrencyCode: string;
    fiatAmount: number;
    paymentMethodSlug?: string;
    paymentNetworkSlug?: string;
    tradePartner: TradePartnerPreference;
  }): Promise<PreflightQuote | undefined>;

  /**
   * Places a payout, unless the live price costs more crypto than the person approved.
   * @param params.cryptoCurrencyCode Asset to spend.
   * @param params.fiatCurrencyCode Fiat currency to pay out.
   * @param params.fiatAmount Fiat the recipient receives, in whole units.
   * @param params.cryptoAmount Largest total crypto cost the person approved, in whole units.
   * @param params.paymentDetailsId Saved details to pay.
   * @param params.tradePartner Providers the payout may be matched to.
   * @returns The placed request, or one with status `new_price_confirming_by_initiator` and the live
   *   amounts when the price exceeds `cryptoAmount`; in that case nothing was placed.
   * @throws TransferExecutionError `kyc_required`, `no_match` or `price_changed`.
   */
  createTradeRequest(params: {
    cryptoCurrencyCode: string;
    fiatCurrencyCode: string;
    fiatAmount: number;
    cryptoAmount: number;
    paymentDetailsId: string;
    tradePartner: TradePartnerPreference;
  }): Promise<TradeRequest>;

  /**
   * Waits until a provider accepts a placed request.
   * @param tradeRequestId Id from `createTradeRequest`.
   * @param timeoutMs How long to wait, in milliseconds.
   * @returns The request with its `trade` set.
   * @throws TransferExecutionError `match_timeout` when the wait ends first, `no_match` when the
   *   request ended without a provider.
   */
  waitForTradeMatch(tradeRequestId: string, timeoutMs: number): Promise<TradeRequest>;

  /**
   * Moves the trade's crypto from the paying wallet into its escrow.
   * @param tradeId Trade whose `possible_actions` include `action_fund_escrow`.
   * @returns Nothing; the trade's status changes once the transfer confirms.
   * @throws TransferExecutionError `insufficient_balance` when the wallet cannot cover the trade.
   */
  fundTradeEscrow?(tradeId: string): Promise<void>;

  /**
   * Reads a placed request.
   * @param tradeRequestId Id from `createTradeRequest`.
   * @returns Current state, with `trade` set once a provider accepted.
   */
  getTradeRequest?(tradeRequestId: string): Promise<TradeRequest>;

  /**
   * Reads a trade.
   * @param tradeId Id from `TradeRequest.trade`.
   * @returns Current state, or `undefined` when the backend no longer knows the trade.
   */
  getTrade?(tradeId: string): Promise<SettlementTrade | undefined>;

  /**
   * Lists the extra payout details a trade is waiting for.
   * @param tradeId Trade whose `partner_details_checked_at` is null.
   * @returns Missing and refused fields; both lists empty when nothing more is needed.
   */
  getPartnerPaymentDetailsDiff?(tradeId: string): Promise<PartnerPaymentDetailsDiffData>;

  /**
   * Supplies extra payout details a trade is waiting for.
   * @param params.internalDetailsId Saved details the fields belong to; empty when they attach to the sender.
   * @param params.partner Provider short name from the trade.
   * @param params.details Field values keyed as `getPartnerPaymentDetailsDiff` named them.
   * @returns The values as stored.
   */
  createOrUpdatePartnerPaymentDetails?(params: {
    internalDetailsId: string;
    partner: string;
    details: Record<string, string>;
  }): Promise<{ details?: Record<string, string> }>;

  /**
   * Re-reads a trade after extra payout details were supplied.
   * @param tradeId Trade to re-read.
   * @returns The refreshed trade.
   */
  revalidateTradePaymentDetails?(tradeId: string): Promise<{ trade?: SettlementTrade | undefined } | undefined>;

  /**
   * Confirms the recipient received the fiat, which releases the escrow to the provider.
   * @param tradeId Trade awaiting receipt confirmation.
   * @returns The refreshed trade.
   */
  confirmFiatReceived?(tradeId: string): Promise<SettlementTrade | undefined>;

  /**
   * Returns a stopped trade's escrow to the paying wallet.
   * @param tradeId Trade whose `possible_actions` include `action_authorize_refund`.
   * @returns Nothing; the trade's status changes once the refund executes.
   */
  authorizeRefund?(tradeId: string): Promise<void>;
}
