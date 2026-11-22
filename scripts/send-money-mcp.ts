#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  runSendMoneyToolTurn,
  SEND_MONEY_TOOL_DESCRIPTION,
  SEND_MONEY_TOOL_NAME,
} from "./send-money-tool.ts";
import type { SendMoneyToolInput } from "./send-money-tool.ts";
import type { TransferFlowDeps, TransferFlowResult, TransferSession, TransferStage } from "./transfer-orchestrator.ts";

export const SEND_MONEY_MCP_SERVER_NAME = "agentic-payments-local";
export const SEND_MONEY_MCP_SERVER_VERSION = "1.0.0";

export const START_SEND_MONEY_TOOL_NAME = "start_send_money";
export const CHECK_KYC_TOOL_NAME = "check_kyc";
export const SAVE_PAYMENT_DETAILS_TOOL_NAME = "save_payment_details";

const sessionKeyShape = z
  .string()
  .min(1, "session_key must not be empty")
  .describe("Optional stable per-chat or per-user key reused across turns. If omitted, the local default conversation state is reused.")
  .optional();

const resetShape = z
  .boolean()
  .optional()
  .describe("When true, ignore saved session state and start a fresh flow.");

const textShape = z
  .string()
  .min(1, "text must not be empty")
  .optional()
  .describe("Optional natural-language instruction for this flow.");

export const sendMoneyMcpInputShape = {
  text: z
    .string()
    .min(1, "text must not be empty")
    .optional()
    .describe("The latest user message for the send-money flow."),
  session_key: sessionKeyShape,
  reset: resetShape,
};

export const startSendMoneyMcpInputShape = {
  text: textShape.describe("Optional send-money request. If omitted, start the flow with a generic 'I want to send money' turn."),
  session_key: sessionKeyShape,
  reset: resetShape,
};

export const checkKycMcpInputShape = {
  action: z
    .enum(["status", "start", "link"])
    .optional()
    .describe("Optional KYC action. 'status' asks whether KYC is needed, 'start' begins KYC, and 'link' asks for the live verification link."),
  text: textShape.describe("Optional KYC question or instruction. If omitted, a default KYC prompt is synthesized from action."),
  session_key: sessionKeyShape,
  reset: resetShape,
};

export const savePaymentDetailsMcpInputShape = {
  text: textShape.describe("Optional saved-recipient or payout-details instruction. If omitted, start from a generic 'save recipient for later' turn."),
  session_key: sessionKeyShape,
  reset: resetShape,
};

export interface AnthropicMcpToolDescriptor {
  name: string;
  title: string;
  description: string;
}

export const ANTHROPIC_MCP_TOOL_DESCRIPTORS: AnthropicMcpToolDescriptor[] = [
  {
    name: SEND_MONEY_TOOL_NAME,
    title: "UNIGOX Send Money",
    description: SEND_MONEY_TOOL_DESCRIPTION,
  },
  {
    name: START_SEND_MONEY_TOOL_NAME,
    title: "Start Send Money",
    description: "Start or continue a UNIGOX send-money flow. Use for natural requests like 'I want to send money', recipient/amount follow-ups, payment-method changes, balance rechecks, or confirmation steps.",
  },
  {
    name: CHECK_KYC_TOOL_NAME,
    title: "Check or Start KYC",
    description: "Answer KYC questions and continue the KYC flow. UNIGOX requires the sender's identity to be verified before every transfer. Use for prompts like 'Do I need to do KYC?', 'I want to do KYC now', or 'Give me the KYC link'.",
  },
  {
    name: SAVE_PAYMENT_DETAILS_TOOL_NAME,
    title: "Save Payment Details",
    description: "Save or update recipient payout details for later use. Use for adding a recipient, saving payment details, or updating a saved payout route without immediately placing a transfer.",
  },
];

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function buildBaseToolInput(input: {
  text?: string;
  session_key?: string;
  reset?: boolean;
}, fallbackText?: string): SendMoneyToolInput {
  const text = trimmed(input.text) || fallbackText;
  const sessionKey = trimmed(input.session_key);

  return {
    ...(text ? { text } : {}),
    ...(sessionKey ? { session_key: sessionKey } : {}),
    ...(typeof input.reset === "boolean" ? { reset: input.reset } : {}),
  };
}

function buildKycFallback(action: "status" | "start" | "link" | undefined): string {
  switch (action) {
    case "start":
      return "I want to do KYC now";
    case "link":
      return "Give me the KYC link";
    case "status":
    default:
      return "Do I need to do KYC?";
  }
}

export function shouldResetForFreshStart(text: string | undefined, reset: boolean | undefined, sessionKey: string | undefined): boolean | undefined {
  if (typeof reset === "boolean") return reset;
  if (sessionKey) return undefined;

  const value = trimmed(text)?.toLowerCase();
  if (!value) return true;

  const freshStartPatterns = [
    /^\/agentic-payments(?:\s|$)/,
    /\blet'?s start\b/,
    /\bstart\b/,
    /\bstart over\b/,
    /\bnew payment\b/,
    /\bnew transfer\b/,
    /\bbegin\b/,
    /\bkick off\b/,
    /\bi want to send money\b/,
    /\buse agentic payments\b/,
  ];

  return freshStartPatterns.some((pattern) => pattern.test(value)) ? true : undefined;
}

