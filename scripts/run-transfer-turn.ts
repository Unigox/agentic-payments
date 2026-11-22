#!/usr/bin/env -S node --experimental-strip-types
/**
 * Command-line runner for one chat turn of the send-money flow.
 *
 * Loads the session saved for the caller, advances it with the turn's text, saves it again and
 * prints the reply. Each invocation is a separate process, so everything the flow needs between
 * turns lives in the session file.
 */
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.join(__dirname, "..");
const DEFAULT_STATE_DIR = path.join(SKILL_DIR, "workflows", "sessions");

/** Longest session key kept in a state file name, in characters. Keeps file names within common filesystem limits. */
const MAX_SESSION_KEY_LENGTH = 120;

/** One turn to run. Built by `main` from the command line or by a caller such as the MCP server. */
export interface TransferRunnerOptions {
  /** What the person said this turn. */
  text?: string;
  /** Identifies whose session to continue. Defaults to an id taken from the environment. */
  sessionKey?: string;
  /** Directory holding session files. Defaults to `workflows/sessions` in the skill. */
  stateDir?: string;
  /** Flow collaborators to use instead of the defaults; tests inject fakes here. */
  deps?: TransferFlowDeps;
  /** When true, any saved session is discarded and a new one starts. */
  reset?: boolean;
}

/** Command-line arguments as parsed by `parseArgs`. */
interface ParsedCliArgs {
  /** Value of `--text`. */
  text?: string;
  /** Value of `--text-file`: a file whose contents are the turn's text. */
  textFile?: string;
  /** Value of `--session-key`. */
  sessionKey?: string;
  /** Value of `--state-dir`. */
  stateDir?: string;
  /** True when `--json` was given: print the whole result as JSON. */
  json?: boolean;
  /** True when `--reset` was given. */
  reset?: boolean;
}

/**
 * Parses the runner's command-line flags.
 *
 * @param argv Arguments after the script name.
 * @returns The recognised flags. Unknown arguments are ignored.
 */
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

/**
 * Reads piped standard input.
 *
 * @returns The trimmed input, or `""` when the process is attached to a terminal.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/**
 * Turns an arbitrary id into a safe file-name fragment.
 *
 * @param value Any string.
 * @returns Lower-case letters, digits, `_` and `-` only, at most `MAX_SESSION_KEY_LENGTH` long;
 *   `default` when nothing usable remains.
 */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SESSION_KEY_LENGTH) || "default";
}

/**
 * Chooses the session key for this run.
 *
 * @param env Environment to read; defaults to the process environment.
 * @param explicit Key given by the caller, which wins over the environment.
 * @returns A file-safe key: the explicit one, else the first set of `SEND_MONEY_SESSION_ID`,
 *   `OPENCLAW_SESSION_ID`, `OPENCLAW_AGENT_ID`, `AGENT_ID`, `USER`, else `default`.
 */
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

/**
 * Locates a session's state file.
 *
 * @param sessionKey Session key.
 * @param stateDir Directory holding session files.
 * @returns Absolute or relative path of the JSON file for that session.
 */
export function resolveSessionStatePath(sessionKey: string, stateDir = DEFAULT_STATE_DIR): string {
  return path.join(stateDir, `${slugify(sessionKey)}.json`);
}

/**
 * Loads a saved session.
 *
 * @param filePath Session file.
 * @returns The session, or `undefined` when the file is missing or not valid JSON.
 */
export function loadSessionState(filePath: string): TransferSession | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TransferSession;
  } catch {
    return undefined;
  }
}

/**
 * Saves a session, creating its directory when needed.
 *
 * @param filePath Session file to write.
 * @param session Session to persist.
 */
export function saveSessionState(filePath: string, session: TransferSession): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n");
}

/**
 * Tells whether a turn reads like the start of a new transfer.
 *
 * @param text The turn's text.
 * @returns True for phrases such as "send money to", "transfer to", "pay" or "send 50".
 */
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

/**
 * Decides whether this turn starts a new session instead of continuing the saved one.
 *
 * @param session Saved session, if any.
 * @param text The turn's text.
 * @param reset True when the caller asked for a fresh session.
 * @returns True when there is no usable session, a reset was asked, or the text starts a new
 *   transfer while the saved session is not at a step where money or a confirmation is pending.
 */
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

/**
 * Formats a flow result for a plain-text chat surface.
 *
 * @param result Flow result.
 * @returns The reply, followed by its options as a bullet list when there are any.
 */
export function formatTransferRunnerOutput(result: TransferFlowResult): string {
  let output = result.reply.trim();
  if (result.options?.length) {
    output += `\n\n${result.options.map((option) => `• ${option}`).join("\n")}`;
  }
  return output;
}

/**
 * Runs one chat turn: loads the caller's session, advances the flow, and saves or clears the session.
 *
 * @param options The turn's text, session key, state directory, collaborators and reset flag.
 * @returns The flow's result for this turn. The session file is deleted once the session is
 *   completed or cancelled, and written otherwise.
 * @throws Whatever the flow throws; the session file is left as it was.
 */
export async function runTransferTurn(options: TransferRunnerOptions): Promise<TransferFlowResult> {
  const sessionKey = resolveRunnerSessionKey(process.env, options.sessionKey);
  const stateDir = options.stateDir || DEFAULT_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = resolveSessionStatePath(sessionKey, stateDir);
  const existingSession = options.reset ? undefined : loadSessionState(statePath);
  const text = options.text?.trim();
  const turn = text ? { text } : {};
  const startFresh = shouldStartFreshSession(existingSession, text || "", options.reset);

  const deps: TransferFlowDeps = options.deps || {};
  const result = startFresh
    ? await startTransferFlow(turn, deps)
    : await advanceTransferFlow(existingSession!, turn, deps);

  if (result.session.status === "completed" || result.session.status === "cancelled") {
    fs.rmSync(statePath, { force: true });
  } else {
    saveSessionState(statePath, result.session);
  }

  return result;
}

/**
 * Entry point: runs one turn from the command line and prints the reply.
 *
 * Reads the text from `--text`, `--text-file` or standard input. Prints the formatted reply, or the
 * whole result as JSON with `--json`. Sets a non-zero exit code when no text was given.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stdinText = await readStdin();
  const text = (args.textFile
    ? fs.readFileSync(args.textFile, "utf-8")
    : args.text) || stdinText;

  if (!text?.trim()) {
    console.error("send-money runner requires turn text via --text, --text-file, or stdin.");
    process.exitCode = 1;
    return;
  }

  const result = await runTransferTurn({
    text: text.trim(),
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
