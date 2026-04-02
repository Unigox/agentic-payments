import type { TradeRequest } from "./unigox-client.ts";

export type SettlementPhase =
  | "matching"
  | "awaiting_partner_payment_details"
  | "awaiting_buyer_payment_details"
  | "awaiting_escrow_funding"
  | "waiting_for_fiat"
  | "awaiting_receipt_confirmation"
  | "receipt_confirmed_release_started"
  | "completed"
  | "refunded_or_cancelled"
  | "deferred";

export interface SettlementTrade {
  id: number;
  status: string;
  total_crypto_amount?: number | null;
  escrow_funded_amount?: number | null;
  possible_actions?: string[];
  partner_short_name?: string | null;
  partner_details_checked_at?: string | null;
  initiator_payment_details?: Record<string, unknown> | null;
  payment_request?: boolean;
  claim_autorelease_seconds_left?: number | null;
  payment_window_seconds_left?: number | null;
  open_dispute_seconds_left?: number | null;
  upload_dispute_proof_seconds_left?: number | null;
  fiat_payment_deadline?: string | null;
}

export interface SettlementMonitorClient {
  getTradeRequest?(tradeRequestId: number): Promise<TradeRequest>;
  getTrade?(tradeId: number): Promise<SettlementTrade | undefined>;
}

export interface SettlementMonitorState {
  tradeRequestId?: number;
  tradeRequestStatus?: string;
  tradeId?: number;
  tradeStatus?: string;
  phase?: SettlementPhase;
  awaitingUserActionSince?: string;
  nextReminderAt?: string;
  responseDeadlineAt?: string;
  reminderCount?: number;
  lastPromptedTradeStatus?: string;
  deferredReason?: string;
}

export interface SettlementMonitorOptions {
  now?: () => Date;
  pollIntervalMs?: number;
  timeoutMs?: number;
  receiptReminderMs?: number;
  receiptTimeoutMs?: number;
  continuePollingWhilePhases?: SettlementPhase[];
}

export interface SettlementMonitorEvent {
  type:
    | "status_changed"
    | "receipt_confirmation_requested"
    | "receipt_confirmation_reminder"
    | "receipt_confirmation_timeout"
    | "receipt_not_received"
    | "deferred_placeholder";
  message: string;
  data?: Record<string, unknown>;
}

export interface SettlementSnapshot {
  state: SettlementMonitorState;
  tradeRequest?: TradeRequest;
  trade?: SettlementTrade;
  phase: SettlementPhase;
  terminal: boolean;
  userActionRequired: boolean;
  summary: string;
  prompt: string;
  options: string[];
  events: SettlementMonitorEvent[];
  reminderDue: boolean;
  responseTimedOut: boolean;
}

