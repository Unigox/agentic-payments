/**
 * Configuration boundary for the Partner API.
 *
 * The one place that reads this skill's environment settings. It looks in the process environment
 * first, then in the skill's `.env` file, then in `~/.openclaw/.env`, and hands typed values to the
 * rest of the code. Each setting is documented here and in `.env.example`.
 */

import fs from "fs";
import path from "path";

import { SKILL_DIR } from "./contact-store.ts";
import type { PartnerApiConfig } from "./partner-api-client.ts";

/**
 * Documented production host of the Partner API, used when `UNIGOX_API_URL` is not set.
 * Source: https://developers.unigox.com/basics/authentication ("Production: https://api.unigox.com").
 */
export const PARTNER_API_PRODUCTION_URL = "https://api.unigox.com";

/**
 * Environment settings this skill reads.
 *
 * - `UNIGOX_API_KEY` (required to send): partner API key, sent as `X-API-Key`. Issued after business
 *   onboarding at unigox.com/business. Without it no transfer can be placed.
 * - `UNIGOX_WALLET_PRIVATE_KEY` (required to send): 0x-prefixed private key of the partner wallet.
 *   Signs escrow funding and refunds locally. Without it no transfer can be funded.
 * - `UNIGOX_XAI_RPC_URL` (required to send): JSON-RPC URL of an XAI mainnet node, used only to read
 *   the partner wallet's USDC and USDT balance before a transfer is offered for confirmation.
 * - `UNIGOX_SENDER_EMAIL` (required to send): email of the one KYC-verified person this installation
 *   sends for. Registered with the API as the sender.
 * - `UNIGOX_API_URL` (optional): base URL of the API. Set it to the documented staging host to
 *   test; when absent the documented production host is used.
 */
const REQUIRED_SETTINGS = ["UNIGOX_API_KEY", "UNIGOX_WALLET_PRIVATE_KEY", "UNIGOX_XAI_RPC_URL", "UNIGOX_SENDER_EMAIL"] as const;

/** Result of reading the environment. Produced by `loadPartnerApiConfigFromEnv`, consumed by the orchestrator. */
export interface PartnerApiConfigResult {
  /** Base URL of the API. Always present, so public catalogue reads work before credentials exist. */
  apiUrl: string;
  /** Complete configuration, present only when every required setting has a value. */
  config?: PartnerApiConfig;
  /** Names of required settings that have no value. Empty when `config` is present. */
  missingSettings: string[];
}

/**
 * Reads the Partner API settings from the environment and the skill's `.env` files.
 *
 * @returns The API base URL, the complete configuration when all required settings are present,
 *   and the names of any that are missing. Never throws; unreadable `.env` files are skipped.
 */
export function loadPartnerApiConfigFromEnv(): PartnerApiConfigResult {
  const apiUrl = readSetting("UNIGOX_API_URL") ?? PARTNER_API_PRODUCTION_URL;
  const values = Object.fromEntries(REQUIRED_SETTINGS.map((name) => [name, readSetting(name)]));
  const missingSettings = REQUIRED_SETTINGS.filter((name) => !values[name]);
  if (missingSettings.length > 0) {
    return { apiUrl, missingSettings };
  }
  return {
    apiUrl,
    missingSettings: [],
    config: {
      apiUrl,
      apiKey: values.UNIGOX_API_KEY!,
      walletPrivateKey: values.UNIGOX_WALLET_PRIVATE_KEY!,
      xaiRpcUrl: values.UNIGOX_XAI_RPC_URL!,
      senderEmail: values.UNIGOX_SENDER_EMAIL!,
    },
  };
}

/**
 * Reads one setting from the process environment or the first `.env` file that defines it.
 *
 * @param name Setting name.
 * @returns The trimmed value, or `undefined` when the setting is absent or empty everywhere.
 */
function readSetting(name: string): string | undefined {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  for (const envPath of listEnvFiles()) {
    const fromFile = readSettingFromFile(envPath, name);
    if (fromFile) return fromFile;
  }
  return undefined;
}

/**
 * Lists the `.env` files to consult, in priority order.
 *
 * @returns Paths: the file named by `SEND_MONEY_ENV_PATH` when set, the skill's `.env`, then
 *   `~/.openclaw/.env`. Empty when `SEND_MONEY_DISABLE_ENV_FILE_LOOKUP` is `1` (used by tests).
 */
function listEnvFiles(): string[] {
  if (process.env.SEND_MONEY_DISABLE_ENV_FILE_LOOKUP === "1") return [];
  const candidates = [
    process.env.SEND_MONEY_ENV_PATH?.trim(),
    path.join(SKILL_DIR, ".env"),
    path.join(process.env.HOME || "", ".openclaw", ".env"),
  ];
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

/**
 * Reads one `NAME=value` line from a `.env` file.
 *
 * @param envPath File to read.
 * @param name Setting name.
 * @returns The trimmed value after `=`, or `undefined` when the file is missing, unreadable or does
 *   not define the setting.
 */
function readSettingFromFile(envPath: string, name: string): string | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(envPath, "utf-8");
  } catch {
    return undefined;
  }
  const line = contents.split("\n").find((entry) => entry.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim();
  return value || undefined;
}
