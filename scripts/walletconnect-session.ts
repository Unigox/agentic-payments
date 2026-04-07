#!/usr/bin/env -S node --experimental-strip-types
import { Core, type CoreTypes } from "@walletconnect/core";
import type { JsonRpcResponse } from "@walletconnect/jsonrpc-types";
import type { ProposalTypes, SessionTypes } from "@walletconnect/types";
import { buildApprovedNamespaces } from "@walletconnect/utils";
import { WalletKit, type WalletKitTypes } from "@reown/walletkit";
import {
  Wallet,
  getAddress,
  getBytes,
  isHexString,
  TypedDataEncoder,
} from "ethers";

const DEFAULT_FRONTEND_URL = "https://www.unigox.com";
const DEFAULT_PROPOSAL_TIMEOUT_MS = 20_000;
const DEFAULT_INITIAL_REQUEST_WAIT_MS = 3_000;
const DEFAULT_REQUEST_IDLE_MS = 1_500;
const DEFAULT_REQUEST_DRAIN_TIMEOUT_MS = 12_000;
const DEFAULT_WALLETCONNECT_METHODS = [
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "net_version",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
] as const;
const DEFAULT_WALLETCONNECT_EVENTS = [
  "accountsChanged",
  "chainChanged",
  "disconnect",
] as const;

export interface ParsedWalletConnectUri {
  uri: string;
  topic: string;
  version: number;
  relayProtocol?: string;
  symKey?: string;
}

export interface WalletConnectBrowserApprovalParams {
  uri: string;
  privateKey: string;
  walletAddress?: string;
  projectId: string;
  frontendUrl?: string;
  sessionKey?: string;
  proposalTimeoutMs?: number;
  initialRequestWaitMs?: number;
  requestIdleMs?: number;
  requestDrainTimeoutMs?: number;
}

export interface WalletConnectBrowserApprovalResult {
  sessionTopic?: string;
  pairingTopic?: string;
  requestedChains: string[];
  approvedChains: string[];
  requestedMethods: string[];
  handledMethods: string[];
  requestCount: number;
}

interface WalletConnectSessionState {
  approvedChains: string[];
  activeChain: string;
  handledMethods: Set<string>;
  requestCount: number;
  pendingRequests: Set<Promise<void>>;
  lastRequestAt: number | undefined;
  firstRequestAt: number | undefined;
  firstRequestHandledAt: number | undefined;
  requestError: Error | undefined;
}

type WalletKitLike = Pick<
  WalletKitTypes.IWalletKit,
  "on" | "pair" | "approveSession" | "respondSessionRequest" | "getActiveSessions"
>;

function slugifySessionKey(value: string | undefined): string {
  return (value || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "default";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureWalletConnectUri(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error("I need a fresh wc: WalletConnect link from unigox.com.");
  }
  const match = trimmed.match(/wc:[^\s]+/i);
  if (!match) {
    throw new Error("That does not look like a WalletConnect wc: link.");
  }
  return match[0];
}

function parseChainReference(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("eip155:")) return trimmed;
  const numeric = Number.parseInt(trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed, trimmed.startsWith("0x") ? 16 : 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Unsupported chain id ${value}.`);
  }
  return `eip155:${numeric}`;
}

function chainReferenceToHex(chainReference: string): string {
  const [, chainId] = chainReference.split(":");
  const numeric = Number.parseInt(chainId || "", 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Unsupported chain id ${chainReference}.`);
  }
  return `0x${numeric.toString(16)}`;
}

