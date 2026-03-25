import type { TradeRequest } from "./unigox-client.ts";

export type SettlementPhase =
  | "matching"
  | "waiting_for_fiat"
  | "awaiting_receipt_confirmation"
  | "receipt_confirmed_release_started"
  | "completed"
  | "refunded_or_cancelled"
  | "deferred";

export interface SettlementTrade {
  id: number;
  status: string;
  possible_actions?: string[];
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

const RECEIVED_RE = /^(yes|received|got it|got the money|got funds|funds arrived|money arrived|arrived|came through|recipient received|paid)$/i;
const NOT_RECEIVED_RE = /^(no|not received|not yet|hasn'?t arrived|didn'?t arrive|did not arrive|didn'?t get it|did not get it|no payment|not paid)$/i;

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

function buildSummary(state: SettlementMonitorState): string {
  const parts: string[] = [];
  if (state.tradeRequestId) parts.push(`Trade request #${state.tradeRequestId}`);
  if (state.tradeRequestStatus) parts.push(`request status: ${state.tradeRequestStatus}`);
  if (state.tradeId) parts.push(`trade #${state.tradeId}`);
  if (state.tradeStatus) parts.push(`trade status: ${state.tradeStatus}`);
  return parts.join(" · ");
}

function buildPrompt(phase: SettlementPhase, state: SettlementMonitorState, trade?: SettlementTrade): { prompt: string; options: string[] } {
  const base = buildSummary(state);
  const paymentWindowLeft = formatRelativeSeconds(trade?.payment_window_seconds_left);
  const claimWindowLeft = formatRelativeSeconds(trade?.claim_autorelease_seconds_left);

  switch (phase) {
    case "waiting_for_fiat": {
      const extra = paymentWindowLeft ? ` Payment window left: ${paymentWindowLeft}.` : "";
      return {
        prompt: `${base}. The trade is matched and still waiting on fiat settlement (${describeTradeStatus(state.tradeStatus)}). Reply 'received' only after the recipient confirms the fiat arrived, or 'not received' if it has not. I will keep escrow locked unless you explicitly confirm receipt.${extra}`,
        options: ["received", "not received", "status"],
      };
    }
    case "awaiting_receipt_confirmation": {
      const extra = claimWindowLeft ? ` Auto-release claim window: ${claimWindowLeft}.` : paymentWindowLeft ? ` Payment window left: ${paymentWindowLeft}.` : "";
      return {
        prompt: `${base}. The backend now indicates ${describeTradeStatus(state.tradeStatus)}. Has the recipient actually received the fiat? Reply 'received' to confirm and release escrow, or 'not received' to keep escrow locked.${extra}`,
        options: ["received", "not received", "status"],
      };
    }
    case "receipt_confirmed_release_started":
      return {
        prompt: `${base}. Receipt has already been confirmed and release has started (${describeTradeStatus(state.tradeStatus)}). I can keep checking until it reaches the final released state.`,
        options: ["status"],
      };
    case "completed":
      return {
        prompt: `${base}. Settlement is complete: ${describeTradeStatus(state.tradeStatus)}.`,
        options: [],
      };
    case "refunded_or_cancelled":
      return {
        prompt: `${base}. The trade ended without release (${describeTradeStatus(state.tradeStatus)}). Escrow should remain with / return to the seller side.`,
        options: ["status"],
      };
    case "deferred":
      return {
        prompt: `${base}. The trade is in a post-match state I am intentionally not automating in this phase (${describeTradeStatus(state.tradeStatus)}). I will keep escrow untouched and defer to manual follow-up.`,
        options: ["status"],
      };
    case "matching":
    default:
      return {
        prompt: `${base || "Trade created"}. Still waiting for a concrete trade settlement state.`,
        options: ["status"],
      };
  }
}

function updateReminderState(state: SettlementMonitorState, phase: SettlementPhase, opts: SettlementMonitorOptions): { reminderDue: boolean; responseTimedOut: boolean; events: SettlementMonitorEvent[] } {
  const events: SettlementMonitorEvent[] = [];
  const requiresResponse = phase === "waiting_for_fiat" || phase === "awaiting_receipt_confirmation";

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

  nextState.phase = nextState.tradeId ? classifyPhase(nextState.tradeStatus) : "matching";
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
    userActionRequired: phase === "waiting_for_fiat" || phase === "awaiting_receipt_confirmation",
    summary: buildSummary(nextState),
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
    if (snapshot.terminal || snapshot.userActionRequired || currentStatus !== previousStatus) {
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
    prompt: `${buildSummary(nextState)}. Okay — I am keeping escrow locked because the fiat has not been confirmed as received. The real dispute / extension flow is intentionally deferred in this phase, so the safe next step is manual follow-up while I continue monitoring status.`,
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
    prompt: `${buildSummary(nextState)}. I am not automating that response path yet. Escrow stays locked and this trade is deferred for manual follow-up. In this phase, only explicit 'received' confirmation triggers release; 'not received' keeps it locked.`,
    options: ["status", "received", "not received"],
  };
}
