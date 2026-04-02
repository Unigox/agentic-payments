#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import test from "node:test";

import { SEND_MONEY_TOOL_NAME } from "./send-money-tool.ts";
import {
  formatSendMoneyMcpResult,
  sendMoneyMcpInputShape,
} from "./send-money-mcp.ts";

test("send_money MCP input schema requires text and session_key", () => {
  assert.equal(sendMoneyMcpInputShape.text.parse("send 50 EUR").trim(), "send 50 EUR");
  assert.equal(sendMoneyMcpInputShape.session_key.parse("claude-test"), "claude-test");
  assert.equal(sendMoneyMcpInputShape.reset.parse(true), true);
  assert.equal(SEND_MONEY_TOOL_NAME, "send_money_turn");
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
