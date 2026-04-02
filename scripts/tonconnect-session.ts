#!/usr/bin/env -S node --experimental-strip-types
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import TonConnect, {
  isWalletInfoRemote,
  type IStorage,
  type TonConnectError,
  type TonProofItemReplySuccess,
  type Wallet,
  type WalletConnectionSourceHTTP,
} from "@tonconnect/sdk";
import { Address } from "@ton/ton";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.join(__dirname, "..");
const DEFAULT_TONCONNECT_STATE_DIR = path.join(SKILL_DIR, "workflows", "tonconnect");
const DEFAULT_FRONTEND_URL = "https://www.unigox.com";
const TONCONNECT_OPENING_DEADLINE_MS = 15 * 60 * 1000;

export interface TonConnectSessionStartResult {
  universalLink: string;
  manifestUrl: string;
  expiresAt: string;
}

export interface TonConnectProofPayload {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  signature: string;
  payload: string;
  stateInit?: string;
}

export interface TonConnectSessionStatusPending {
  status: "pending";
}

export interface TonConnectSessionStatusConnected {
  status: "connected";
  walletAddress: string;
  network: string;
  publicKey?: string;
  proof: TonConnectProofPayload;
}

export interface TonConnectSessionStatusError {
  status: "error";
  message: string;
}

export type TonConnectSessionStatusResult =
  | TonConnectSessionStatusPending
  | TonConnectSessionStatusConnected
  | TonConnectSessionStatusError;

class FileTonConnectStorage implements IStorage {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private filePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return path.join(this.rootDir, `${safe}.json`);
  }

  async setItem(key: string, value: string): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.filePath(key), value, "utf-8");
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.filePath(key), "utf-8");
    } catch {
      return null;
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await fs.rm(this.filePath(key), { force: true });
    } catch {
      // ignore
    }
  }
}

function slugifySessionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "default";
}

function buildTonConnectManifestUrl(frontendUrl = DEFAULT_FRONTEND_URL): string {
  return `${frontendUrl.replace(/\/+$/, "")}/api/tonconnect-manifest`;
}

function resolveTonConnectStateDir(rootDir: string, sessionKey: string): string {
  return path.join(rootDir, slugifySessionKey(sessionKey));
}

function createConnector(params: {
  frontendUrl?: string;
  stateDir?: string;
  sessionKey: string;
}): TonConnect {
  const frontendUrl = params.frontendUrl || DEFAULT_FRONTEND_URL;
  const manifestUrl = buildTonConnectManifestUrl(frontendUrl);
  const stateDir = resolveTonConnectStateDir(params.stateDir || DEFAULT_TONCONNECT_STATE_DIR, params.sessionKey);
  const storage = new FileTonConnectStorage(stateDir);
  return new TonConnect({ manifestUrl, storage });
}

function toUniqueUnifiedSources(wallets: Awaited<ReturnType<TonConnect["getWallets"]>>): Pick<WalletConnectionSourceHTTP, "bridgeUrl">[] {
  const seen = new Set<string>();
  const sources: Pick<WalletConnectionSourceHTTP, "bridgeUrl">[] = [];
  for (const wallet of wallets) {
    if (!isWalletInfoRemote(wallet) || !wallet.bridgeUrl) continue;
    if (seen.has(wallet.bridgeUrl)) continue;
    seen.add(wallet.bridgeUrl);
    sources.push({ bridgeUrl: wallet.bridgeUrl });
  }
  return sources;
}

function hasTonProof(wallet: Wallet | null | undefined): wallet is Wallet & { connectItems: { tonProof: TonProofItemReplySuccess } } {
  return Boolean(wallet?.connectItems?.tonProof && "proof" in wallet.connectItems.tonProof);
}

function normalizeWalletAddress(address: string): string {
  return Address.parse(address).toRawString().toLowerCase();
}

