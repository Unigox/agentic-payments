#!/usr/bin/env -S node --experimental-strip-types
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  advanceTransferFlow,
  startTransferFlow,
  type TransferFlowDeps,
  type TransferFlowResult,
  type TransferSession,
} from "./transfer-orchestrator.ts";
import { UnigoxClient } from "./unigox-client.ts";
import {
  checkTonConnectSession,
  clearTonConnectSession,
  startTonConnectSession,
} from "./tonconnect-session.ts";
import { decodeTonConnectUniversalLinkFromImagePath } from "./qr-decode.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.join(__dirname, "..");
const DEFAULT_STATE_DIR = path.join(SKILL_DIR, "workflows", "sessions");
const DEFAULT_TONCONNECT_STATE_DIR = path.join(SKILL_DIR, "workflows", "tonconnect");
const DEFAULT_ENV_PATH = path.join(SKILL_DIR, ".env");

export interface TransferRunnerOptions {
  text?: string;
  imagePath?: string;
  sessionKey?: string;
  stateDir?: string;
  deps?: TransferFlowDeps;
  reset?: boolean;
}

interface ParsedCliArgs {
  text?: string;
  textFile?: string;
  imagePath?: string;
  sessionKey?: string;
  stateDir?: string;
  json?: boolean;
  reset?: boolean;
}

function parseArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--text":
        parsed.text = argv[i + 1] || "";
        i += 1;
        break;
      case "--text-file":
        parsed.textFile = argv[i + 1] || "";
        i += 1;
        break;
      case "--image-path":
        parsed.imagePath = argv[i + 1] || "";
        i += 1;
        break;
      case "--session-key":
        parsed.sessionKey = argv[i + 1] || "";
        i += 1;
        break;
      case "--state-dir":
        parsed.stateDir = argv[i + 1] || "";
        i += 1;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--reset":
        parsed.reset = true;
        break;
      default:
        break;
    }
  }
  return parsed;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "default";
}

export function resolveRunnerSessionKey(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  const raw = explicit
    || env.SEND_MONEY_SESSION_ID
    || env.OPENCLAW_SESSION_ID
    || env.OPENCLAW_AGENT_ID
    || env.AGENT_ID
    || env.USER
    || "default";
  return slugify(raw);
}

function ensureStateDir(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
}

function resolveEnvFilePath(): string {
  return process.env.SEND_MONEY_ENV_PATH || DEFAULT_ENV_PATH;
}