function chainReferenceToDecimal(chainReference: string): string {
  const [, chainId] = chainReference.split(":");
  const numeric = Number.parseInt(chainId || "", 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Unsupported chain id ${chainReference}.`);
  }
  return String(numeric);
}

function getRequestedChains(proposal: ProposalTypes.Struct): string[] {
  const required = Object.values(proposal.requiredNamespaces || {}).flatMap((namespace) => namespace.chains || []);
  const optional = Object.values(proposal.optionalNamespaces || {}).flatMap((namespace) => namespace.chains || []);
  const combined = [...required, ...optional].filter((entry): entry is string => Boolean(entry));
  return [...new Set(combined)];
}

function getRequestedMethods(proposal: ProposalTypes.Struct): string[] {
  const required = Object.values(proposal.requiredNamespaces || {}).flatMap((namespace) => namespace.methods || []);
  const optional = Object.values(proposal.optionalNamespaces || {}).flatMap((namespace) => namespace.methods || []);
  return [...new Set([...required, ...optional].filter((entry): entry is string => Boolean(entry)))];
}

function decodeSignableMessage(value: unknown): string | Uint8Array {
  if (typeof value !== "string") {
    throw new Error("Expected a string message payload to sign.");
  }
  if (isHexString(value)) {
    return getBytes(value);
  }
  return value;
}

function normalizeTypedData(raw: unknown): {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
} {
  const parsed = typeof raw === "string"
    ? JSON.parse(raw) as Record<string, unknown>
    : raw as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("The typed-data payload is not valid JSON.");
  }

  const domain = (parsed.domain && typeof parsed.domain === "object")
    ? parsed.domain as Record<string, unknown>
    : {};
  const typesInput = (parsed.types && typeof parsed.types === "object")
    ? parsed.types as Record<string, Array<{ name: string; type: string }>>
    : undefined;
  const message = (parsed.message && typeof parsed.message === "object")
    ? parsed.message as Record<string, unknown>
    : undefined;

  if (!typesInput || !message) {
    throw new Error("The typed-data payload is missing types or message.");
  }

  const types = Object.fromEntries(
    Object.entries(typesInput).filter(([name]) => name !== "EIP712Domain"),
  );
  TypedDataEncoder.from(types);

  return { domain, types, message };
}

function makeJsonRpcResult(id: number, result: unknown): JsonRpcResponse {
  return {
    id,
    jsonrpc: "2.0",
    result,
  };
}

function makeJsonRpcError(id: number, code: number, message: string): JsonRpcResponse {
  return {
    id,
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
  };
}

function parseSwitchChainParams(params: unknown): string {
  const request = Array.isArray(params) ? params[0] : params;
  const chainId = request && typeof request === "object" && "chainId" in request
    ? (request as { chainId?: unknown }).chainId
    : undefined;
  if (typeof chainId !== "string" || !chainId.trim()) {
    throw new Error("WalletConnect did not provide a chainId to switch to.");
  }
  return parseChainReference(chainId);
}

function buildSupportedNamespaces(chains: string[], walletAddress: string) {
  return {
    eip155: {
      chains,
      methods: [...DEFAULT_WALLETCONNECT_METHODS],
      events: [...DEFAULT_WALLETCONNECT_EVENTS],
      accounts: chains.map((chain) => `${chain}:${walletAddress}`),
    },
  };
}

async function createWalletKit(
  params: WalletConnectBrowserApprovalParams,
): Promise<WalletKitLike> {
  const metadata: CoreTypes.Metadata = {
    name: "Agentic Payments",
    description: "Local UNIGOX wallet-side approval for Agentic Payments browser login.",
    url: params.frontendUrl || DEFAULT_FRONTEND_URL,
    icons: [`${(params.frontendUrl || DEFAULT_FRONTEND_URL).replace(/\/+$/, "")}/favicon.ico`],
  };
  const core = await Core.init({
    projectId: params.projectId,
    customStoragePrefix: `agentic-payments-walletconnect-${slugifySessionKey(params.sessionKey)}-${Date.now()}`,
  });
  return WalletKit.init({
    core,
    metadata,
    name: "agentic-payments",
  });
}

async function waitForSessionProposal(
  walletKit: WalletKitLike,
  timeoutMs: number,
): Promise<WalletKitTypes.SessionProposal> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the WalletConnect session proposal."));
    }, timeoutMs);

    walletKit.on("session_proposal", (proposal) => {
      clearTimeout(timer);
      resolve(proposal);
    });
  });
}

async function respondToWalletConnectRequest(params: {
  wallet: Wallet;
  event: WalletKitTypes.SessionRequest;
  state: WalletConnectSessionState;
  walletAddress: string;
}): Promise<JsonRpcResponse> {
  const { wallet, event, state, walletAddress } = params;
  const method = event.params.request.method;
  const requestParams = event.params.request.params;

  if (event.params.chainId && state.approvedChains.includes(event.params.chainId)) {
    state.activeChain = event.params.chainId;
  }

  switch (method) {
    case "eth_accounts":
    case "eth_requestAccounts":
      return makeJsonRpcResult(event.id, [walletAddress]);
    case "eth_chainId":
      return makeJsonRpcResult(event.id, chainReferenceToHex(state.activeChain));
    case "net_version":
      return makeJsonRpcResult(event.id, chainReferenceToDecimal(state.activeChain));
    case "wallet_switchEthereumChain": {
      const nextChain = parseSwitchChainParams(requestParams);
      if (!state.approvedChains.includes(nextChain)) {
        return makeJsonRpcError(event.id, 4902, `Chain ${nextChain} is not approved for this WalletConnect session.`);
      }
      state.activeChain = nextChain;
      return makeJsonRpcResult(event.id, null);
    }
    case "wallet_addEthereumChain": {
      const nextChain = parseSwitchChainParams(requestParams);
      if (state.approvedChains.includes(nextChain)) {
        state.activeChain = nextChain;
      }
      return makeJsonRpcResult(event.id, null);
    }
    case "personal_sign":
    case "eth_sign": {
      const paramsList = Array.isArray(requestParams) ? requestParams : [];
      const [first, second] = paramsList;
      const address = typeof first === "string" && first.startsWith("0x") && first.length === 42
        ? first
        : typeof second === "string" && second.startsWith("0x") && second.length === 42
          ? second
          : undefined;
      const message = address === first ? second : first;
      if (address && getAddress(address) !== walletAddress) {
        return makeJsonRpcError(event.id, 4001, `WalletConnect requested signature from ${address}, not ${walletAddress}.`);
      }
      return makeJsonRpcResult(event.id, await wallet.signMessage(decodeSignableMessage(message)));
    }
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4": {
      const paramsList = Array.isArray(requestParams) ? requestParams : [];
      const [first, second] = paramsList;
      const address = typeof first === "string" && first.startsWith("0x") && first.length === 42
        ? first
        : typeof second === "string" && second.startsWith("0x") && second.length === 42
          ? second
          : undefined;
      const typedData = address === first ? second : first;
      if (address && getAddress(address) !== walletAddress) {
        return makeJsonRpcError(event.id, 4001, `WalletConnect requested typed-data signature from ${address}, not ${walletAddress}.`);
      }
      const normalized = normalizeTypedData(typedData);
      return makeJsonRpcResult(
        event.id,
        await wallet.signTypedData(normalized.domain, normalized.types, normalized.message),
      );
    }
    default:
      return makeJsonRpcError(event.id, 4200, `Unsupported WalletConnect request method: ${method}`);
  }
}

async function waitForRequestDrain(
  state: WalletConnectSessionState,
  options: {
    initialRequestWaitMs: number;
    requestIdleMs: number;
    requestDrainTimeoutMs: number;
  },
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < options.requestDrainTimeoutMs) {
    if (state.requestError) throw state.requestError;

    if (!state.firstRequestAt) {
      if (Date.now() - startedAt >= options.initialRequestWaitMs) {
        return;
      }
      await sleep(100);
      continue;
    }

    if (!state.pendingRequests.size && state.lastRequestAt && Date.now() - state.lastRequestAt >= options.requestIdleMs) {
      return;
    }

    await sleep(100);
  }

  if (state.requestError) throw state.requestError;
}

export function parseWalletConnectUri(uri: string): ParsedWalletConnectUri {
  const normalized = ensureWalletConnectUri(uri);
  const match = normalized.match(/^wc:([^@]+)@(\d+)\?(.*)$/i);
  if (!match) {
    throw new Error("That does not look like a valid WalletConnect wc: link.");
  }

  const [, topic, versionText, queryText] = match;
  const query = new URLSearchParams(queryText);
  const version = Number.parseInt(versionText, 10);

  if (!topic || !Number.isFinite(version)) {
    throw new Error("That WalletConnect link is missing a valid topic or version.");
  }

  if (!query.get("symKey")) {
    throw new Error("That WalletConnect link is missing its session symKey.");
  }

  return {
    uri: normalized,
    topic,
    version,
    relayProtocol: query.get("relay-protocol") || undefined,
    symKey: query.get("symKey") || undefined,
  };
}

export async function approveWalletConnectUriWithWallet(
  params: WalletConnectBrowserApprovalParams,
  options?: {
    walletKit?: WalletKitLike;
  },
): Promise<WalletConnectBrowserApprovalResult> {
  const parsed = parseWalletConnectUri(params.uri);
  const wallet = new Wallet(params.privateKey);
  const walletAddress = params.walletAddress ? getAddress(params.walletAddress) : wallet.address;

  if (wallet.address !== walletAddress) {
    throw new Error(`The stored EVM login key derives ${wallet.address}, not ${walletAddress}.`);
  }

  const walletKit = options?.walletKit || await createWalletKit(params);
  const proposalPromise = waitForSessionProposal(
    walletKit,
    params.proposalTimeoutMs ?? DEFAULT_PROPOSAL_TIMEOUT_MS,
  );

  const state: WalletConnectSessionState = {
    approvedChains: [],
    activeChain: "eip155:1",
    handledMethods: new Set(),
    requestCount: 0,
    pendingRequests: new Set(),
    lastRequestAt: undefined,
    firstRequestAt: undefined,
    firstRequestHandledAt: undefined,
    requestError: undefined,
  };

  walletKit.on("session_request", (event) => {
    state.requestCount += 1;
    state.firstRequestAt ||= Date.now();
    state.lastRequestAt = Date.now();
    const pending = (async () => {
      const response = await respondToWalletConnectRequest({
        wallet,
        event,
        state,
        walletAddress,
      });
      if ("result" in response) {
        state.handledMethods.add(event.params.request.method);
        state.firstRequestHandledAt ||= Date.now();
      } else {
        state.requestError ||= new Error(response.error?.message || `WalletConnect request ${event.params.request.method} failed.`);
      }
      await walletKit.respondSessionRequest({
        topic: event.topic,
        response,
      });
    })();

    state.pendingRequests.add(pending);
    pending.finally(() => {
      state.pendingRequests.delete(pending);
      state.lastRequestAt = Date.now();
    }).catch((error) => {
      state.requestError ||= error instanceof Error ? error : new Error(String(error));
    });
  });

  await walletKit.pair({ uri: parsed.uri });
  const proposalEvent = await proposalPromise;
  const proposal = proposalEvent.params;
  const requestedChains = getRequestedChains(proposal);
  const requestedMethods = getRequestedMethods(proposal);
  const fallbackChain = eventChainFallback(requestedChains);
  const supportedChains = requestedChains.length ? requestedChains : [fallbackChain];
  const namespaces = buildApprovedNamespaces({
    proposal,
    supportedNamespaces: buildSupportedNamespaces(supportedChains, walletAddress),
  });

  state.approvedChains = extractApprovedChains(namespaces, supportedChains);
  state.activeChain = state.approvedChains[0] || fallbackChain;

  await walletKit.approveSession({
    id: proposal.id,
    namespaces,
    ...(proposal.sessionProperties ? { sessionProperties: proposal.sessionProperties } : {}),
  });

  await waitForRequestDrain(state, {
    initialRequestWaitMs: params.initialRequestWaitMs ?? DEFAULT_INITIAL_REQUEST_WAIT_MS,
    requestIdleMs: params.requestIdleMs ?? DEFAULT_REQUEST_IDLE_MS,
    requestDrainTimeoutMs: params.requestDrainTimeoutMs ?? DEFAULT_REQUEST_DRAIN_TIMEOUT_MS,
  });

  const activeSessions = Object.values(walletKit.getActiveSessions?.() || {});
  const matchingSession = activeSessions.find((session) => session.pairingTopic === proposal.pairingTopic)
    || activeSessions[0];

  return {
    sessionTopic: matchingSession?.topic,
    pairingTopic: proposal.pairingTopic,
    requestedChains,
    approvedChains: state.approvedChains,
    requestedMethods,
    handledMethods: [...state.handledMethods],
    requestCount: state.requestCount,
  };
}

function extractApprovedChains(
  namespaces: SessionTypes.Namespaces,
  fallbackChains: string[],
): string[] {
  const fromNamespaces = Object.values(namespaces).flatMap((namespace) => namespace.chains || []);
  return [...new Set((fromNamespaces.length ? fromNamespaces : fallbackChains).filter((entry): entry is string => Boolean(entry)))];
}

function eventChainFallback(requestedChains: string[]): string {
  return requestedChains[0] || "eip155:1";
}