async function waitForConnectedWallet(
  connector: TonConnect,
  waitMs: number,
): Promise<{ wallet?: Wallet; error?: TonConnectError }> {
  if (connector.wallet) {
    return { wallet: connector.wallet };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { wallet?: Wallet; error?: TonConnectError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = connector.onStatusChange(
      (wallet) => {
        if (wallet) finish({ wallet });
      },
      (error) => finish({ error }),
    );

    const timer = setTimeout(() => finish({}), Math.max(0, waitMs));
  });
}

export async function startTonConnectSession(params: {
  sessionKey: string;
  tonProof: string;
  frontendUrl?: string;
  stateDir?: string;
}): Promise<TonConnectSessionStartResult> {
  const frontendUrl = params.frontendUrl || DEFAULT_FRONTEND_URL;
  const connector = createConnector({
    frontendUrl,
    stateDir: params.stateDir,
    sessionKey: params.sessionKey,
  });

  try {
    await connector.disconnect();
  } catch {
    // Safe to ignore; we just want a fresh session.
  }

  const wallets = await connector.getWallets();
  const sources = toUniqueUnifiedSources(wallets);
  if (!sources.length) {
    throw new Error("No remote TonConnect wallets are available right now.");
  }

  const universalLink = connector.connect(sources, {
    request: { tonProof: params.tonProof },
    openingDeadlineMS: TONCONNECT_OPENING_DEADLINE_MS,
  });

  return {
    universalLink,
    manifestUrl: buildTonConnectManifestUrl(frontendUrl),
    expiresAt: new Date(Date.now() + TONCONNECT_OPENING_DEADLINE_MS).toISOString(),
  };
}

export async function checkTonConnectSession(params: {
  sessionKey: string;
  frontendUrl?: string;
  stateDir?: string;
  waitMs?: number;
}): Promise<TonConnectSessionStatusResult> {
  const connector = createConnector({
    frontendUrl: params.frontendUrl,
    stateDir: params.stateDir,
    sessionKey: params.sessionKey,
  });

  const unsubscribe = connector.onStatusChange(() => {}, () => {});
  try {
    await connector.restoreConnection({
      openingDeadlineMS: params.waitMs ?? 2500,
    });
  } catch {
    // We'll still inspect the connector state below.
  } finally {
    unsubscribe();
  }

  const connected = connector.wallet;
  if (hasTonProof(connected)) {
    return {
      status: "connected",
      walletAddress: normalizeWalletAddress(connected.account.address),
      network: connected.account.chain,
      publicKey: connected.account.publicKey,
      proof: {
        ...connected.connectItems.tonProof.proof,
        ...(connected.account.walletStateInit ? { stateInit: connected.account.walletStateInit } : {}),
      },
    };
  }

  const waited = await waitForConnectedWallet(connector, params.waitMs ?? 2500);
  if (waited.error) {
    return {
      status: "error",
      message: waited.error.message || "TonConnect returned a connection error.",
    };
  }

  if (!hasTonProof(waited.wallet)) {
    return { status: "pending" };
  }

  return {
    status: "connected",
    walletAddress: normalizeWalletAddress(waited.wallet.account.address),
    network: waited.wallet.account.chain,
    publicKey: waited.wallet.account.publicKey,
    proof: {
      ...waited.wallet.connectItems.tonProof.proof,
      ...(waited.wallet.account.walletStateInit ? { stateInit: waited.wallet.account.walletStateInit } : {}),
    },
  };
}

export async function clearTonConnectSession(params: {
  sessionKey: string;
  frontendUrl?: string;
  stateDir?: string;
}): Promise<void> {
  const rootDir = params.stateDir || DEFAULT_TONCONNECT_STATE_DIR;
  const sessionDir = resolveTonConnectStateDir(rootDir, params.sessionKey);
  const connector = createConnector({
    frontendUrl: params.frontendUrl,
    stateDir: params.stateDir,
    sessionKey: params.sessionKey,
  });
  try {
    await connector.disconnect();
  } catch {
    // ignore
  }
  await fs.rm(sessionDir, { recursive: true, force: true });
}