function upsertEnvAssignments(filePath: string, assignments: Record<string, string>): void {
  const nextKeys = new Set(Object.keys(assignments));
  const existingLines = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8").split(/\r?\n/)
    : [];
  const nextLines = existingLines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    const key = match?.[1];
    if (!key || !nextKeys.has(key)) return line;
    nextKeys.delete(key);
    return `${key}=${assignments[key]}`;
  });

  for (const key of nextKeys) {
    nextLines.push(`${key}=${assignments[key]}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = nextLines.filter((line, index, all) => line.length > 0 || index < all.length - 1).join("\n").replace(/\n*$/, "\n");
  fs.writeFileSync(filePath, body);

  for (const [key, value] of Object.entries(assignments)) {
    process.env[key] = value;
  }
}

function resolveFrontendUrl(): string | undefined {
  return process.env.UNIGOX_FRONTEND_URL || process.env.NEXT_PUBLIC_UNIGOX_FRONTEND_URL;
}

function buildTonConnectClient(): UnigoxClient {
  const frontendUrl = resolveFrontendUrl();
  return new UnigoxClient(frontendUrl ? { frontendUrl } : {});
}

function buildDefaultRunnerDeps(sessionKey: string): TransferFlowDeps {
  const envPath = resolveEnvFilePath();
  const frontendUrl = resolveFrontendUrl();
  return {
    persistEvmLoginKey: async (loginKey) => {
      upsertEnvAssignments(envPath, {
        UNIGOX_EVM_LOGIN_PRIVATE_KEY: loginKey,
      });
    },
    persistEvmSigningKey: async (signingKey) => {
      upsertEnvAssignments(envPath, {
        UNIGOX_EVM_SIGNING_PRIVATE_KEY: signingKey,
      });
    },
    persistTonPrivateKey: async (tonPrivateKey) => {
      upsertEnvAssignments(envPath, {
        UNIGOX_AUTH_MODE: "ton",
        UNIGOX_TON_PRIVATE_KEY: tonPrivateKey,
        UNIGOX_TON_NETWORK: process.env.UNIGOX_TON_NETWORK || "-239",
      });
    },
    persistTonMnemonic: async (mnemonic) => {
      upsertEnvAssignments(envPath, {
        UNIGOX_AUTH_MODE: "ton",
        UNIGOX_TON_MNEMONIC: mnemonic,
        UNIGOX_TON_NETWORK: process.env.UNIGOX_TON_NETWORK || "-239",
      });
    },
    persistTonAddress: async (tonAddress) => {
      upsertEnvAssignments(envPath, {
        UNIGOX_AUTH_MODE: "ton",
        UNIGOX_TON_ADDRESS: tonAddress,
        UNIGOX_TON_NETWORK: process.env.UNIGOX_TON_NETWORK || "-239",
      });
    },
    persistTonWalletVersion: async (tonWalletVersion) => {
      upsertEnvAssignments(envPath, {
        UNIGOX_AUTH_MODE: "ton",
        UNIGOX_TON_WALLET_VERSION: tonWalletVersion,
        UNIGOX_TON_NETWORK: process.env.UNIGOX_TON_NETWORK || "-239",
      });
    },
    startTonConnectLogin: async () => {
      const client = buildTonConnectClient();
      const { payloadToken, payloadTokenHash } = await client.createTonLoginPayloadTokenPair();
      const started = await startTonConnectSession({
        sessionKey,
        tonProof: payloadTokenHash,
        ...(frontendUrl ? { frontendUrl } : {}),
        stateDir: DEFAULT_TONCONNECT_STATE_DIR,
      });
      return {
        ...started,
        payloadToken,
      };
    },
    checkTonConnectLogin: async () => checkTonConnectSession({
      sessionKey,
      ...(frontendUrl ? { frontendUrl } : {}),
      stateDir: DEFAULT_TONCONNECT_STATE_DIR,
    }),
    clearTonConnectLogin: async () => clearTonConnectSession({
      sessionKey,
      ...(frontendUrl ? { frontendUrl } : {}),
      stateDir: DEFAULT_TONCONNECT_STATE_DIR,
    }),
    approveTonConnectLink: async (universalLink) => {
      const client = buildTonConnectClient();
      return client.approveTonConnectBrowserLogin(universalLink);
    },
    decodeTonConnectQr: async (imagePath) => decodeTonConnectUniversalLinkFromImagePath(imagePath),
  };
}

export function resolveSessionStatePath(sessionKey: string, stateDir = DEFAULT_STATE_DIR): string {
  return path.join(stateDir, `${slugify(sessionKey)}.json`);
}

export function loadSessionState(filePath: string): TransferSession | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TransferSession;
  } catch {
    return undefined;
  }
}

export function saveSessionState(filePath: string, session: TransferSession): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n");
}

function looksLikeNewTransferTurn(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return [
    /\bi wanna send money\b/,
    /\bsend money to\b/,
    /\btransfer to\b/,
    /\bpay\b/,
    /\bsend\s+[\d€$]/,
  ].some((pattern) => pattern.test(normalized));
}

function shouldStartFreshSession(session: TransferSession | undefined, text: string, reset = false): boolean {
  if (reset || !session) return true;
  if (session.status === "completed" || session.status === "cancelled") return true;
  if (!looksLikeNewTransferTurn(text)) return false;

  const stickyStages = new Set<TransferSession["stage"]>([
    "awaiting_confirmation",
    "awaiting_new_price_confirmation",
    "awaiting_receipt_confirmation",
    "awaiting_release_completion",
  ]);

  return !stickyStages.has(session.stage);
}

function shouldDeleteSessionState(session: TransferSession): boolean {
  return session.status === "completed" || session.status === "cancelled";
}

export function formatTransferRunnerOutput(result: TransferFlowResult): string {
  let output = result.reply.trim();
  if (result.options?.length) {
    output += `\n\n${result.options.map((option) => `• ${option}`).join("\n")}`;
  }
  return output;
}

export async function runTransferTurn(options: TransferRunnerOptions): Promise<TransferFlowResult> {
  const sessionKey = resolveRunnerSessionKey(process.env, options.sessionKey);
  const stateDir = options.stateDir || DEFAULT_STATE_DIR;
  ensureStateDir(stateDir);
  const statePath = resolveSessionStatePath(sessionKey, stateDir);
  const existingSession = options.reset ? undefined : loadSessionState(statePath);
  const text = options.text?.trim();
  const imagePath = options.imagePath?.trim();
  const turn = {
    ...(text ? { text } : {}),
    ...(imagePath ? { imagePath } : {}),
  };
  const startFresh = shouldStartFreshSession(existingSession, text || "", options.reset);

  const deps: TransferFlowDeps = {
    ...buildDefaultRunnerDeps(sessionKey),
    ...(options.deps || {}),
  };
  const result = startFresh
    ? await startTransferFlow(turn, deps)
    : await advanceTransferFlow(existingSession!, turn, deps);

  if (shouldDeleteSessionState(result.session)) {
    fs.rmSync(statePath, { force: true });
  } else {
    saveSessionState(statePath, result.session);
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stdinText = await readStdin();
  const text = (args.textFile
    ? fs.readFileSync(args.textFile, "utf-8")
    : args.text) || stdinText;
  const imagePath = args.imagePath?.trim();

  if (!text?.trim() && !imagePath) {
    console.error("send-money runner requires turn text via --text, --text-file, or stdin, or a local QR screenshot via --image-path.");
    process.exitCode = 1;
    return;
  }

  const result = await runTransferTurn({
    ...(text?.trim() ? { text: text.trim() } : {}),
    ...(imagePath ? { imagePath } : {}),
    sessionKey: args.sessionKey,
    stateDir: args.stateDir,
    reset: args.reset,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatTransferRunnerOutput(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
