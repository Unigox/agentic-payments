#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  runSendMoneyToolTurn,
  SEND_MONEY_TOOL_DESCRIPTION,
  SEND_MONEY_TOOL_NAME,
} from "./send-money-tool.ts";
import type { SendMoneyToolInput } from "./send-money-tool.ts";
import type { TransferFlowDeps, TransferFlowResult } from "./transfer-orchestrator.ts";

export const SEND_MONEY_MCP_SERVER_NAME = "agentic-payments-local";
export const SEND_MONEY_MCP_SERVER_VERSION = "1.0.0";

export const START_SEND_MONEY_TOOL_NAME = "start_send_money";
export const SIGN_IN_UNIGOX_TOOL_NAME = "sign_in_unigox";
export const CREATE_WALLET_TOOL_NAME = "create_wallet";
export const CHECK_KYC_TOOL_NAME = "check_kyc";
export const SAVE_PAYMENT_DETAILS_TOOL_NAME = "save_payment_details";
export const EXPORT_WALLET_TOOL_NAME = "export_wallet";

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

const imagePathShape = z
  .string()
  .min(1, "image_path must not be empty")
  .optional()
  .describe("Optional absolute local path to a fresh TonConnect or WalletConnect QR screenshot from the UNIGOX browser.");

export const sendMoneyMcpInputShape = {
  text: z
    .string()
    .min(1, "text must not be empty")
    .optional()
    .describe("The latest user message for the send-money flow."),
  image_path: imagePathShape,
  session_key: sessionKeyShape,
  reset: resetShape,
};

export const startSendMoneyMcpInputShape = {
  text: textShape.describe("Optional send-money request. If omitted, start the flow with a generic 'I want to send money' turn."),
  session_key: sessionKeyShape,
  reset: resetShape,
};

export const signInUnigoxMcpInputShape = {
  text: textShape.describe("Optional auth instruction such as choosing EVM, TON, email OTP, or pasting a signing key."),
  image_path: imagePathShape,
  session_key: sessionKeyShape,
  reset: resetShape,
};

