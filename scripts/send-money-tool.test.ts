#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildAnthropicToolDefinition,
  buildOpenAIToolDefinition,
  runSendMoneyToolTurn,
  SEND_MONEY_TOOL_INPUT_SCHEMA,
  SEND_MONEY_TOOL_NAME,
} from "./send-money-tool.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

test("send_money_turn tool schema stays stable for OpenAI", () => {
  const definition = buildOpenAIToolDefinition();
  const json = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "adapters", "openai", "send-money-tool.json"), "utf-8"));

  assert.equal(definition.type, "function");
  assert.equal(definition.name, SEND_MONEY_TOOL_NAME);
  assert.deepEqual(definition.parameters, SEND_MONEY_TOOL_INPUT_SCHEMA);
  assert.deepEqual(json, definition);
});

test("send_money_turn tool schema stays stable for Anthropic", () => {
  const definition = buildAnthropicToolDefinition();
  const json = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "adapters", "anthropic", "send-money-tool.json"), "utf-8"));

  assert.equal(definition.name, SEND_MONEY_TOOL_NAME);
  assert.deepEqual(definition.input_schema, SEND_MONEY_TOOL_INPUT_SCHEMA);
  assert.deepEqual(json, definition);
});

test("runSendMoneyToolTurn requires a stable session_key", async () => {
  await assert.rejects(
    () => runSendMoneyToolTurn({ text: "send money to mom", session_key: "" }),
    /session_key/i
  );
});