/**
 * Tells the agent, in one line, what to do with the reply for a given stage.
 *
 * @param stage The session's stage after this turn.
 * @returns A short instruction for the agent; a generic one for stages without special handling.
 */
function describeNextAction(stage: TransferStage): string {
  switch (stage) {
    case "awaiting_setup":
      return "Tell the user the skill needs its UNIGOX settings configured; do not ask for keys in chat";
    case "awaiting_recipient_name":
    case "awaiting_recipient_mode":
      return "Ask user for recipient name";
    case "awaiting_saved_recipient_confirmation":
      return "Ask user to confirm the matched recipient";
    case "awaiting_currency":
      return "Ask user which currency to send";
    case "awaiting_amount":
      return "Ask user for the amount";
    case "awaiting_payment_method":
    case "awaiting_payment_network":
    case "awaiting_payment_details":
      return "Collect payment method or payout details from options";
    case "awaiting_confirmation":
      return "Ask user to confirm the transfer";
    case "awaiting_receipt_confirmation":
      return "Ask user to confirm they received payment";
    case "awaiting_kyc_full_name":
      return "Ask user for their full legal name for KYC";
    case "awaiting_kyc_country":
      return "Ask user for their country for KYC";
    case "awaiting_kyc_completion":
      return "Waiting for KYC verification to complete";
    case "awaiting_balance_resolution":
      return "Ask user to fund the partner wallet on unigox.com or change the amount";
    case "awaiting_new_price_confirmation":
      return "Ask user to confirm or cancel the updated price";
    default:
      return "Follow the reply below";
  }
}

function buildStateBlock(session: TransferSession): string {
  const { auth, stage, goal } = session;
  const lines: string[] = [];

  lines.push("=== SESSION STATE (relay the reply below — do not paraphrase or add steps) ===");

  if (auth.username) lines.push(`sender: ${auth.username}`);

  lines.push(`stage: ${stage}`);
  if (goal && goal !== "transfer") lines.push(`goal: ${goal}`);
  lines.push(`next: ${describeNextAction(stage)}`);

  lines.push("===");

  return lines.join("\n");
}

export function formatSendMoneyMcpResult(result: TransferFlowResult): string {
  const reply = result.reply?.trim() || "No reply returned.";
  const options = Array.isArray(result.options)
    ? result.options.filter((value) => typeof value === "string" && value.trim())
    : [];

  const session = result.session;
  const stateBlock = session ? buildStateBlock(session) : undefined;

  let body = reply;
  if (options.length) {
    body += `\n\nOptions:\n${options.map((option) => `- ${option}`).join("\n")}`;
  }

  return stateBlock ? `${stateBlock}\n\n${body}` : body;
}

async function runAndFormat(input: SendMoneyToolInput, deps?: TransferFlowDeps) {
  const result = await runSendMoneyToolTurn(input, deps);
  return {
    content: [
      {
        type: "text" as const,
        text: formatSendMoneyMcpResult(result),
      },
    ],
  };
}

export function registerSendMoneyMcpTool(server: McpServer, deps?: TransferFlowDeps) {
  const canonical = ANTHROPIC_MCP_TOOL_DESCRIPTORS.find((tool) => tool.name === SEND_MONEY_TOOL_NAME)!;
  server.registerTool(
    canonical.name,
    {
      title: canonical.title,
      description: canonical.description,
      inputSchema: sendMoneyMcpInputShape,
    },
    async (input) => runAndFormat(
      buildBaseToolInput({
        ...input,
        reset: shouldResetForFreshStart(input.text, input.reset, input.session_key),
      }),
      deps
    )
  );

  const startTool = ANTHROPIC_MCP_TOOL_DESCRIPTORS.find((tool) => tool.name === START_SEND_MONEY_TOOL_NAME)!;
  server.registerTool(
    startTool.name,
    {
      title: startTool.title,
      description: startTool.description,
      inputSchema: startSendMoneyMcpInputShape,
    },
    async (input) => runAndFormat(
      buildBaseToolInput(
        {
          ...input,
          reset: shouldResetForFreshStart(input.text, input.reset, input.session_key),
        },
        "I want to send money."
      ),
      deps
    )
  );

  const checkKycTool = ANTHROPIC_MCP_TOOL_DESCRIPTORS.find((tool) => tool.name === CHECK_KYC_TOOL_NAME)!;
  server.registerTool(
    checkKycTool.name,
    {
      title: checkKycTool.title,
      description: checkKycTool.description,
      inputSchema: checkKycMcpInputShape,
    },
    async (input) => runAndFormat(
      buildBaseToolInput(input, buildKycFallback(input.action)),
      deps
    )
  );

  const saveDetailsTool = ANTHROPIC_MCP_TOOL_DESCRIPTORS.find((tool) => tool.name === SAVE_PAYMENT_DETAILS_TOOL_NAME)!;
  server.registerTool(
    saveDetailsTool.name,
    {
      title: saveDetailsTool.title,
      description: saveDetailsTool.description,
      inputSchema: savePaymentDetailsMcpInputShape,
    },
    async (input) => runAndFormat(
      buildBaseToolInput(input, "I want to save a recipient for later."),
      deps
    )
  );

}
