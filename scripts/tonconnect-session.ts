#!/usr/bin/env -S node --experimental-strip-types
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Base64, SessionCrypto, hexToByteArray } from "@tonconnect/protocol";
import TonConnect, {
  isWalletInfoRemote,
  type IStorage,
  type TonConnectError,
  type TonProofItemReplySuccess,
  type ConnectRequest,
  type ConnectEventSuccess,
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
const DEFAULT_WALLET_BRIDGE_URL = "https://bridge.tonapi.io/bridge";
const DEFAULT_WALLET_APP_NAME = "tonkeeper";
const DEFAULT_WALLET_DEVICE_INFO_BASE: Omit<ConnectEventSuccess["payload"]["device"], "appName"> = {
  appVersion: "1.0.0",
  maxProtocolVersion: 2,
  features: [],
  platform: "browser",
};
const DEFAULT_EVENT_ID = 0;

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

export interface ParsedTonConnectLink {
  dappSessionId: string;
  traceId?: string;
  request: ConnectRequest;
  manifestUrl: string;
  tonProofPayload?: string;
}

export interface TonConnectWalletApprovalParams {
  universalLink: string;
  walletAddress: string;
  network: string;
  publicKey: string;
  stateInit: string;
  tonProof?: {
    timestamp: number;
    domain: { lengthBytes: number; value: string };
    payload: string;
    signature: string;
  };
  bridgeUrl?: string;
  device?: ConnectEventSuccess["payload"]["device"];
}

export interface TonConnectWalletApprovalResult {
  bridgeUrl: string;
  dappSessionId: string;
  walletSessionId: string;
  manifestUrl: string;
  tonProofPayload?: string;
}

interface ResolvedRemoteTonConnectWallet {
  bridgeUrl: string;
  appName: string;
}

class MemoryTonConnectStorage implements IStorage {
  async setItem(): Promise<void> {}
  async getItem(): Promise<string | null> { return null; }
  async removeItem(): Promise<void> {}
}

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

function createWalletsListConnector(manifestUrl: string): TonConnect {
  return new TonConnect({ manifestUrl, storage: new MemoryTonConnectStorage() });
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

export function parseTonConnectUniversalLink(link: string): ParsedTonConnectLink {
  const trimmed = link.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error("That does not look like a valid TonConnect link.");
  }

  if (parsedUrl.protocol !== "tc:") {
    throw new Error("I only accept a fresh tc:// TonConnect link for this browser-login flow.");
  }

  const dappSessionId = parsedUrl.searchParams.get("id") || "";
  if (!/^[0-9a-fA-F]{64}$/.test(dappSessionId)) {
    throw new Error("That TonConnect link is missing a valid dapp session id.");
  }

  const encodedRequest = parsedUrl.searchParams.get("r");
  if (!encodedRequest) {
    throw new Error("That TonConnect link is missing the connection request payload.");
  }

  let request: ConnectRequest;
  try {
    request = JSON.parse(encodedRequest) as ConnectRequest;
  } catch {
    throw new Error("That TonConnect link contains an unreadable connection request.");
  }

  if (!request?.manifestUrl || !Array.isArray(request.items)) {
    throw new Error("That TonConnect link is missing the expected manifest or request items.");
  }

  const tonProofPayload = request.items.find((item) => item.name === "ton_proof" && "payload" in item)?.payload;
  return {
    dappSessionId: dappSessionId.toLowerCase(),
    traceId: parsedUrl.searchParams.get("trace_id") || undefined,
    request,
    manifestUrl: request.manifestUrl,
    tonProofPayload,
  };
}

async function resolveRemoteTonConnectBridgeUrl(manifestUrl: string): Promise<string> {
  return (await resolveRemoteTonConnectWallet(manifestUrl)).bridgeUrl;
}

async function resolveRemoteTonConnectWallet(manifestUrl: string): Promise<ResolvedRemoteTonConnectWallet> {
  try {
    const connector = createWalletsListConnector(manifestUrl);
    const wallets = await connector.getWallets();
    const remoteWallets = wallets.filter(isWalletInfoRemote);
    const tonkeeper = remoteWallets.find((wallet) => wallet.appName === "tonkeeper" && wallet.bridgeUrl);
    if (tonkeeper?.bridgeUrl) {
      return {
        bridgeUrl: tonkeeper.bridgeUrl,
        appName: tonkeeper.appName,
      };
    }
    const first = remoteWallets.find((wallet) => wallet.bridgeUrl);
    if (first?.bridgeUrl) {
      return {
        bridgeUrl: first.bridgeUrl,
        appName: first.appName,
      };
    }
  } catch {
    // Fall back to the best-known bridge URL below.
  }
  return {
    bridgeUrl: DEFAULT_WALLET_BRIDGE_URL,
    appName: DEFAULT_WALLET_APP_NAME,
  };
}

export async function approveTonConnectUniversalLinkWithWallet(
  params: TonConnectWalletApprovalParams,
  options?: {
    fetchImpl?: typeof fetch;
    resolveBridgeUrl?: (manifestUrl: string) => Promise<string>;
    resolveWalletInfo?: (manifestUrl: string) => Promise<ResolvedRemoteTonConnectWallet>;
  },
): Promise<TonConnectWalletApprovalResult> {
  const parsed = parseTonConnectUniversalLink(params.universalLink);
  const walletAddress = normalizeWalletAddress(params.walletAddress);
  const requestedNetwork = parsed.request.items.find((item) => item.name === "ton_addr" && "network" in item)?.network;
  if (requestedNetwork && requestedNetwork !== params.network) {
    throw new Error(`This TonConnect request expects network ${requestedNetwork}, not ${params.network}.`);
  }

  const resolvedWallet = options?.resolveWalletInfo
    ? await options.resolveWalletInfo(parsed.manifestUrl)
    : params.bridgeUrl
      ? {
          bridgeUrl: params.bridgeUrl,
          appName: DEFAULT_WALLET_APP_NAME,
        }
      : options?.resolveBridgeUrl
        ? {
            bridgeUrl: await options.resolveBridgeUrl(parsed.manifestUrl),
            appName: DEFAULT_WALLET_APP_NAME,
          }
        : await resolveRemoteTonConnectWallet(parsed.manifestUrl);
  const bridgeUrl = params.bridgeUrl || resolvedWallet.bridgeUrl;
  const walletSession = new SessionCrypto();

  const items: ConnectEventSuccess["payload"]["items"] = [
    {
      name: "ton_addr",
      address: walletAddress,
      network: params.network,
      publicKey: params.publicKey,
      walletStateInit: params.stateInit,
    },
  ];

  if (parsed.tonProofPayload) {
    if (!params.tonProof) {
      throw new Error("This TonConnect request requires ton_proof, but no TON proof was provided.");
    }
    if (params.tonProof.payload !== parsed.tonProofPayload) {
      throw new Error("The TON proof payload does not match the request from the TonConnect link.");
    }
    items.push({
      name: "ton_proof",
      proof: params.tonProof,
    });
  }

  const connectEvent: ConnectEventSuccess = {
    event: "connect",
    id: DEFAULT_EVENT_ID,
    payload: {
      items,
      device: params.device || {
        appName: resolvedWallet.appName || DEFAULT_WALLET_APP_NAME,
        ...DEFAULT_WALLET_DEVICE_INFO_BASE,
      },
    },
  };

  const encrypted = walletSession.encrypt(JSON.stringify(connectEvent), hexToByteArray(parsed.dappSessionId));
  const postUrl = new URL("message", `${bridgeUrl.replace(/\/+$/, "")}/`);
  postUrl.searchParams.set("client_id", walletSession.sessionId);
  postUrl.searchParams.set("to", parsed.dappSessionId);
  postUrl.searchParams.set("ttl", "300");
  postUrl.searchParams.set("topic", "connect");
  if (parsed.traceId) {
    postUrl.searchParams.set("trace_id", parsed.traceId);
  }

  const fetchImpl = options?.fetchImpl || fetch;
  const response = await fetchImpl(postUrl, {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
    },
    body: Base64.encode(encrypted),
  });

  if (!response.ok) {
    throw new Error(`TonConnect bridge approval failed with HTTP ${response.status}.`);
  }

  return {
    bridgeUrl,
    dappSessionId: parsed.dappSessionId,
    walletSessionId: walletSession.sessionId,
    manifestUrl: parsed.manifestUrl,
    tonProofPayload: parsed.tonProofPayload,
  };
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