const RECEIPT_REMINDER_MS = 15 * 60 * 1000;
const RECEIPT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const RECEIVED_RE = /^(yes(?:\b.*)?|received|got it|got the money|got funds|funds arrived|money arrived|arrived|came through|recipient received|paid)$/i;
const NOT_RECEIVED_RE = /^(no(?:\b.*)?|not received|not yet|hasn'?t arrived|didn'?t arrive|did not arrive|didn'?t get it|did not get it|no payment|not paid)$/i;

function nowIso(opts: SettlementMonitorOptions): string {
  return (opts.now ? opts.now() : new Date()).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRelativeSeconds(seconds?: number | null): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function describeTradeStatus(status?: string): string {
  switch (status) {
    case "trade_created":
      return "trade created";
    case "awaiting_escrow_funding_by_seller":
      return "waiting for escrow funding";
    case "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer":
      return "matched and waiting for the vendor to send fiat / upload proof";
    case "fiat_payment_proof_submitted_by_buyer":
      return "the vendor says fiat was sent and uploaded proof";
    case "fiat_payment_proof_accepted_by_system":
      return "the vendor proof was accepted by the system";
    case "fiat_payment_confirmed_by_seller_escrow_release_started":
      return "receipt confirmed and escrow release started";
    case "buyer_claimed_escrow_release_started":
      return "auto-release / claim started";
    case "escrow_released_to_buyer":
      return "escrow released to the buyer";
    case "escrow_refunded_to_seller":
      return "escrow refunded to the seller";
    case "payment_window_expired_escrow_refund_started":
      return "payment window expired and refund started";
    case "fiat_payment_proof_declined_escrow_refund_started":
      return "payment proof was declined and refund started";
    case "bank_returned_payment_escrow_refund_started":
      return "bank returned payment and refund started";
    case "canceled_by_buyer":
      return "trade cancelled by buyer";
    case "canceled_by_seller":
      return "trade cancelled by seller";
    case "dispute_started":
      return "trade entered dispute";
    case "escrow_funding_deadline_expired":
      return "escrow funding deadline expired";
    case "escrow_reservation_failed":
      return "escrow reservation failed";
    case "escrow_funding_error":
      return "escrow funding error";
    default:
      return status || "status unavailable";
  }
}

export function parseReceiptDecision(text: string | undefined): "received" | "not_received" | "other" | undefined {
  const value = (text || "").trim();
  if (!value) return undefined;
  if (RECEIVED_RE.test(value)) return "received";
  if (NOT_RECEIVED_RE.test(value)) return "not_received";
  return "other";
}

export function createInitialSettlementState(input: {
  tradeRequestId?: number;
  tradeRequestStatus?: string;
  tradeId?: number;
  tradeStatus?: string;
}): SettlementMonitorState {
  return {
    tradeRequestId: input.tradeRequestId,
    tradeRequestStatus: input.tradeRequestStatus,
    tradeId: input.tradeId,
    tradeStatus: input.tradeStatus,
    phase: input.tradeId ? classifyPhase(input.tradeStatus) : "matching",
    reminderCount: 0,
  };
}

function classifyPhase(tradeStatus?: string): SettlementPhase {
  switch (tradeStatus) {
    case undefined:
    case "":
      return "matching";
    case "trade_created":
    case "awaiting_escrow_funding_by_seller":
      return "awaiting_escrow_funding";
    case "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer":
      return "waiting_for_fiat";
    case "fiat_payment_proof_submitted_by_buyer":
    case "fiat_payment_proof_accepted_by_system":
      return "awaiting_receipt_confirmation";
    case "fiat_payment_confirmed_by_seller_escrow_release_started":
    case "buyer_claimed_escrow_release_started":
    case "dispute_resolved_for_buyer_release_started":
      return "receipt_confirmed_release_started";
    case "escrow_released_to_buyer":
      return "completed";
    case "escrow_refunded_to_seller":
    case "payment_window_expired_escrow_refund_started":
    case "fiat_payment_proof_declined_escrow_refund_started":
    case "bank_returned_payment_escrow_refund_started":
    case "canceled_by_buyer":
    case "canceled_by_seller":
    case "escrow_funding_deadline_expired":
    case "escrow_reservation_failed":
    case "escrow_funding_error":
      return "refunded_or_cancelled";
    default:
      return "deferred";
  }
}

function needsPartnerPaymentDetails(trade?: SettlementTrade): boolean {
  return !!(
    trade
    && trade.status === "trade_created"
    && trade.partner_short_name
    && trade.partner_details_checked_at == null
  );
}

function needsBuyerPaymentDetails(trade?: SettlementTrade): boolean {
  return !!(
    trade
    && trade.payment_request === true
    && trade.status === "awaiting_escrow_funding_by_seller"
    && !trade.initiator_payment_details
  );
}

function buildSummary(phase: SettlementPhase): string {
  switch (phase) {
    case "awaiting_partner_payment_details":
    case "awaiting_buyer_payment_details":
      return "Waiting for payout details";
    case "awaiting_escrow_funding":
      return "Securing the transfer";
    case "waiting_for_fiat":
      return "Waiting for payout";
    case "awaiting_receipt_confirmation":
      return "Waiting for recipient confirmation";
    case "receipt_confirmed_release_started":
      return "Release in progress";
    case "completed":
      return "Transfer complete";
    case "refunded_or_cancelled":
      return "Transfer ended";
    case "deferred":
      return "Manual follow-up needed";
    case "matching":
    default:
      return "Waiting for match";
  }
}

function buildPrompt(phase: SettlementPhase, state: SettlementMonitorState, trade?: SettlementTrade): { prompt: string; options: string[] } {
  const paymentWindowLeft = formatRelativeSeconds(trade?.payment_window_seconds_left);
  const claimWindowLeft = formatRelativeSeconds(trade?.claim_autorelease_seconds_left);

  switch (phase) {
    case "awaiting_partner_payment_details":
      return {
        prompt: "I found a payout route, but UNIGOX still needs one more payout detail before I can secure the transfer. I’m checking that now and I’ll come back if I need anything from you.",
        options: ["status"],
      };
    case "awaiting_buyer_payment_details":
      return {
        prompt: "The transfer is almost ready, but UNIGOX is still waiting for the payout details required before I can fund escrow. I’ll continue automatically as soon as those details are available.",
        options: ["status"],
      };
    case "awaiting_escrow_funding": {
      const extra = paymentWindowLeft ? ` I still have about ${paymentWindowLeft} before the payout window changes.` : "";
      return {
        prompt: `I found a counterparty and I’m securing the transfer now. The next step is funding escrow, and I’ll keep going automatically until there’s something you need to confirm.${extra}`,
        options: ["status"],
      };
    }
    case "waiting_for_fiat": {
      const extra = paymentWindowLeft ? ` I’ll keep watching the payout until the window closes in about ${paymentWindowLeft}.` : "";
      return {
        prompt: `The transfer is live and escrow is funded. I’m watching for the payout to leave the counterparty bank, and I’ll tell you as soon as I need you to confirm receipt.${extra}`,
        options: ["status"],
      };
    }
    case "awaiting_receipt_confirmation": {
      const extra = claimWindowLeft ? ` If nothing changes, the protection window is about ${claimWindowLeft}.` : paymentWindowLeft ? ` The current payout window is about ${paymentWindowLeft}.` : "";
      return {
        prompt: `The counterparty says the payout has been sent. It may already have arrived, or it may still be on the way from the counterparty bank. Please let me know once you receive the payment. If it has not arrived, reply 'not received' so I keep the transfer protected.${extra}`,
        options: ["received", "not received", "status"],
      };
    }
    case "receipt_confirmed_release_started":
      return {
        prompt: "You confirmed the payout, so release has started. I’m watching it through the final completion.",
        options: ["status"],
      };
    case "completed":
      return {
        prompt: "The transfer is complete.",
        options: [],
      };
    case "refunded_or_cancelled":
      return {
        prompt: "This transfer ended without payout completion, so the funds should stay on or return to the sender side.",
        options: ["status"],
      };
    case "deferred":
      return {
        prompt: "This transfer needs manual follow-up. I’m keeping it protected and I won’t release anything automatically.",
        options: ["status"],
      };
    case "matching":
    default:
      return {
        prompt: "The transfer is created and I’m still waiting for the next concrete settlement update.",
        options: ["status"],
      };
  }
}

function updateReminderState(state: SettlementMonitorState, phase: SettlementPhase, opts: SettlementMonitorOptions): { reminderDue: boolean; responseTimedOut: boolean; events: SettlementMonitorEvent[] } {
  const events: SettlementMonitorEvent[] = [];
  const requiresResponse = phase === "awaiting_receipt_confirmation";

  if (!requiresResponse) {
    state.awaitingUserActionSince = undefined;
    state.nextReminderAt = undefined;
    state.responseDeadlineAt = undefined;
    return { reminderDue: false, responseTimedOut: false, events };
  }

  const now = opts.now ? opts.now() : new Date();
  const reminderMs = opts.receiptReminderMs ?? RECEIPT_REMINDER_MS;
  const timeoutMs = opts.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  const phaseKey = `${phase}:${state.tradeStatus || "unknown"}`;

  if (!state.awaitingUserActionSince || state.lastPromptedTradeStatus !== phaseKey) {
    state.awaitingUserActionSince = now.toISOString();
    state.nextReminderAt = new Date(now.getTime() + reminderMs).toISOString();
    state.responseDeadlineAt = new Date(now.getTime() + timeoutMs).toISOString();
    state.reminderCount = state.reminderCount || 0;
    state.lastPromptedTradeStatus = phaseKey;
    events.push({
      type: "receipt_confirmation_requested",
      message: "Receipt confirmation is now pending from the user.",
      data: { tradeStatus: state.tradeStatus, phase },
    });
    return { reminderDue: false, responseTimedOut: false, events };
  }

  const reminderDue = !!state.nextReminderAt && now >= new Date(state.nextReminderAt);
  const responseTimedOut = !!state.responseDeadlineAt && now >= new Date(state.responseDeadlineAt);

  if (responseTimedOut) {
    state.nextReminderAt = new Date(now.getTime() + reminderMs).toISOString();
    state.reminderCount = (state.reminderCount || 0) + 1;
    events.push({
      type: "receipt_confirmation_timeout",
      message: "Receipt confirmation is overdue; escrow remains locked.",
      data: { reminderCount: state.reminderCount },
    });
  } else if (reminderDue) {
    state.nextReminderAt = new Date(now.getTime() + reminderMs).toISOString();
    state.reminderCount = (state.reminderCount || 0) + 1;
    events.push({
      type: "receipt_confirmation_reminder",
      message: "Receipt confirmation reminder is due.",
      data: { reminderCount: state.reminderCount },
    });
  }

  return { reminderDue, responseTimedOut, events };
}

export async function refreshSettlementSnapshot(
  state: SettlementMonitorState,
  client: SettlementMonitorClient,
  opts: SettlementMonitorOptions = {}
): Promise<SettlementSnapshot> {
  const nextState: SettlementMonitorState = { ...state, reminderCount: state.reminderCount || 0 };
  let tradeRequest: TradeRequest | undefined;
  let trade: SettlementTrade | undefined;
  const events: SettlementMonitorEvent[] = [];

  if (nextState.tradeRequestId && client.getTradeRequest) {
    tradeRequest = await client.getTradeRequest(nextState.tradeRequestId);
    if (tradeRequest.status !== nextState.tradeRequestStatus) {
      events.push({
        type: "status_changed",
        message: `Trade request status changed to ${tradeRequest.status}.`,
        data: { previous: nextState.tradeRequestStatus, next: tradeRequest.status },
      });
    }
    nextState.tradeRequestStatus = tradeRequest.status;
    if (tradeRequest.trade?.id) nextState.tradeId = tradeRequest.trade.id;
    if (tradeRequest.trade?.status) nextState.tradeStatus = tradeRequest.trade.status;
  }

  if (nextState.tradeId && client.getTrade) {
    trade = await client.getTrade(nextState.tradeId);
    if (trade?.status && trade.status !== nextState.tradeStatus) {
      events.push({
        type: "status_changed",
        message: `Trade status changed to ${trade.status}.`,
        data: { previous: nextState.tradeStatus, next: trade.status },
      });
    }
    if (trade?.status) nextState.tradeStatus = trade.status;
  }

  if (needsPartnerPaymentDetails(trade)) {
    nextState.phase = "awaiting_partner_payment_details";
  } else if (needsBuyerPaymentDetails(trade)) {
    nextState.phase = "awaiting_buyer_payment_details";
  } else {
    nextState.phase = nextState.tradeId ? classifyPhase(nextState.tradeStatus) : "matching";
  }
  const phase = nextState.phase;
  const reminder = updateReminderState(nextState, phase, opts);
  events.push(...reminder.events);

  const built = buildPrompt(phase, nextState, trade);
  return {
    state: nextState,
    tradeRequest,
    trade,
    phase,
    terminal: phase === "completed" || phase === "refunded_or_cancelled",
    userActionRequired: phase === "awaiting_receipt_confirmation",
    summary: buildSummary(phase),
    prompt: built.prompt,
    options: built.options,
    events,
    reminderDue: reminder.reminderDue,
    responseTimedOut: reminder.responseTimedOut,
  };
}

export async function pollSettlementSnapshot(
  state: SettlementMonitorState,
  client: SettlementMonitorClient,
  opts: SettlementMonitorOptions = {}
): Promise<SettlementSnapshot> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const continuePollingWhilePhases = new Set(opts.continuePollingWhilePhases || []);
  const started = Date.now();

  let first = await refreshSettlementSnapshot(state, client, opts);
  if (first.terminal || first.phase === "awaiting_receipt_confirmation" || first.phase === "receipt_confirmed_release_started" || first.phase === "deferred") {
    return first;
  }

  let previousStatus = `${first.state.tradeRequestStatus || ""}|${first.state.tradeStatus || ""}|${first.phase}`;
  let snapshot = first;

  while (Date.now() - started < timeoutMs) {
    await sleep(pollIntervalMs);
    snapshot = await refreshSettlementSnapshot(snapshot.state, client, opts);
    const currentStatus = `${snapshot.state.tradeRequestStatus || ""}|${snapshot.state.tradeStatus || ""}|${snapshot.phase}`;
    if (snapshot.terminal || snapshot.userActionRequired) {
      return snapshot;
    }
    if (currentStatus !== previousStatus) {
      if (continuePollingWhilePhases.has(snapshot.phase)) {
        previousStatus = currentStatus;
        continue;
      }
      return snapshot;
    }
    previousStatus = currentStatus;
  }

  return snapshot;
}

export function noteReceiptNotReceived(
  state: SettlementMonitorState,
  reason: string
): { state: SettlementMonitorState; events: SettlementMonitorEvent[]; prompt: string; options: string[] } {
  const nextState: SettlementMonitorState = {
    ...state,
    phase: "deferred",
    deferredReason: reason,
  };

  return {
    state: nextState,
    events: [
      {
        type: "receipt_not_received",
        message: "User reported that fiat has not been received yet.",
        data: { reason },
      },
    ],
    prompt: "Okay — I’m keeping the transfer protected because the payout has not been confirmed as received yet. The next step is manual follow-up while I continue monitoring status.",
    options: ["status", "received"],
  };
}

export function noteDeferredPlaceholder(
  state: SettlementMonitorState,
  reason: string
): { state: SettlementMonitorState; events: SettlementMonitorEvent[]; prompt: string; options: string[] } {
  const nextState: SettlementMonitorState = {
    ...state,
    phase: "deferred",
    deferredReason: reason,
  };

  return {
    state: nextState,
    events: [
      {
        type: "deferred_placeholder",
        message: "Settlement moved into a safe deferred placeholder path.",
        data: { reason },
      },
    ],
    prompt: "I’m not automating that response path yet. The transfer stays protected and moves to manual follow-up. In this phase, only an explicit 'received' confirmation would allow release; 'not received' keeps it locked.",
    options: ["status", "received", "not received"],
  };
}
