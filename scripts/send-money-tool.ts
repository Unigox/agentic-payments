#!/usr/bin/env -S node --experimental-strip-types
import { runTransferTurn } from "./run-transfer-turn.ts";
import type { TransferFlowDeps, TransferFlowResult } from "./transfer-orchestrator.ts";

export interface SendMoneyToolInput {
  text: string;
  session_key: string;
  reset?: boolean;
}

export const SEND_MONEY_TOOL_NAME = "send_money_turn";
export const SEND_MONEY_TOOL_DESCRIPTION = "Advance one conversational turn of the UNIGOX send-money flow. Reuse the same session_key across turns so recipient resolution, auth, KYC, quotes, and settlement state continue correctly.";

export const SEND_MONEY_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description: "The latest user message for the send-money flow, including follow-ups like recipient names, amounts, yes/no confirmations, payout details, KYC details, or receipt confirmations.",
    },
    session_key: {
      type: "string",
      description: "A stable per-chat or per-user conversation key. Reuse the same value across turns so the transfer session resumes instead of restarting.",
    },
    reset: {
      type: "boolean",
      description: "When true, ignore any saved session state for this session_key and start a fresh send-money flow.",
    },
  },
  required: ["text", "session_key"],
} as const;

export function buildOpenAIToolDefinition() {
  return {
    type: "function",
    name: SEND_MONEY_TOOL_NAME,
    description: SEND_MONEY_TOOL_DESCRIPTION,
    parameters: SEND_MONEY_TOOL_INPUT_SCHEMA,
    strict: true,
  };
}

export function buildAnthropicToolDefinition() {
  return {
    name: SEND_MONEY_TOOL_NAME,
    description: SEND_MONEY_TOOL_DESCRIPTION,
    input_schema: SEND_MONEY_TOOL_INPUT_SCHEMA,
  };
}

export async function runSendMoneyToolTurn(
  input: SendMoneyToolInput,
  deps?: TransferFlowDeps
): Promise<TransferFlowResult> {
  const text = input.text?.trim();
  const sessionKey = input.session_key?.trim();

  if (!text) {
    throw new Error("send_money_turn requires non-empty text.");
  }
  if (!sessionKey) {
    throw new Error("send_money_turn requires a stable session_key.");
  }

  return runTransferTurn({
    text,
    sessionKey,
    reset: input.reset,
    deps,
  });
}
