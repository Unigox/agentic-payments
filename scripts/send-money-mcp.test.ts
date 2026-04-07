#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ANTHROPIC_MCP_TOOL_DESCRIPTORS,
  createWalletMcpInputShape,
  CHECK_KYC_TOOL_NAME,
  EXPORT_WALLET_TOOL_NAME,
  SAVE_PAYMENT_DETAILS_TOOL_NAME,
  sendMoneyMcpInputShape,
  signInUnigoxMcpInputShape,
  START_SEND_MONEY_TOOL_NAME,
  startSendMoneyMcpInputShape,
  checkKycMcpInputShape,
  SIGN_IN_UNIGOX_TOOL_NAME,
  CREATE_WALLET_TOOL_NAME,
  formatSendMoneyMcpResult,
  exportWalletMcpInputShape,
  savePaymentDetailsMcpInputShape,
  shouldResetForFreshStart,
} from "./send-money-mcp.ts";
import { SEND_MONEY_TOOL_NAME } from "./send-money-tool.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

test("send_money MCP input schema accepts text or image_path and optional session_key", () => {
  assert.equal(sendMoneyMcpInputShape.text.parse("send 50 EUR").trim(), "send 50 EUR");
  assert.equal(sendMoneyMcpInputShape.image_path.parse("/tmp/unigox-qr.png"), "/tmp/unigox-qr.png");
  assert.equal(sendMoneyMcpInputShape.session_key.parse("claude-test"), "claude-test");
  assert.equal(sendMoneyMcpInputShape.session_key.safeParse(undefined).success, true);
  assert.equal(sendMoneyMcpInputShape.reset.parse(true), true);
  assert.equal(SEND_MONEY_TOOL_NAME, "send_money_turn");
});

test("Anthropic alias tool schemas accept the expected inputs", () => {
  assert.equal(startSendMoneyMcpInputShape.text.parse("I want to send money").trim(), "I want to send money");
  assert.equal(signInUnigoxMcpInputShape.image_path.parse("/tmp/qr.png"), "/tmp/qr.png");
  assert.equal(createWalletMcpInputShape.wallet_type.parse("ton"), "ton");
  assert.equal(checkKycMcpInputShape.action.parse("link"), "link");
  assert.equal(savePaymentDetailsMcpInputShape.text.parse("Save Aleksandr for later").trim(), "Save Aleksandr for later");
  assert.equal(exportWalletMcpInputShape.wallet_type.parse("evm"), "evm");
  assert.equal(START_SEND_MONEY_TOOL_NAME, "start_send_money");
  assert.equal(SIGN_IN_UNIGOX_TOOL_NAME, "sign_in_unigox");
  assert.equal(CREATE_WALLET_TOOL_NAME, "create_wallet");
  assert.equal(CHECK_KYC_TOOL_NAME, "check_kyc");
  assert.equal(SAVE_PAYMENT_DETAILS_TOOL_NAME, "save_payment_details");
  assert.equal(EXPORT_WALLET_TOOL_NAME, "export_wallet");
});

test("fresh Claude start phrasing resets the default local session when no session_key is provided", () => {
  assert.equal(shouldResetForFreshStart("/agentic-payments lets start", undefined, undefined), true);
  assert.equal(shouldResetForFreshStart("I want to send money using Agentic Payments.", undefined, undefined), true);
  assert.equal(shouldResetForFreshStart("kick off Agentic Payments", undefined, undefined), true);
  assert.equal(shouldResetForFreshStart("continue my UNIGOX payment", undefined, undefined), undefined);
  assert.equal(shouldResetForFreshStart("/agentic-payments lets start", undefined, "chat-123"), undefined);
  assert.equal(shouldResetForFreshStart("/agentic-payments lets start", false, undefined), false);
});

test("send_money MCP result formatter includes quick-reply options when available", () => {
  const formatted = formatSendMoneyMcpResult({
    reply: "Should I use that saved recipient?",
    options: ["yes", "no"],
    status: "active",
    events: [],
  });

  assert.match(formatted, /Should I use that saved recipient\?/i);
  assert.match(formatted, /Options:/i);
  assert.match(formatted, /- yes/i);
  assert.match(formatted, /- no/i);
});

test("Anthropic manifest tool list stays aligned with the registered MCP tools", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "adapters", "anthropic", "manifest.json"), "utf-8"));
  const manifestNames = manifest.tools.map((tool: { name: string }) => tool.name);
  const registeredNames = ANTHROPIC_MCP_TOOL_DESCRIPTORS.map((tool) => tool.name);

  assert.deepEqual(manifestNames, registeredNames);
});