export const createWalletMcpInputShape = {
  wallet_type: z
    .enum(["evm", "ton"])
    .describe("Which dedicated wallet to create locally on this device for UNIGOX sign-in."),
  text: textShape.describe("Optional wallet-creation instruction. If omitted, a dedicated wallet request is synthesized from wallet_type."),
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

export const exportWalletMcpInputShape = {
  wallet_type: z
    .enum(["evm", "ton"])
    .optional()
    .describe("Optional explicit generated wallet type to export. Omit this to export the currently active generated login wallet."),
  text: textShape.describe("Optional generated-wallet export instruction. If omitted, a default local wallet-export request is synthesized."),
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
    description: "Start or continue a UNIGOX send-money flow. Use for natural requests like 'I want to send money', recipient/amount follow-ups, payment-method changes, top-up continuation, or confirmation steps.",
  },
  {
    name: SIGN_IN_UNIGOX_TOOL_NAME,
    title: "Sign In to UNIGOX",
    description: "Guide UNIGOX sign-in and auth setup. Use for EVM wallet connection, TON wallet connection, email OTP, EVM WalletConnect QR or wc: browser-login approval, TON TonConnect QR or tc:// browser-login approval, and exported signing-key setup.",
  },
  {
    name: CREATE_WALLET_TOOL_NAME,
    title: "Create Dedicated Wallet",
    description: "Create a dedicated local EVM or TON wallet on this device for UNIGOX sign-in. This is the beginner-friendly path when the user does not want to provide an existing wallet key.",
  },
  {
    name: CHECK_KYC_TOOL_NAME,
    title: "Check or Start KYC",
    description: "Answer KYC questions and continue the KYC flow. Use for prompts like 'Do I need to do KYC?', 'Can I do KYC earlier?', 'I wanna do KYC on the platform', or 'Give me the KYC link'.",
  },
  {
    name: SAVE_PAYMENT_DETAILS_TOOL_NAME,
    title: "Save Payment Details",
    description: "Save or update recipient payout details for later use. Use for adding a recipient, saving payment details, or updating a saved payout route without immediately placing a transfer.",
  },
  {
    name: EXPORT_WALLET_TOOL_NAME,
    title: "Export Generated Wallet",
    description: "Export a locally generated EVM or TON login wallet into a local file so the owner can keep using that wallet elsewhere. Use for prompts like 'export this wallet', 'export the wallet you created for me', 'backup my generated wallet', 'export my EVM wallet', or 'send me the wallet file'.",
  },
];

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function buildBaseToolInput(input: {
  text?: string;
  image_path?: string;
  session_key?: string;
  reset?: boolean;
}, fallbackText?: string): SendMoneyToolInput {
  const text = trimmed(input.text) || fallbackText;
  const imagePath = trimmed(input.image_path);
  const sessionKey = trimmed(input.session_key);

  return {
    ...(text ? { text } : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(sessionKey ? { session_key: sessionKey } : {}),
    ...(typeof input.reset === "boolean" ? { reset: input.reset } : {}),
  };
}

function buildCreateWalletFallback(walletType: "evm" | "ton"): string {
  return walletType === "evm"
    ? "Create dedicated EVM wallet"
    : "Create dedicated TON wallet";
}

function buildKycFallback(action: "status" | "start" | "link" | undefined): string {
  switch (action) {
    case "start":
      return "I wanna do KYC on the platform";
    case "link":
      return "Give me the KYC link";
    case "status":
    default:
      return "Do I need to do KYC?";
  }
}

function buildExportWalletFallback(walletType: "evm" | "ton" | undefined): string {
  if (walletType === "evm") return "Export my generated EVM wallet";
  if (walletType === "ton") return "Export my generated TON wallet";
  return "Export this wallet";
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

export function formatSendMoneyMcpResult(result: TransferFlowResult): string {
  const reply = result.reply?.trim() || "No reply returned.";
  const options = Array.isArray(result.options)
    ? result.options.filter((value) => typeof value === "string" && value.trim())
    : [];

  if (!options.length) {
    return reply;
  }

  return `${reply}\n\nOptions:\n${options.map((option) => `- ${option}`).join("\n")}`;
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

  const signInTool = ANTHROPIC_MCP_TOOL_DESCRIPTORS.find((tool) => tool.name === SIGN_IN_UNIGOX_TOOL_NAME)!;
  server.registerTool(
    signInTool.name,
    {
      title: signInTool.title,
      description: signInTool.description,
      inputSchema: signInUnigoxMcpInputShape,
    },
    async (input) => runAndFormat(
      buildBaseToolInput(
        {
          ...input,
          reset: shouldResetForFreshStart(input.text, input.reset, input.session_key),
        },
        "I need to sign in to UNIGOX."
      ),
      deps
    )
  );

  const createWalletTool = ANTHROPIC_MCP_TOOL_DESCRIPTORS.find((tool) => tool.name === CREATE_WALLET_TOOL_NAME)!;
  server.registerTool(
    createWalletTool.name,
    {
      title: createWalletTool.title,
      description: createWalletTool.description,
      inputSchema: createWalletMcpInputShape,
    },
    async (input) => runAndFormat(
      buildBaseToolInput(input, buildCreateWalletFallback(input.wallet_type)),
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

  const exportWalletTool = ANTHROPIC_MCP_TOOL_DESCRIPTORS.find((tool) => tool.name === EXPORT_WALLET_TOOL_NAME)!;
  server.registerTool(
    exportWalletTool.name,
    {
      title: exportWalletTool.title,
      description: exportWalletTool.description,
      inputSchema: exportWalletMcpInputShape,
    },
    async (input) => runAndFormat(
      buildBaseToolInput(input, buildExportWalletFallback(input.wallet_type)),
      deps
    )
  );
}
