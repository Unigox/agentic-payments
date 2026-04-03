#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  runSendMoneyToolTurn,
  SEND_MONEY_TOOL_DESCRIPTION,
  SEND_MONEY_TOOL_NAME,
} from "./send-money-tool.ts";
import type { TransferFlowDeps, TransferFlowResult } from "./transfer-orchestrator.ts";

export const SEND_MONEY_MCP_SERVER_NAME = "agentic-payments-local";
export const SEND_MONEY_MCP_SERVER_VERSION = "1.0.0";

export const sendMoneyMcpInputShape = {
  text: z
    .string()
    .min(1, "text must not be empty")
    .optional()
    .describe("The latest user message for the send-money flow."),
  image_path: z
    .string()
    .min(1, "image_path must not be empty")
    .optional()
    .describe("Optional absolute local path to a fresh TonConnect QR screenshot from the UNIGOX browser."),
  session_key: z
    .string()
    .min(1, "session_key is required")
    .describe("Stable per-chat or per-user key reused across turns."),
  reset: z
    .boolean()
    .optional()
    .describe("When true, ignore saved session state and start a fresh flow."),
};

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

export function registerSendMoneyMcpTool(server: McpServer, deps?: TransferFlowDeps) {
  server.registerTool(
    SEND_MONEY_TOOL_NAME,
    {
      title: "UNIGOX Send Money",
      description: SEND_MONEY_TOOL_DESCRIPTION,
      inputSchema: sendMoneyMcpInputShape,
    },
    async (input) => {
      const result = await runSendMoneyToolTurn(input, deps);

      return {
        content: [
          {
            type: "text" as const,
            text: formatSendMoneyMcpResult(result),
          },
        ],
        structuredContent: result,
      };
    }
  );
}
