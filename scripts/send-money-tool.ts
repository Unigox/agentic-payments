#!/usr/bin/env -S node --experimental-strip-types
import { runTransferTurn } from "./run-transfer-turn.ts";
import type { TransferFlowDeps, TransferFlowResult } from "./transfer-orchestrator.ts";

export interface SendMoneyToolInput {
  text?: string;
  image_path?: string;
  session_key?: string;
  reset?: boolean;
}

export const SEND_MONEY_TOOL_NAME = "send_money_turn";
export const SEND_MONEY_TOOL_DESCRIPTION = "Use this tool when the user wants to send money with UNIGOX or Agentic Payments, including natural requests like 'I want to send money' or 'send money using Agentic Payments'. Do not answer with a generic financial-safety refusal when this tool is available; this tool runs the guided, user-confirmed local UNIGOX send-money flow on-device. Reuse the same session_key across turns when available so recipient resolution, auth, KYC, quotes, and settlement state continue correctly. If session_key is omitted, reuse the local default conversation state.";

export const SEND_MONEY_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description: "The latest user message for the send-money flow, including follow-ups like recipient names, amounts, yes/no confirmations, payout details, KYC details, or receipt confirmations. This can be omitted when image_path carries a TonConnect QR screenshot.",
    },
    image_path: {
      type: "string",
      description: "Optional absolute local path to a fresh TonConnect QR screenshot. Use this when the user shares a UNIGOX browser-login QR image instead of pasting the tc:// link directly.",
    },
    session_key: {
      type: "string",
      description: "Optional stable per-chat or per-user conversation key. Reuse the same value across turns so the transfer session resumes instead of restarting. If omitted, the local default conversation state is reused.",
    },
    reset: {
      type: "boolean",
      description: "When true, ignore any saved session state for this session_key and start a fresh send-money flow.",
    },
  },
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
  const imagePath = input.image_path?.trim();
  const sessionKey = input.session_key?.trim();

  if (!text && !imagePath) {
    throw new Error("send_money_turn requires either text or image_path.");
  }

  return runTransferTurn({
    ...(text ? { text } : {}),
    ...(imagePath ? { imagePath } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    reset: input.reset,
    deps,
  });
}
