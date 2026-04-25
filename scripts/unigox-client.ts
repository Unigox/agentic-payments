#!/usr/bin/env -S node --experimental-strip-types
/**
 * UNIGOX User Client — Standalone Module
 * 
 * Reusable levers for interacting with UNIGOX as a regular user (not vendor).
 * Designed to be imported by automation scripts, AI agent skills, and bots.
 * 
 * Features:
 *   - EVM, TON, or email-assisted auth (with auto-refresh where replayable)
 *   - Payment details CRUD (create, read, update, delete)
 *   - Trade request creation + polling
 *   - Wallet balance (USDC, USDT on XAI chain)
 *   - Deposit addresses (EVM, Solana, Tron, TON)
 *   - Bridge out (withdraw to any supported chain)
 *   - Supported chains + tokens listing
 * 
 * Usage:
 *   import { UnigoxClient } from "./unigox-client.ts";
 *   const client = new UnigoxClient({
 *     evmLoginPrivateKey: "0x...",        // wallet used to sign in on UNIGOX (SIWE)
 *   });
 *   await client.login();
 *   const details = await client.listPaymentDetails();
 *
 * On-chain signing (Forwarder ForwardRequest, Gnosis SafeTx, EIP-3009 permit,
 * arbitrary EIP-712) is delegated to the privy-signing backend; the client never
 * holds a signing key. After login the captured idToken is reused as Bearer
 * authentication for every signature request.
 */

import crypto from "node:crypto";
import { mnemonicNew, mnemonicToWalletKey } from "@ton/crypto";
import {
  Address,
  WalletContractV1R1,
  WalletContractV1R2,
  WalletContractV1R3,
  WalletContractV2R1,
  WalletContractV2R2,
  WalletContractV3R1,
  WalletContractV3R2,
  WalletContractV4,
  WalletContractV5Beta,
  WalletContractV5R1,
  beginCell,
  storeStateInit,
} from "@ton/ton";
import nacl from "tweetnacl";
import { Wallet, ethers } from "ethers";
import { approveTonConnectUniversalLinkWithWallet, parseTonConnectUniversalLink } from "./tonconnect-session.ts";
import { approveWalletConnectUriWithWallet, parseWalletConnectUri } from "./walletconnect-session.ts";
import { PrivySigner, PrivySigningError } from "./privy-signer.ts";

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_FRONTEND_URL = "https://www.unigox.com";
const DEFAULT_VERIFICATION_API = "https://prod-verification-aay37.ondigitalocean.app/api/v1";

function resolveVerificationApi(): string {
  return process.env.UNIGOX_VERIFICATION_API
    || process.env.NEXT_PUBLIC_VERIFICATION_API
    || DEFAULT_VERIFICATION_API;
}

const APIS = {
  trades:     "https://prod-trades-inrvj.ondigitalocean.app/api/v1",
  account:    "https://prod-account-gynob.ondigitalocean.app/api/v1",
  offers:     "https://prod-offers-jwek6.ondigitalocean.app/api/v1",
  escrow:     "https://prod-escrow-l2eom.ondigitalocean.app/api/v1",
  transactor: "https://transactorpoc-mi666.ondigitalocean.app/api/v1",
  verification: resolveVerificationApi(),
  currency:   "https://prod-currencies-trz2y.ondigitalocean.app/api/v1",
  quote:      "https://prod-relay-quote-bwl48.ondigitalocean.app",
};

const FORWARDER_ADDRESS = "0x6fFCF38bEc8c733b096958fcd2a8E31A00530EDC";
const XAI_CHAIN_ID = 660279;
const XAI_RPC = "https://winter-sly-arm.xai-mainnet.quiknode.pro/22c451bac53857e59d753b2c08462faba1841666";

const TOKENS: Record<string, { address: string; decimals: number }> = {
  USDC: { address: "0x37BF70ee0dC89a408De31B79cCCC3152F0C8AF43", decimals: 6 },
  USDT: { address: "0xf86Cc81F4E480CF54Eb013FFe6929a0C2Ad5EdCA", decimals: 6 },
};

const FUNDING_BALANCE_ABI = [
  "function getBalance(address token) view returns (uint256)",
  "function getReserved(address token) view returns (uint256)",
  "function withdraw(address token, uint256 amount) returns (bool)",
] as const;

const FORWARDER_ABI = [
  "function nonces(address from) view returns (uint256)",
] as const;

// ── Types ───────────────────────────────────────────────────────────

export type AuthMode = "auto" | "evm" | "ton" | "email";
type ResolvedAuthMode = Exclude<AuthMode, "auto">;

export function getUnigoxWalletConnectionPrompt(): string {
  return [
    "Which UNIGOX sign-in path should I set up?",
    "1. EVM wallet connection",
    "2. TON wallet connection",
    "3. Create a dedicated EVM wallet on this device",
    "4. Create a dedicated TON wallet on this device",
    "5. Email OTP",
    "The dedicated-wallet paths generate a new isolated login wallet locally on this machine and do not require email OTP first.",
    "Email OTP is still available for onboarding or recovery if you want to use it.",
  ].join(" ");
}

export function generateDedicatedEvmLoginWallet(): { address: string; privateKey: string } {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

export async function generateDedicatedTonLoginWallet(
  preferredVersion?: TonWalletVersion
): Promise<{ address: string; privateKey: string; walletVersion: TonWalletVersion; mnemonic: string }> {
  const mnemonicWords = await mnemonicNew(24);
  const keyPair = await mnemonicToWalletKey(mnemonicWords);
  const { matched, candidates } = resolveTonWalletCandidate({
    publicKey: keyPair.publicKey,
    workchain: 0,
    preferredVersion,
  });

  if (!matched) {
    const candidateSummary = candidates.map((candidate) => `${candidate.version}:${candidate.address}`).join(", ");
    throw new Error(`Generated TON wallet derivation failed. Tried: ${candidateSummary || "none"}.`);
  }

  return {
    address: matched.address,
    privateKey: Buffer.from(keyPair.secretKey).toString("hex"),
    walletVersion: matched.version,
    mnemonic: mnemonicWords.join(" "),
  };
}

export interface UnigoxClientConfig {
  authMode?: AuthMode;
  /** Private key for the wallet used to SIWE-login on UNIGOX. Never used for on-chain signing. */
  evmLoginPrivateKey?: string;
  email?: string;
  frontendUrl?: string;
  tonPrivateKey?: string;
  tonMnemonic?: string | string[];
  tonAddress?: string;
  tonWalletVersion?: TonWalletVersion;
  tonNetwork?: string;
  sessionToken?: string;
  sessionTokenExpiresAt?: number;
  /** Override base URL for the privy-signing backend. */
  privySigningUrl?: string;
}

export interface PaymentDetail {
  id: number;
  fiat_currency_code: string;
  country_code?: string;
  payment_method?: { id: number; name: string; slug?: string };
  payment_network?: { id: number; name: string; slug?: string };
  details: Record<string, string>;
}

export interface TradeRequest {
  id: number;
  status: string;
  trade_type: string;
  crypto_currency_code?: string;
  fiat_currency_code?: string;
  fiat_amount?: number;
  total_crypto_amount?: number;
  best_deal_fiat_amount?: number;
  best_deal_crypto_amount?: number;
  crypto_amount_to_buyer?: number;
  vendor_offer_rate?: number;
  payment_method_name?: string;
  payment_network_name?: string;
  price_confirmation_seconds_left?: number | null;
  trade?: { id: number; status: string };
}

export interface InitiatorTradeSummary {
  id: number;
  status: string;
  fiat_amount?: number;
  fiat_currency_code?: string;
  payment_method_name?: string;
  payment_network_name?: string;
  status_changed_at?: string;
  partner_short_name?: string | null;
  partner_details_checked_at?: string | null;
  payment_request?: boolean;
  possible_actions?: string[];
  initiator_payment_details?: {
    id?: number;
    details?: Record<string, unknown>;
    payment_method_name?: string;
    payment_network_name?: string;
  } | null;
}

export interface PreflightQuote {
  quoteType: "estimate";
  source: "best_offer";
  cryptoCurrencyCode: string;
  fiatCurrencyCode: string;
  fiatAmount: number;
  totalCryptoAmount: number;
  feeCryptoAmount: number;
  vendorOfferRate: number;
  paymentMethodName?: string;
  paymentNetworkName?: string;
}

export interface PartnerPaymentFieldOption {
  value: string;
  label: string;
}

export interface PartnerPaymentFieldDiff {
  partner_field_name: string;
  internal_field_name?: string;
  required: boolean;
  current_value?: string;
  expected_pattern?: string;
  example?: string;
  hint?: string;
  options?: PartnerPaymentFieldOption[];
}

export interface PartnerPaymentDetailsDiffData {
  payment_details_id: number;
  differences: {
    missing_fields?: PartnerPaymentFieldDiff[];
    invalid_fields?: PartnerPaymentFieldDiff[];
  };
}

export interface PartnerPaymentDetailsRecord {
  id?: number;
  internal_details_id?: number;
  partner?: string;
  details: Record<string, string>;
  created_at?: string;
  updated_at?: string;
}

export interface TradeSignaturePayload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  safe_params: Record<string, any>;
}

export interface DepositAddresses {
  evmAddress: string;
  solanaAddress: string;
  tronAddress: string;
  tonAddress: string;
  solanaAddressUnlockSecondsLeft: number;
}

export interface TokenOnChain {
  code: string;
  name: string;
  address: string;
  decimals: number;
  chain: {
    id: number;
    name: string;
    type: string;
    enabled_for_deposit: boolean;
    enabled_for_withdrawal: boolean;
  };
}

export const FRONTEND_DEPOSIT_TOKEN_GROUPS = {
  USDT: ["USDT", "USDT0"],
  USDC: ["USDC"],
} as const;

export const FRONTEND_DEPOSIT_ASSETS = Object.keys(FRONTEND_DEPOSIT_TOKEN_GROUPS) as Array<keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS>;

export type DepositAddressKey = keyof Pick<DepositAddresses, "evmAddress" | "solanaAddress" | "tronAddress" | "tonAddress">;

export interface SupportedDepositChainOption {
  assetCode: keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS;
  tokenCode: string;
  tokenName: string;
  tokenAddress: string;
  chainId: number;
  chainName: string;
  chainType: string;
  addressKey: DepositAddressKey;
}

export interface SupportedDepositAssetOption {
  assetCode: keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS;
  tokenCodes: string[];
  chains: SupportedDepositChainOption[];
}

export interface DepositFlowSelection {
  assetCode: keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS;
  chainId: number;
}

export interface WalletBalanceAsset {
  assetCode: string;
  amount: number;
}

export interface WalletBalance {
  usdc: number;
  usdt: number;
  totalUsd: number;
  assets?: WalletBalanceAsset[];
}

export interface EscrowBalance {
  token: string;
  balance: number;
  reserved: number;
  available: number;
}

export interface BridgeQuote {
  quoteId: string;
  toAmount: string;
  toAmountMin: string;
  executionDuration: number;
  fees: Array<{ name: string; amountFormatted: string; amountUsdFormatted: string }>;
  snapshot: {
    fromAmountFormatted: string;
    toAmountFormatted: string;
    feesAmountUsdFormatted: string;
    isLiquiditySufficient: boolean;
  };
  parameters: {
    fromChain: number;
    amount: string;
    txData: { value: string; data: string };
  };
}

export interface UserProfile {
  user_id: number;
  evm_address: string;
  linked_wallet_address?: string;
  linked_ton_address?: string;
  automated_escrow_address?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  kyc_country_code?: string;
  id_verification_status?: string;
  total_traded_volume_usd?: number;
}

export interface KycVerificationData {
  status?: string;
  verification_url?: string | null;
  verification_seconds_left?: number;
  max_attempts_reached?: boolean;
  error_key?: string;
  provider_messages?: string[];
}

const DEPOSIT_ADDRESS_KEY_BY_CHAIN_TYPE: Record<string, DepositAddressKey> = {
  EVM: "evmAddress",
  Solana: "solanaAddress",
  TVM: "tronAddress",
  TON: "tonAddress",
};

function getFrontendDepositAssetCode(tokenCode: string): keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS | undefined {
  return FRONTEND_DEPOSIT_ASSETS.find((assetCode) => (FRONTEND_DEPOSIT_TOKEN_GROUPS[assetCode] as readonly string[]).includes(tokenCode));
}

function isFrontendSupportedDepositToken(token: TokenOnChain): boolean {
  const assetCode = getFrontendDepositAssetCode(token.code);
  const addressKey = DEPOSIT_ADDRESS_KEY_BY_CHAIN_TYPE[token.chain.type];
  const enabledForDeposit = token.chain.enabled_for_deposit !== undefined ? token.chain.enabled_for_deposit : true;
  return Boolean(assetCode && addressKey && token.chain.id !== XAI_CHAIN_ID && enabledForDeposit);
}

function compareDepositChainOptions(a: SupportedDepositChainOption, b: SupportedDepositChainOption): number {
  return a.chainName.localeCompare(b.chainName) || a.tokenCode.localeCompare(b.tokenCode) || a.chainId - b.chainId;
}

export function getFrontendSupportedDepositOptions(tokens: TokenOnChain[]): SupportedDepositAssetOption[] {
  const byAsset = new Map<keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS, Map<number, SupportedDepositChainOption>>();

  for (const token of tokens) {
    if (!isFrontendSupportedDepositToken(token)) {
      continue;
    }

    const assetCode = getFrontendDepositAssetCode(token.code)!;
    const addressKey = DEPOSIT_ADDRESS_KEY_BY_CHAIN_TYPE[token.chain.type]!;
    const currentByChain = byAsset.get(assetCode) || new Map<number, SupportedDepositChainOption>();
    const candidate: SupportedDepositChainOption = {
      assetCode,
      tokenCode: token.code,
      tokenName: token.name,
      tokenAddress: token.address,
      chainId: token.chain.id,
      chainName: token.chain.name,
      chainType: token.chain.type,
      addressKey,
    };

    const existing = currentByChain.get(token.chain.id);
    const candidateIsMainToken = token.code === assetCode;
    const existingIsMainToken = existing?.tokenCode === assetCode;

    if (!existing || (candidateIsMainToken && !existingIsMainToken)) {
      currentByChain.set(token.chain.id, candidate);
    }

    byAsset.set(assetCode, currentByChain);
  }

  return FRONTEND_DEPOSIT_ASSETS.map((assetCode) => {
    const chains = Array.from(byAsset.get(assetCode)?.values() || []).sort(compareDepositChainOptions);
    return {
      assetCode,
      tokenCodes: [...FRONTEND_DEPOSIT_TOKEN_GROUPS[assetCode]],
      chains,
    };
  }).filter((entry) => entry.chains.length > 0);
}

export function getFrontendSupportedDepositAssetCodes(tokens: TokenOnChain[]): Array<keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS> {
  return getFrontendSupportedDepositOptions(tokens).map((entry) => entry.assetCode);
}

export function getFrontendSupportedDepositChains(tokens: TokenOnChain[], assetCode: keyof typeof FRONTEND_DEPOSIT_TOKEN_GROUPS): SupportedDepositChainOption[] {
  return getFrontendSupportedDepositOptions(tokens).find((entry) => entry.assetCode === assetCode)?.chains || [];
}

export function resolveDepositAddressForSelection(
  depositAddresses: DepositAddresses,
  option: SupportedDepositChainOption,
): string | undefined {
  return depositAddresses[option.addressKey];
}

export function describeDepositAddressSelection(
  selection: DepositFlowSelection,
  tokens: TokenOnChain[],
  depositAddresses: DepositAddresses,
): SupportedDepositChainOption & { depositAddress: string } {
  const option = getFrontendSupportedDepositChains(tokens, selection.assetCode).find((entry) => entry.chainId === selection.chainId);
  if (!option) {
    throw new Error(`Unsupported deposit selection: ${selection.assetCode} on chain ${selection.chainId}`);
  }

  const depositAddress = resolveDepositAddressForSelection(depositAddresses, option);
  if (!depositAddress) {
    throw new Error(`Deposit address unavailable for ${option.assetCode} on ${option.chainName}`);
  }

  return {
    ...option,
    depositAddress,
  };
}

interface TonPayloadTokenPair {
  payloadToken: string;
  payloadTokenHash: string;
}

interface TonProofPayload {
  timestamp: number;
  domain: {
    lengthBytes: number;
    value: string;
  };
  signature: string;
  payload: string;
  stateInit?: string;
}

export interface TonConnectLoginPayload {
  address: string;
  network: string;
  public_key?: string;
  proof: TonProofPayload;
  payloadToken: string;
}

interface TonWalletAccount {
  address: string;
  network: string;
  publicKey: string;
  secretKey: Uint8Array;
  derivedAddress: string;
  walletVersion: TonWalletVersion;
  stateInit: string;
}

export interface ParsedTonPrivateKey {
  normalized: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  source: "seed32" | "secret64";
}

export type TonWalletVersion =
  | "v1r1"
  | "v1r2"
  | "v1r3"
  | "v2r1"
  | "v2r2"
  | "v3r1"
  | "v3r2"
  | "v4"
  | "v5beta"
  | "v5r1";

export interface TonWalletCandidate {
  version: TonWalletVersion;
  address: string;
  stateInit: string;
}

const TON_WALLET_FACTORIES: Array<{
  version: TonWalletVersion;
  create: (workchain: number, publicKey: Uint8Array) => { address: Address; init?: { code?: unknown; data?: unknown } };
}> = [
  { version: "v1r1", create: (workchain, publicKey) => WalletContractV1R1.create({ workchain, publicKey }) },
  { version: "v1r2", create: (workchain, publicKey) => WalletContractV1R2.create({ workchain, publicKey }) },
  { version: "v1r3", create: (workchain, publicKey) => WalletContractV1R3.create({ workchain, publicKey }) },
  { version: "v2r1", create: (workchain, publicKey) => WalletContractV2R1.create({ workchain, publicKey }) },
  { version: "v2r2", create: (workchain, publicKey) => WalletContractV2R2.create({ workchain, publicKey }) },
  { version: "v3r1", create: (workchain, publicKey) => WalletContractV3R1.create({ workchain, publicKey }) },
  { version: "v3r2", create: (workchain, publicKey) => WalletContractV3R2.create({ workchain, publicKey }) },
  { version: "v4", create: (workchain, publicKey) => WalletContractV4.create({ workchain, publicKey }) },
  { version: "v5beta", create: (workchain, publicKey) => WalletContractV5Beta.create({ workchain, publicKey }) },
  { version: "v5r1", create: (workchain, publicKey) => WalletContractV5R1.create({ workchain, publicKey }) },
];

// ── Helpers ─────────────────────────────────────────────────────────

async function jsonFetch(url: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
  return res.json();
}

function unwrap<T>(res: any): T {
  return res?.data ?? res;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function decodeBase64Like(value: string): Buffer | undefined {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding ? normalized.padEnd(normalized.length + (4 - padding), "=") : normalized;
  if (!/^[A-Za-z0-9+/=]+$/.test(padded)) return undefined;
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return undefined;
  }
}

export function parseTonPrivateKeyInput(secret?: string): ParsedTonPrivateKey | undefined {
  const trimmed = secret?.trim();
  if (!trimmed) return undefined;

  let bytes: Buffer | undefined;
  const hex = trimmed.replace(/^0x/i, "");
  if ((hex.length === 64 || hex.length === 128) && /^[0-9a-fA-F]+$/.test(hex)) {
    bytes = Buffer.from(hex, "hex");
  } else {
    const decoded = decodeBase64Like(trimmed.replace(/\s+/g, ""));
    if (decoded && (decoded.length === 32 || decoded.length === 64)) {
      bytes = decoded;
    }
  }

  if (!bytes) return undefined;

  try {
    const keyPair = bytes.length === 32
      ? nacl.sign.keyPair.fromSeed(bytes)
      : bytes.length === 64
        ? nacl.sign.keyPair.fromSecretKey(bytes)
        : undefined;
    if (!keyPair) return undefined;
    return {
      normalized: bytes.toString("hex"),
      secretKey: keyPair.secretKey,
      publicKey: keyPair.publicKey,
      source: bytes.length === 32 ? "seed32" : "secret64",
    };
  } catch {
    return undefined;
  }
}

export function normalizeTonWalletVersion(value?: string | null): TonWalletVersion | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  switch (compact) {
    case "v1r1":
    case "v1r2":
    case "v1r3":
    case "v2r1":
    case "v2r2":
    case "v3r1":
    case "v3r2":
    case "v4":
    case "v5beta":
    case "v5r1":
      return compact;
    default:
      return undefined;
  }
}

function buildTonStateInitBase64(init: { code?: unknown; data?: unknown } | undefined): string | undefined {
  if (!init) return undefined;
  try {
    return beginCell().store(storeStateInit(init as any)).endCell().toBoc().toString("base64");
  } catch {
    return undefined;
  }
}

export function deriveTonWalletCandidates(publicKey: Uint8Array, workchain = 0): TonWalletCandidate[] {
  const normalizedPublicKey = Buffer.from(publicKey);
  const seen = new Set<string>();
  const candidates: TonWalletCandidate[] = [];

  for (const definition of TON_WALLET_FACTORIES) {
    try {
      const wallet = definition.create(workchain, normalizedPublicKey);
      const address = wallet.address.toRawString().toLowerCase();
      if (seen.has(address)) continue;
      const stateInit = buildTonStateInitBase64(wallet.init);
      if (!stateInit) continue;
      seen.add(address);
      candidates.push({
        version: definition.version,
        address,
        stateInit,
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

export function resolveTonWalletCandidate(params: {
  publicKey: Uint8Array;
  workchain?: number;
  address?: string;
  preferredVersion?: TonWalletVersion;
}): { matched?: TonWalletCandidate; candidates: TonWalletCandidate[] } {
  const candidates = deriveTonWalletCandidates(params.publicKey, params.workchain ?? 0);
  const normalizedAddress = params.address ? Address.parse(params.address).toRawString().toLowerCase() : undefined;
  const preferredVersion = normalizeTonWalletVersion(params.preferredVersion);

  if (normalizedAddress) {
    return {
      matched: candidates.find((candidate) => candidate.address === normalizedAddress),
      candidates,
    };
  }

  if (preferredVersion) {
    const preferred = candidates.find((candidate) => candidate.version === preferredVersion);
    if (preferred) {
      return { matched: preferred, candidates };
    }
  }

  return {
    matched: candidates.find((candidate) => candidate.version === "v4") ?? candidates[0],
    candidates,
  };
}

// ── Client ──────────────────────────────────────────────────────────

export class UnigoxClient {
  private loginWallet: Wallet | null;
  private email: string | null;
  private frontendUrl: string;
  private authMode: AuthMode;
  private tonPrivateKey: ParsedTonPrivateKey | null;
  private tonMnemonicWords: string[] | null;
  private tonAddressOverride: string | null;
  private tonWalletVersion: TonWalletVersion | null;
  private tonNetwork: string;
  private tonWalletAccount: TonWalletAccount | null = null;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;
  private userProfile: UserProfile | null = null;
  private readonly privySigner: PrivySigner;

  constructor(config: UnigoxClientConfig) {
    const loginPrivateKey = config.evmLoginPrivateKey;

    if (!loginPrivateKey && !config.email && !config.tonPrivateKey && !config.tonMnemonic && !config.sessionToken) {
      throw new Error(`UNIGOX auth is not configured. ${getUnigoxWalletConnectionPrompt()}`);
    }

    this.loginWallet = loginPrivateKey ? new Wallet(loginPrivateKey) : null;
    this.email = config.email || null;
    this.frontendUrl = config.frontendUrl || DEFAULT_FRONTEND_URL;
    this.authMode = config.authMode || "auto";
    this.tonPrivateKey = parseTonPrivateKeyInput(config.tonPrivateKey) || null;
    this.tonMnemonicWords = this.parseTonMnemonic(config.tonMnemonic);
    this.tonAddressOverride = config.tonAddress ? this.normalizeTonAddress(config.tonAddress) : null;
    this.tonWalletVersion = normalizeTonWalletVersion(config.tonWalletVersion) || null;
    this.tonNetwork = config.tonNetwork || "-239";
    if (config.sessionToken) {
      this.token = config.sessionToken;
      this.tokenExpiresAt = config.sessionTokenExpiresAt && config.sessionTokenExpiresAt > Date.now()
        ? config.sessionTokenExpiresAt
        : Date.now() + 50 * 60 * 1000;
    }
    this.privySigner = new PrivySigner({
      baseUrl: config.privySigningUrl,
      getIdToken: async () => await this.getOrRefreshToken(),
    });
  }

  get address(): string {
    if (this.userProfile?.evm_address) return this.userProfile.evm_address;
    if (this.loginWallet) return this.loginWallet.address;
    throw new Error("No EVM address known yet. Log in first and read the account profile instead.");
  }

  private parseTonMnemonic(mnemonic?: string | string[]): string[] | null {
    if (!mnemonic) return null;
    const words = Array.isArray(mnemonic) ? mnemonic : mnemonic.trim().split(/\s+/);
    return words.filter(Boolean).length ? words.filter(Boolean) : null;
  }

  private normalizeTonAddress(address: string): string {
    return Address.parse(address).toRawString().toLowerCase();
  }

  private requireLoginWallet(): Wallet {
    if (!this.loginWallet) {
      throw new Error("EVM login requires the private key for the wallet you use to sign in on UNIGOX.");
    }
    return this.loginWallet;
  }

  private async getAccountEvmAddress(): Promise<string> {
    const profile = await this.ensureProfile();
    if (!profile.evm_address) {
      throw new Error("No EVM address found on the UNIGOX account profile.");
    }

    return profile.evm_address;
  }

  private resolveLoginMode(): ResolvedAuthMode {
    if (this.authMode === "evm") {
      if (!this.loginWallet) throw new Error("authMode=evm requires evmLoginPrivateKey or privateKey");
      return "evm";
    }

    if (this.authMode === "ton") {
      if (!this.tonPrivateKey && !this.tonMnemonicWords) throw new Error("authMode=ton requires tonPrivateKey or tonMnemonic");
      return "ton";
    }

    if (this.authMode === "email") {
      if (!this.email) throw new Error("authMode=email requires email");
      return "email";
    }

    if (this.loginWallet) return "evm";
    if (this.tonPrivateKey || this.tonMnemonicWords) return "ton";
    if (this.email) return "email";

    throw new Error(`Unable to resolve UNIGOX auth mode. ${getUnigoxWalletConnectionPrompt()}`);
  }

  private async ensureTonWalletAccount(): Promise<TonWalletAccount> {
    if (this.tonWalletAccount) return this.tonWalletAccount;
    if (!this.tonPrivateKey && !this.tonMnemonicWords) {
      throw new Error("TON auth requires tonPrivateKey or legacy tonMnemonic");
    }

    const keyPair = this.tonPrivateKey
      ? { publicKey: this.tonPrivateKey.publicKey, secretKey: this.tonPrivateKey.secretKey }
      : await mnemonicToWalletKey(this.tonMnemonicWords!);
    const workchain = this.tonAddressOverride ? Address.parse(this.tonAddressOverride).workChain : 0;
    const { matched, candidates } = resolveTonWalletCandidate({
      publicKey: keyPair.publicKey,
      workchain,
      address: this.tonAddressOverride || undefined,
      preferredVersion: this.tonWalletVersion || undefined,
    });

    if (!matched) {
      const candidateSummary = candidates.map((candidate) => `${candidate.version}:${candidate.address}`).join(", ");
      throw new Error(
        `The supplied TON key does not derive the exact TON address you provided across the supported wallet versions. ` +
        `Address: ${this.tonAddressOverride}. Tried: ${candidateSummary || "none"}.`
      );
    }

    this.tonWalletVersion = matched.version;
    if (this.tonAddressOverride && this.tonAddressOverride === matched.address) {
      console.log(`[UNIGOX] TON address matched local ${matched.version.toUpperCase()} derivation: ${matched.address}`);
    } else {
      console.log(`[UNIGOX] Using local TON ${matched.version.toUpperCase()} derivation: ${matched.address}`);
    }

    this.tonWalletAccount = {
      address: matched.address,
      network: this.tonNetwork,
      publicKey: Buffer.from(keyPair.publicKey).toString("hex"),
      secretKey: keyPair.secretKey,
      derivedAddress: matched.address,
      walletVersion: matched.version,
      stateInit: matched.stateInit,
    };

    return this.tonWalletAccount;
  }

  getTonWalletDerivation(): Pick<TonWalletAccount, "address" | "derivedAddress" | "walletVersion"> | undefined {
    if (!this.tonWalletAccount) return undefined;
    const { address, derivedAddress, walletVersion } = this.tonWalletAccount;
    return { address, derivedAddress, walletVersion };
  }

  async createTonLoginPayloadTokenPair(): Promise<{ payloadToken: string; payloadTokenHash: string }> {
    return this.generateTonPayloadTokenPair();
  }

  private async generateTonPayloadTokenPair(): Promise<TonPayloadTokenPair> {
    const res = await jsonFetch(`${this.frontendUrl}/api/ton-generate-payload`, { method: "POST" });
    if (!res?.payloadToken || !res?.payloadTokenHash) {
      throw new Error(`Failed to generate TON payload: ${JSON.stringify(res)}`);
    }
    return res as TonPayloadTokenPair;
  }

  private buildTonProofMessage(address: Address, proof: Pick<TonProofPayload, "timestamp" | "domain" | "payload">): Buffer {
    const domainBuf = Buffer.from(proof.domain.value, "utf8");
    const domainLen = Buffer.allocUnsafe(4);
    domainLen.writeUInt32LE(domainBuf.length);

    const workchain = Buffer.allocUnsafe(4);
    workchain.writeInt32BE(address.workChain);

    const timestamp = Buffer.allocUnsafe(8);
    timestamp.writeBigUInt64LE(BigInt(proof.timestamp));

    return Buffer.concat([
      Buffer.from("ton-proof-item-v2/", "utf8"),
      workchain,
      Buffer.from(address.hash),
      domainLen,
      domainBuf,
      timestamp,
      Buffer.from(proof.payload, "utf8"),
    ]);
  }

  private buildTonProof(address: string, payloadTokenHash: string, secretKey: Uint8Array): TonProofPayload {
    const domain = new URL(this.frontendUrl).host;
    const proofBase = {
      timestamp: Math.floor(Date.now() / 1000),
      domain: {
        lengthBytes: Buffer.byteLength(domain, "utf8"),
        value: domain,
      },
      payload: payloadTokenHash,
    };

    const addressObj = Address.parse(address);
    const message = this.buildTonProofMessage(addressObj, proofBase);
    const messageHash = crypto.createHash("sha256").update(message).digest();
    const fullMessage = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from("ton-connect", "utf8"), messageHash]);
    const result = crypto.createHash("sha256").update(fullMessage).digest();
    const signature = Buffer.from(nacl.sign.detached(result, secretKey)).toString("base64");

    return {
      ...proofBase,
      signature,
    };
  }

  private async finalizeAccountLogin(
    token: string,
    options: { walletAddress?: string; linkedTonAddress?: string } = {},
  ): Promise<string> {
    this.token = token;
    this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    this.userProfile = null;

    await jsonFetch(`${APIS.account}/account/login`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ...(options.walletAddress && { wallet_address: options.walletAddress }),
      }),
    });

    if (options.linkedTonAddress) {
      await this.updateLinkedTonAddress(options.linkedTonAddress, token);
    }

    return token;
  }

  private requireFreshToken(context = "This action"): string {
    if (!this.token || Date.now() >= this.tokenExpiresAt) {
      throw new Error(`${context} requires an active authenticated session. Re-authenticate first.`);
    }
    return this.token;
  }

  // ── Email Auth ──────────────────────────────────────────────

  /**
   * Step 1: Request a one-time password sent to the agent's email.
   * The agent reads the code from its own inbox.
   */
  async requestEmailOTP(): Promise<void> {
    if (!this.email) throw new Error("No email configured");
    await jsonFetch(`${this.frontendUrl}/api/passwordless-start`, {
      method: "POST",
      body: JSON.stringify({ connection: "email", email: this.email }),
    });
    console.log(`[UNIGOX] OTP sent to ${this.email}`);
  }

  /**
   * Step 2: Verify the OTP code (agent reads it from its own inbox) and get an auth token.
   * After this, the agent is logged into UNIGOX.
   */
  async verifyEmailOTP(code: string): Promise<string> {
    const res = await jsonFetch(`${this.frontendUrl}/api/verify-code`, {
      method: "POST",
      body: JSON.stringify({ username: this.email, otp: code, realm: "email" }),
    });
    if (!res.id_token) {
      throw new Error(`Email verification failed: ${JSON.stringify(res)}`);
    }

    console.log("[UNIGOX] Email login successful");
    return this.finalizeAccountLogin(res.id_token as string);
  }

  /**
   * Step 3: Generate a local EVM login wallet and link it to the email account.
   * Returns the login private key - the agent must store this securely.
   * This is NOT the separate UNIGOX-exported signing key used for in-app signed actions.
   */
  async generateAndLinkWallet(): Promise<{ address: string; privateKey: string }> {
    if (!this.token) throw new Error("Must be logged in first (call verifyEmailOTP)");
    const newWallet = Wallet.createRandom();

    // Sign SIWE message for wallet linking
    const domain = new URL(this.frontendUrl).host;
    const nonce = crypto.randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    const message = `${domain} wants you to sign in with your Ethereum account:\n${newWallet.address}\n\nSign in to Unigox\n\nURI: https://${domain}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
    const signature = await newWallet.signMessage(message);

    const res = await jsonFetch(`${this.frontendUrl}/api/link-wallet`, {
      method: "POST",
      body: JSON.stringify({
        wallet_address: newWallet.address,
        signature,
        message,
        primary_token: this.token,
      }),
    });

    if (!res.success) {
      throw new Error(`Wallet linking failed: ${JSON.stringify(res)}`);
    }

    this.loginWallet = newWallet;
    this.userProfile = null;
    console.log(`[UNIGOX] Wallet linked: ${newWallet.address}`);
    return { address: newWallet.address, privateKey: newWallet.privateKey };
  }

  async generateAndLinkTonWallet(): Promise<{ address: string; privateKey: string; walletVersion: TonWalletVersion; mnemonic: string }> {
    const primaryToken = this.requireFreshToken("generated TON wallet linking");
    const mnemonicWords = await mnemonicNew(24);
    const keyPair = await mnemonicToWalletKey(mnemonicWords);
    const { matched, candidates } = resolveTonWalletCandidate({
      publicKey: keyPair.publicKey,
      workchain: 0,
      preferredVersion: this.tonWalletVersion || undefined,
    });

    if (!matched) {
      const candidateSummary = candidates.map((candidate) => `${candidate.version}:${candidate.address}`).join(", ");
      throw new Error(`Generated TON wallet derivation failed. Tried: ${candidateSummary || "none"}.`);
    }

    const { payloadToken, payloadTokenHash } = await this.generateTonPayloadTokenPair();
    const proof = {
      ...this.buildTonProof(matched.address, payloadTokenHash, keyPair.secretKey),
      stateInit: matched.stateInit,
    };

    const res = await jsonFetch(`${this.frontendUrl}/api/ton-link`, {
      method: "POST",
      body: JSON.stringify({
        address: matched.address,
        network: this.tonNetwork,
        public_key: Buffer.from(keyPair.publicKey).toString("hex"),
        proof,
        payloadToken,
        primary_token: primaryToken,
      }),
    });

    if (!res?.success) {
      throw new Error(`Generated TON wallet linking failed: ${JSON.stringify(res)}`);
    }

    const normalizedPrivateKey = Buffer.from(keyPair.secretKey).toString("hex");
    this.tonPrivateKey = parseTonPrivateKeyInput(normalizedPrivateKey) || null;
    this.tonMnemonicWords = mnemonicWords;
    this.tonAddressOverride = matched.address;
    this.tonWalletVersion = matched.version;
    this.tonWalletAccount = {
      address: matched.address,
      network: this.tonNetwork,
      publicKey: Buffer.from(keyPair.publicKey).toString("hex"),
      secretKey: keyPair.secretKey,
      derivedAddress: matched.address,
      walletVersion: matched.version,
      stateInit: matched.stateInit,
    };

    await this.updateLinkedTonAddress(matched.address, primaryToken);
    this.userProfile = null;

    return {
      address: matched.address,
      privateKey: normalizedPrivateKey,
      walletVersion: matched.version,
      mnemonic: mnemonicWords.join(" "),
    };
  }

  async updateLinkedTonAddress(tonAddress: string, token = this.token): Promise<void> {
    if (!token) throw new Error("Not logged in. Authenticate first.");

    const normalizedTonAddress = this.normalizeTonAddress(tonAddress);
    await jsonFetch(`${APIS.account}/account/me`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ linked_ton_address: normalizedTonAddress }),
    });

    if (this.userProfile) {
      this.userProfile.linked_ton_address = normalizedTonAddress;
    }
  }

  async linkTonWallet(): Promise<{ address: string; merged: boolean; message: string }> {
    const primaryToken = this.requireFreshToken("TON wallet linking");
    const tonWallet = await this.ensureTonWalletAccount();
    const { payloadToken, payloadTokenHash } = await this.generateTonPayloadTokenPair();
    const proof = {
      ...this.buildTonProof(tonWallet.address, payloadTokenHash, tonWallet.secretKey),
      stateInit: tonWallet.stateInit,
    };

    const res = await jsonFetch(`${this.frontendUrl}/api/ton-link`, {
      method: "POST",
      body: JSON.stringify({
        address: tonWallet.address,
        network: tonWallet.network,
        public_key: tonWallet.publicKey,
        proof,
        payloadToken,
        primary_token: primaryToken,
      }),
    });

    if (!res?.success) {
      throw new Error(`TON wallet linking failed: ${JSON.stringify(res)}`);
    }

    await this.updateLinkedTonAddress(tonWallet.address, primaryToken);
    this.userProfile = null;

    return {
      address: tonWallet.address,
      merged: !!res.merged,
      message: res.message || "TON wallet linked to your account",
    };
  }

  // ── Auth ────────────────────────────────────────────────────────

  private async loginOnceWithEvm(): Promise<string> {
    const wallet = this.requireLoginWallet();
    const domain = new URL(this.frontendUrl).host;
    const nonce = crypto.randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    const message = `${domain} wants you to sign in with your Ethereum account:\n${wallet.address}\n\nSign in to Unigox\n\nURI: https://${domain}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
    const signature = await wallet.signMessage(message);

    const loginRes = await jsonFetch(`${this.frontendUrl}/api/web3-login`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: wallet.address, signature, message }),
    });

    if (!loginRes.id_token) {
      throw new Error(`Login failed: ${JSON.stringify(loginRes)}`);
    }

    return this.finalizeAccountLogin(loginRes.id_token as string, { walletAddress: wallet.address });
  }

  private async loginOnceWithTon(): Promise<string> {
    const tonWallet = await this.ensureTonWalletAccount();
    const { payloadToken, payloadTokenHash } = await this.generateTonPayloadTokenPair();
    const proof = {
      ...this.buildTonProof(tonWallet.address, payloadTokenHash, tonWallet.secretKey),
      stateInit: tonWallet.stateInit,
    };

    const loginRes = await jsonFetch(`${this.frontendUrl}/api/ton-login`, {
      method: "POST",
      body: JSON.stringify({
        address: tonWallet.address,
        network: tonWallet.network,
        public_key: tonWallet.publicKey,
        proof,
        payloadToken,
      }),
    });

    if (!loginRes.id_token) {
      throw new Error(`TON login failed: ${JSON.stringify(loginRes)}`);
    }

    return this.finalizeAccountLogin(loginRes.id_token as string, { linkedTonAddress: tonWallet.address });
  }

  async loginWithTonConnect(payload: TonConnectLoginPayload): Promise<string> {
    const loginRes = await jsonFetch(`${this.frontendUrl}/api/ton-login`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!loginRes.id_token) {
      throw new Error(`TON Connect login failed: ${JSON.stringify(loginRes)}`);
    }

    return this.finalizeAccountLogin(loginRes.id_token as string, {
      linkedTonAddress: this.normalizeTonAddress(payload.address),
    });
  }

  async approveTonConnectBrowserLogin(universalLink: string): Promise<{
    bridgeUrl: string;
    walletAddress: string;
    manifestUrl: string;
    tonProofPayload?: string;
  }> {
    const parsed = parseTonConnectUniversalLink(universalLink);
    const frontendHost = new URL(this.frontendUrl).host;
    const manifestHost = new URL(parsed.manifestUrl).host;
    if (manifestHost !== frontendHost) {
      throw new Error(`This TonConnect link targets ${manifestHost}, not ${frontendHost}.`);
    }

    const tonWallet = await this.ensureTonWalletAccount();
    const tonProof = parsed.tonProofPayload
      ? {
          ...this.buildTonProof(tonWallet.address, parsed.tonProofPayload, tonWallet.secretKey),
        }
      : undefined;

    const approved = await approveTonConnectUniversalLinkWithWallet({
      universalLink,
      walletAddress: tonWallet.address,
      network: tonWallet.network,
      publicKey: tonWallet.publicKey,
      stateInit: tonWallet.stateInit,
      ...(tonProof ? { tonProof } : {}),
    });

    return {
      bridgeUrl: approved.bridgeUrl,
      walletAddress: tonWallet.address,
      manifestUrl: approved.manifestUrl,
      tonProofPayload: approved.tonProofPayload,
    };
  }

  async approveEvmWalletConnectBrowserLogin(
    uri: string,
    options: {
      projectId: string;
      sessionKey?: string;
    },
  ): Promise<{
    sessionTopic?: string;
    pairingTopic?: string;
    requestedChains: string[];
    approvedChains: string[];
    requestedMethods: string[];
    handledMethods: string[];
    requestCount: number;
    walletAddress: string;
  }> {
    const parsed = parseWalletConnectUri(uri);
    const wallet = this.requireLoginWallet();

    const approved = await approveWalletConnectUriWithWallet({
      uri: parsed.uri,
      privateKey: wallet.privateKey,
      walletAddress: wallet.address,
      projectId: options.projectId,
      frontendUrl: this.frontendUrl,
      sessionKey: options.sessionKey,
    });

    return {
      ...approved,
      walletAddress: wallet.address,
    };
  }

  private async loginOnce(): Promise<string> {
    const mode = this.resolveLoginMode();

    if (mode === "evm") return this.loginOnceWithEvm();
    if (mode === "ton") return this.loginOnceWithTon();

    throw new Error(`Email auth requires OTP verification. ${getUnigoxWalletConnectionPrompt()} If you want to continue with email for now, call requestEmailOTP() and verifyEmailOTP(code) first.`);
  }

  async login(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const MAX_RETRIES = 5;
    const BASE_DELAY = 3000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.token = await this.loginOnce();
        if (attempt > 1) console.log(`[UNIGOX] Login succeeded on attempt ${attempt}`);
        return this.token;
      } catch (err: any) {
        console.error(`[UNIGOX] Login attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt === MAX_RETRIES) throw err;
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }

    throw new Error("Login failed: exhausted retries");
  }

  private isTokenExpired(res: any): boolean {
    return res?.message === "Invalid token" || res?.message === "Authentication required";
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) throw new Error("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  private async authedGet(baseUrl: string, path: string): Promise<any> {
    await this.login();
    const res = await jsonFetch(`${baseUrl}${path}`, { headers: this.authHeaders() });
    if (this.isTokenExpired(res)) {
      this.token = null;
      await this.login();
      return jsonFetch(`${baseUrl}${path}`, { headers: this.authHeaders() });
    }
    return res;
  }

  private async authedPost(baseUrl: string, path: string, body?: any): Promise<any> {
    await this.login();
    const res = await jsonFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: body ? JSON.stringify(body) : JSON.stringify({}),
    });
    if (this.isTokenExpired(res)) {
      this.token = null;
      await this.login();
      return jsonFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: this.authHeaders(),
        body: body ? JSON.stringify(body) : JSON.stringify({}),
      });
    }
    return res;
  }

  private async authedPatch(baseUrl: string, path: string, body: any): Promise<any> {
    await this.login();
    const res = await jsonFetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (this.isTokenExpired(res)) {
      this.token = null;
      await this.login();
      return jsonFetch(`${baseUrl}${path}`, {
        method: "PATCH",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });
    }
    return res;
  }

  private async authedDelete(baseUrl: string, path: string): Promise<any> {
    await this.login();
    const res = await fetch(`${baseUrl}${path}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    return res.json();
  }

  // ── User Profile ────────────────────────────────────────────────

  async getProfile(): Promise<UserProfile> {
    const res = await this.authedGet(APIS.account, "/account/me");
    const data = unwrap<any>(res);
    const user = data?.user || data;
    this.userProfile = {
      user_id: user.id,
      evm_address: user.evm_address,
      linked_wallet_address: user.linked_wallet_address,
      linked_ton_address: user.linked_ton_address,
      automated_escrow_address: user.automated_escrow_address,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      kyc_country_code: user.kyc_country_code,
      id_verification_status: user.id_verification_status,
      total_traded_volume_usd: Number(user.total_traded_volume_usd || 0),
    };
    return this.userProfile;
  }

  private async ensureProfile(): Promise<UserProfile> {
    if (!this.userProfile) await this.getProfile();
    return this.userProfile!;
  }

  // ── Payment Details ─────────────────────────────────────────────

  async listPaymentDetails(): Promise<PaymentDetail[]> {
    const res = await this.authedGet(APIS.account, "/account/payments/details");
    return Array.isArray(res?.data) ? res.data : [];
  }

  async getKycVerificationStatus(): Promise<KycVerificationData> {
    const res = await this.authedGet(APIS.verification, "/kyc");
    return unwrap<KycVerificationData>(res) || {};
  }

  async initializeKycVerification(params: {
    fullName: string;
    country: string;
  }): Promise<KycVerificationData> {
    const res = await this.authedPost(APIS.verification, "/kyc", {
      fullName: params.fullName,
      country: params.country,
    });
    return unwrap<KycVerificationData>(res) || {};
  }

  async createPaymentDetail(params: {
    paymentMethodId: number;
    paymentNetworkId: number;
    fiatCurrencyCode: string;
    details: Record<string, string>;
    countryCode?: string;
  }): Promise<PaymentDetail> {
    const res = await this.authedPost(APIS.account, "/account/payments/details", {
      payment_method_id: params.paymentMethodId,
      payment_network_id: params.paymentNetworkId,
      fiat_currency_code: params.fiatCurrencyCode,
      details: params.details,
      ...(params.countryCode && { country_code: params.countryCode }),
    });
    const detail = unwrap<PaymentDetail>(res);
    if (!detail?.id) throw new Error(`Failed to create payment detail: ${JSON.stringify(res)}`);
    return detail;
  }

  async updatePaymentDetail(id: number, details: Record<string, string>): Promise<any> {
    return this.authedPatch(APIS.account, `/account/payments/details/${id}`, { details });
  }

  async deletePaymentDetail(id: number): Promise<any> {
    return this.authedDelete(APIS.account, `/account/payments/details/${id}`);
  }

  /**
   * Find existing payment detail matching criteria, or create a new one.
   */
  async ensurePaymentDetail(params: {
    paymentMethodId: number;
    paymentNetworkId: number;
    fiatCurrencyCode: string;
    details: Record<string, string>;
  }): Promise<PaymentDetail> {
    const existing = await this.listPaymentDetails();
    const match = existing.find(d =>
      d.fiat_currency_code === params.fiatCurrencyCode &&
      d.payment_method?.id === params.paymentMethodId
    );

    if (match) {
      // Update if details differ
      const needsUpdate = Object.entries(params.details).some(
        ([k, v]) => match.details[k] !== v
      );
      if (needsUpdate) {
        await this.updatePaymentDetail(match.id, params.details);
        match.details = { ...match.details, ...params.details };
      }
      return match;
    }

    return this.createPaymentDetail(params);
  }

  // ── Convenience: KES M-PESA ─────────────────────────────────────

  async createKesMpesaDetail(fullName: string, phoneNumber: string): Promise<PaymentDetail> {
    return this.createPaymentDetail({
      paymentMethodId: 3,       // M-PESA
      paymentNetworkId: 37,     // Pesalink
      fiatCurrencyCode: "KES",
      details: { full_name: fullName, phone_number: phoneNumber },
    });
  }

  async ensureKesMpesaDetail(fullName: string, phoneNumber: string): Promise<PaymentDetail> {
    return this.ensurePaymentDetail({
      paymentMethodId: 3,
      paymentNetworkId: 37,
      fiatCurrencyCode: "KES",
      details: { full_name: fullName, phone_number: phoneNumber },
    });
  }

  // ── Trade Requests ──────────────────────────────────────────────

  async getPreflightQuote(params: {
    tradeType: "BUY" | "SELL";
    cryptoCurrencyCode?: string;
    fiatAmount: number;
    paymentDetailsId: number;
    tradePartner?: "licensed" | "p2p" | "all";
  }): Promise<PreflightQuote | undefined> {
    const query = new URLSearchParams({
      crypto_currency: params.cryptoCurrencyCode || "USDC",
      amount: String(params.fiatAmount),
      is_amount_in_fiat: "true",
      payment_details_id: String(params.paymentDetailsId),
      trade_type: params.tradeType,
      trade_partner: params.tradePartner || "licensed",
    });

    const res = await this.authedGet(APIS.trades, `/best-offer?${query.toString()}`);
    const data = unwrap<any>(res);
    const offer = data?.offer;
    if (!data?.found || !offer || offer.no_matching_offers) {
      return undefined;
    }

    const totalCryptoAmount = Number(offer.total_crypto_amount || 0);
    const vendorOfferRate = Number(offer.vendor_offer_rate || 0);
    if (!(totalCryptoAmount > 0) || !(vendorOfferRate > 0)) {
      return undefined;
    }

    return {
      quoteType: "estimate",
      source: "best_offer",
      cryptoCurrencyCode: offer.crypto_currency_code || params.cryptoCurrencyCode || "USDC",
      fiatCurrencyCode: offer.fiat_currency_code,
      fiatAmount: Number(offer.fiat_amount || params.fiatAmount || 0),
      totalCryptoAmount,
      feeCryptoAmount: Number(offer.fee_crypto_amount || 0),
      vendorOfferRate,
      paymentMethodName: offer.payment_method?.name,
      paymentNetworkName: offer.payment_network?.name,
    };
  }

  async createTradeRequest(params: {
    tradeType: "BUY" | "SELL";
    cryptoCurrencyCode?: string;
    fiatCurrencyCode: string;
    fiatAmount: number;
    cryptoAmount: number;
    paymentDetailsId: number;
    paymentMethodId: number;
    paymentNetworkId: number;
    preferredVendor?: string;
    tradePartner?: "licensed" | "p2p" | "all";
  }): Promise<TradeRequest> {
    const body = {
      crypto_currency_code: params.cryptoCurrencyCode || "USDC",
      fiat_currency_code: params.fiatCurrencyCode,
      trade_type: params.tradeType,
      amount: params.tradeType === "SELL" ? params.cryptoAmount : params.fiatAmount,
      payment_details_id: params.paymentDetailsId,
      best_deal_fiat_amount: params.fiatAmount,
      best_deal_crypto_amount: params.cryptoAmount,
      payment_method_id: params.paymentMethodId,
      payment_network_id: params.paymentNetworkId,
      trade_partner: params.tradePartner || "licensed",
      ...(params.preferredVendor && { preferred_vendor_username: params.preferredVendor }),
    };

    const res = await this.authedPost(APIS.trades, "/trade_request", body);
    const tr = unwrap<TradeRequest>(res);
    if (!tr?.id) throw new Error(`Failed to create trade request: ${JSON.stringify(res)}`);
    return tr;
  }

  async getTradeRequest(id: number): Promise<TradeRequest> {
    const res = await this.authedGet(APIS.trades, `/trade_request/${id}`);
    return unwrap<TradeRequest>(res);
  }

  async listInitiatorTrades(filter: "action_required" | "waiting_other_party" | "history" = "action_required"): Promise<InitiatorTradeSummary[]> {
    const res = await this.authedGet(APIS.trades, `/trades?mode=bulk&filter=${filter}&roles=initiator:SELL,initiator:BUY`);
    const data = unwrap<{ trades?: InitiatorTradeSummary[] }>(res);
    return Array.isArray(data?.trades) ? data.trades : [];
  }

  async waitForTradeMatch(tradeRequestId: number, timeoutMs = 120_000): Promise<TradeRequest> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tr = await this.getTradeRequest(tradeRequestId);
      if (tr.status === "accepted_by_vendor" && tr.trade?.id) return tr;
      if (tr.status === "new_price_confirming_by_initiator") return tr;
      if (["canceled_by_initiator", "not_accepted_by_any_vendor", "matching_timeout_reached", "escrow_deployment_failed"].includes(tr.status)) {
        throw new Error(`Trade request ${tradeRequestId} ended: ${tr.status}`);
      }
      await sleep(2000);
    }
    throw new Error(`Trade request ${tradeRequestId} timed out after ${timeoutMs / 1000}s`);
  }

  async confirmTradeRequestPrice(tradeRequestId: number): Promise<TradeRequest> {
    const res = await this.authedPost(APIS.trades, `/trade_request/${tradeRequestId}/confirm-price`, {});
    return unwrap<TradeRequest>(res);
  }

  async refuseTradeRequestPrice(tradeRequestId: number): Promise<TradeRequest> {
    const res = await this.authedPost(APIS.trades, `/trade_request/${tradeRequestId}/refuse-price`, {});
    return unwrap<TradeRequest>(res);
  }

  async getTrade(tradeId: number): Promise<any> {
    const res = await this.authedGet(APIS.trades, `/trade/${tradeId}`);
    return unwrap<any>(res);
  }

  async getPartnerPaymentDetailsDiff(tradeId: number): Promise<PartnerPaymentDetailsDiffData> {
    const res = await this.authedGet(APIS.offers, `/payment-network-config/missing-partner-fields?trade_id=${tradeId}`);
    return unwrap<PartnerPaymentDetailsDiffData>(res);
  }

  async createOrUpdatePartnerPaymentDetails(params: {
    internalDetailsId: number;
    partner: string;
    details: Record<string, string>;
  }): Promise<PartnerPaymentDetailsRecord> {
    const res = await this.authedPost(APIS.account, "/account/payments/partner-payment-details", {
      internal_details_id: params.internalDetailsId,
      partner: params.partner,
      details: params.details,
    });
    return unwrap<PartnerPaymentDetailsRecord>(res);
  }

  async revalidateTradePaymentDetails(tradeId: number): Promise<{ trade?: any }> {
    const res = await this.authedPost(APIS.trades, `/trade/${tradeId}/revalidate-payment-details`, {});
    return unwrap<{ trade?: any }>(res);
  }

  private normalizeTypedDataTypes(types: Record<string, Array<{ name: string; type: string }>>): Record<string, Array<{ name: string; type: string }>> {
    const next = { ...types };
    delete next.EIP712Domain;
    return next;
  }

  private async createTradeActionSignature(tradeId: number, direction: "to_buyer" | "to_seller"): Promise<{ signature: string; signedData: unknown }> {
    const res = await this.authedGet(APIS.trades, `/trade/${tradeId}/signature-data?direction=${direction}`);
    const payload = unwrap<TradeSignaturePayload>(res);
    if (!payload?.domain || !payload?.types || !payload?.safe_params) {
      throw new Error(`Failed to load trade signature payload for trade ${tradeId}: ${JSON.stringify(res)}`);
    }

    const types = this.normalizeTypedDataTypes(payload.types);
    const message = payload.safe_params as Record<string, unknown>;
    const domain = payload.domain as Record<string, unknown>;

    // Dispatch by primary type — SafeTx routes to the safe-tx endpoint, which
    // applies the canonical zero-defaults; everything else goes through the
    // generic typed-data endpoint.
    let signature: string;
    if (types.SafeTx) {
      signature = await this.privySigner.signSafeTxFromTypedData({ domain, message });
    } else {
      const primaryType = Object.keys(types)[0];
      if (!primaryType) {
        throw new Error("Trade signature payload has no primary type");
      }
      const chainIdRaw = domain.chainId;
      const chainId = typeof chainIdRaw === "number"
        ? chainIdRaw
        : typeof chainIdRaw === "string"
          ? Number(chainIdRaw)
          : NaN;
      if (!Number.isFinite(chainId)) {
        throw new Error("Trade signature payload domain.chainId is missing or invalid");
      }
      const from = await this.getAccountEvmAddress();
      const result = await this.privySigner.signTypedData({
        chainId,
        from,
        domain,
        types: types as Record<string, unknown>,
        primaryType,
        message,
      });
      signature = result.signature;
    }

    return {
      signature,
      signedData: payload.safe_params.data,
    };
  }

  async confirmFiatReceived(tradeId: number): Promise<any> {
    const signed = await this.createTradeActionSignature(tradeId, "to_buyer");
    const res = await this.authedPost(APIS.trades, `/trade/${tradeId}/confirm-payment`, {
      signature: signed.signature,
      signed_data: signed.signedData,
    });
    return unwrap<any>(res);
  }

  // ── Wallet Balances (on-chain, XAI) ─────────────────────────────

  async getWalletBalance(): Promise<WalletBalance> {
    const evmAddress = await this.getAccountEvmAddress();
    const provider = new ethers.JsonRpcProvider(XAI_RPC);

    const usdcContract = new ethers.Contract(TOKENS.USDC.address, ["function balanceOf(address) view returns (uint256)"], provider);
    const usdtContract = new ethers.Contract(TOKENS.USDT.address, ["function balanceOf(address) view returns (uint256)"], provider);

    const [usdcRaw, usdtRaw] = await Promise.all([
      usdcContract.balanceOf(evmAddress),
      usdtContract.balanceOf(evmAddress),
    ]);

    const usdc = Number(ethers.formatUnits(usdcRaw, TOKENS.USDC.decimals));
    const usdt = Number(ethers.formatUnits(usdtRaw, TOKENS.USDT.decimals));

    return {
      usdc,
      usdt,
      totalUsd: usdc + usdt,
      assets: [
        { assetCode: "USDC", amount: usdc },
        { assetCode: "USDT", amount: usdt },
      ],
    };
  }

  // ── Automated Escrow (diagnostic / legacy only) ────────────────
  // send-money must not use automated escrow for transfers.
  // Live sends fund only the matched trade escrow address.

  async getEscrowBalance(tokenCode: "USDC" | "USDT" = "USDC"): Promise<EscrowBalance> {
    const profile = await this.ensureProfile();
    if (!profile.automated_escrow_address) {
      return { token: tokenCode, balance: 0, reserved: 0, available: 0 };
    }

    const provider = new ethers.JsonRpcProvider(XAI_RPC);
    const escrow = new ethers.Contract(profile.automated_escrow_address, [
      "function getBalance(address) view returns (uint256)",
      "function getReserved(address) view returns (uint256)",
    ], provider);

    const token = TOKENS[tokenCode];
    const [balRaw, resRaw] = await Promise.all([
      escrow.getBalance(token.address),
      escrow.getReserved(token.address),
    ]);

    const balance = Number(ethers.formatUnits(balRaw, token.decimals));
    const reserved = Number(ethers.formatUnits(resRaw, token.decimals));

    return { token: tokenCode, balance, reserved, available: balance - reserved };
  }

  private async ensureAutomatedEscrowAddress(): Promise<string> {
    const profile = await this.ensureProfile();
    if (profile.automated_escrow_address) return profile.automated_escrow_address;

    const res = await this.authedPost(APIS.escrow, "/automated-escrow/create", {});
    const createdAddress = unwrap<any>(res)?.address || res?.address;
    if (createdAddress) {
      this.userProfile = { ...profile, automated_escrow_address: createdAddress };
      return createdAddress;
    }

    this.userProfile = null;
    const refreshed = await this.getProfile();
    if (refreshed.automated_escrow_address) return refreshed.automated_escrow_address;

    throw new Error(`Failed to create automated escrow address: ${JSON.stringify(res)}`);
  }

  private async executeForwardedCall(from: string, to: string, data: string, value = "0", gas = "500000"): Promise<{ txId: number; txHash: string }> {
    const provider = new ethers.JsonRpcProvider(XAI_RPC);
    const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, provider);
    const nonce = await forwarder.nonces(from);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const forwardRequest = {
      from,
      to,
      value,
      gas,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      data,
    };

    const signature = await this.privySigner.signForwardRequestWithRetry({
      chainId: XAI_CHAIN_ID,
      forwarder: FORWARDER_ADDRESS,
      ...forwardRequest,
    });

    const txRes = await jsonFetch(`${APIS.transactor}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Transaction-Signature": signature },
      body: JSON.stringify({
        chain_id: XAI_CHAIN_ID.toString(),
        from: forwardRequest.from,
        to: forwardRequest.to,
        forwarder: FORWARDER_ADDRESS,
        value: forwardRequest.value,
        gas: forwardRequest.gas,
        nonce: forwardRequest.nonce,
        deadline: forwardRequest.deadline,
        data: forwardRequest.data,
      }),
    });

    const txId = txRes.id;
    const txHash = await this.pollTransaction(txId);
    return { txId, txHash };
  }

  async fundTradeEscrow(
    tokenCode: "USDC" | "USDT",
    amount: string,
    escrowAddress: string
  ): Promise<{ txId: number; txHash: string }> {
    const from = await this.getAccountEvmAddress();
    const token = TOKENS[tokenCode];
    const amountWei = ethers.parseUnits(amount, token.decimals);

    const transferIface = new ethers.Interface(["function transfer(address recipient, uint256 amount) returns (bool)"]);
    const transferCallData = transferIface.encodeFunctionData("transfer", [escrowAddress, amountWei]);
    return this.executeForwardedCall(from, token.address, transferCallData);
  }

  // ── Automated Escrow Withdraw (diagnostic / legacy only) ───────

  async withdrawFromEscrow(tokenCode: "USDC" | "USDT", amount: string): Promise<{ txId: number; txHash: string }> {
    const from = await this.getAccountEvmAddress();
    const automatedEscrowAddress = await this.ensureAutomatedEscrowAddress();

    const token = TOKENS[tokenCode];
    const amountWei = ethers.parseUnits(amount, token.decimals);

    // Build withdraw calldata
    const iface = new ethers.Interface(["function withdraw(address token, uint256 amount) returns (bool)"]);
    const callData = iface.encodeFunctionData("withdraw", [token.address, amountWei]);
    return this.executeForwardedCall(from, automatedEscrowAddress, callData);
  }

  private async pollTransaction(txId: number, timeoutMs = 120_000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(1500);
      try {
        const status = await jsonFetch(`${APIS.transactor}/transactions/${txId}/status`);
        if (status.status === "FILLED") return status.tx_hash || status.txHash;
        if (status.status === "FAILED" || status.status === "REJECTED") {
          throw new Error(status.error || "Transaction failed");
        }
      } catch (err: any) {
        if (err.message?.includes("Transaction failed")) throw err;
        // 404 = not ready yet
      }
    }
    throw new Error(`Transaction ${txId} confirmation timeout`);
  }

  // ── Deposit Addresses ───────────────────────────────────────────

  async getDepositAddresses(): Promise<DepositAddresses> {
    const evmAddr = await this.getAccountEvmAddress();
    const res = await jsonFetch(`${APIS.quote}/deposit-addresses/${evmAddr}`);
    const data = unwrap<any>(res);
    if (data?.evmAddress) return data as DepositAddresses;
    // 404 = create
    const createRes = await jsonFetch(`${APIS.quote}/deposit-addresses/${evmAddr}`, { method: "POST" });
    return unwrap<DepositAddresses>(createRes);
  }

  // ── Bridge: Supported Chains & Tokens ───────────────────────────

  async getBridgeTokens(): Promise<TokenOnChain[]> {
    const res = await jsonFetch(`${APIS.currency}/bridge-cryptocurrencies`);
    return unwrap<TokenOnChain[]>(res);
  }

  async getSupportedDepositOptions(): Promise<SupportedDepositAssetOption[]> {
    return getFrontendSupportedDepositOptions(await this.getBridgeTokens());
  }

  async describeDepositSelection(selection: DepositFlowSelection): Promise<SupportedDepositChainOption & { depositAddress: string }> {
    const [tokens, depositAddresses] = await Promise.all([
      this.getBridgeTokens(),
      this.getDepositAddresses(),
    ]);
    return describeDepositAddressSelection(selection, tokens, depositAddresses);
  }

  // ── Bridge: Get Quote ───────────────────────────────────────────

  async getBridgeQuote(params: {
    fromChainId: number;
    toChainId: number;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    recipientAddress?: string;
    slippage?: number;
  }): Promise<BridgeQuote> {
    const userAddress = await this.getAccountEvmAddress();
    const searchParams = new URLSearchParams({
      fromChain: params.fromChainId.toString(),
      toChain: params.toChainId.toString(),
      fromToken: params.fromTokenAddress,
      toToken: params.toTokenAddress,
      amount: params.amount,
      userAddress,
      slippage: (params.slippage || 0.005).toString(),
      ...(params.recipientAddress && { recipientAddress: params.recipientAddress }),
    });

    const res = await jsonFetch(`${APIS.quote}/quote?${searchParams.toString()}`);
    return unwrap<BridgeQuote>(res);
  }

  // ── Bridge: Execute (withdraw from XAI to external chain) ───────

  async bridgeOut(params: {
    tokenCode: "USDC" | "USDT";
    toChainId: number;
    toTokenAddress: string;
    amount: string;
    recipientAddress?: string;
  }): Promise<{ quoteId: string; txId: number; txHash: string }> {
    const from = await this.getAccountEvmAddress();
    const token = TOKENS[params.tokenCode];
    const amountWei = ethers.parseUnits(params.amount, token.decimals).toString();

    // 1. Get quote
    const quote = await this.getBridgeQuote({
      fromChainId: XAI_CHAIN_ID,
      toChainId: params.toChainId,
      fromTokenAddress: token.address,
      toTokenAddress: params.toTokenAddress,
      amount: amountWei,
      recipientAddress: params.recipientAddress || from,
    });

    if (!quote.snapshot.isLiquiditySufficient) {
      throw new Error("Insufficient bridge liquidity");
    }

    // 2. Execute the bridge tx via transactor (the quote txData contains the bridge calldata)
    const provider = new ethers.JsonRpcProvider(XAI_RPC);
    const forwarder = new ethers.Contract(FORWARDER_ADDRESS, ["function nonces(address) view returns (uint256)"], provider);
    const nonce = await forwarder.nonces(from);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // The quote parameters contain the target contract and calldata
    const forwardRequest = {
      from,
      to: from, // bridge txs go through the solver/forwarder path
      value: quote.parameters.txData?.value || "0",
      gas: "500000",
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      data: quote.parameters.txData?.data || "0x",
    };

    const signature = await this.privySigner.signForwardRequestWithRetry({
      chainId: XAI_CHAIN_ID,
      forwarder: FORWARDER_ADDRESS,
      ...forwardRequest,
    });

    const txRes = await jsonFetch(`${APIS.transactor}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Transaction-Signature": signature },
      body: JSON.stringify({
        chain_id: XAI_CHAIN_ID.toString(),
        from: forwardRequest.from,
        to: forwardRequest.to,
        forwarder: FORWARDER_ADDRESS,
        value: forwardRequest.value,
        gas: forwardRequest.gas,
        nonce: forwardRequest.nonce,
        deadline: forwardRequest.deadline,
        data: forwardRequest.data,
      }),
    });

    const txHash = await this.pollTransaction(txRes.id);
    return { quoteId: quote.quoteId, txId: txRes.id, txHash };
  }

  // ── Static: Token + Chain lookups ───────────────────────────────

  static get TOKENS() { return TOKENS; }
  static get APIS() { return APIS; }
  static get XAI_CHAIN_ID() { return XAI_CHAIN_ID; }
}

// ── Default export ──────────────────────────────────────────────────
export default UnigoxClient;

// ── Settings ─────────────────────────────────────────────────

export interface AgenticPaymentsSettings {
  /** Trade partner preference: "licensed" (default), "p2p", or "all" */
  tradePartner: "licensed" | "p2p" | "all";
}

const DEFAULT_SETTINGS: AgenticPaymentsSettings = {
  tradePartner: "licensed",
};

// ── Dynamic Payment Methods (from API) ───────────────────────

export interface PaymentMethodInfo {
  id: number;
  name: string;
  slug: string;
  type: string;
  typeSlug: string;
  fiatCurrencyCodes: string[];
  networks: PaymentNetworkInfo[];
}

export interface PaymentNetworkInfo {
  id: number;
  name: string;
  slug: string;
  fiatCurrencyCode: string;
  default: boolean;
}

export interface CurrencyPaymentData {
  currency: { code: string; name: string };
  paymentMethods: PaymentMethodInfo[];
}

export interface NetworkWithMethods {
  id: number;
  name: string;
  slug: string;
  fiatCurrencyCode: string;
  methods: PaymentMethodInfo[];
}

export interface CurrencyNetworkData {
  currency: { code: string; name: string };
  networks: NetworkWithMethods[];
}

/**
 * Fetch available payment methods for a currency (public, no auth needed).
 */
export async function getPaymentMethodsForCurrency(currency: string): Promise<CurrencyPaymentData> {
  const res = await jsonFetch(
    `${APIS.offers}/get-currency-and-payment-methods-with-networks?currency=${currency}`,
    { method: "GET" }
  );
  const data = res?.data || res;
  return {
    currency: { code: data.currency?.code || currency, name: data.currency?.name || currency },
    paymentMethods: (data.payment_methods || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      type: m.payment_method_type?.name || "",
      typeSlug: m.payment_method_type?.slug || "",
      fiatCurrencyCodes: m.fiat_currency_codes || [],
      networks: (m.payment_networks || []).map((n: any) => ({
        id: n.id,
        name: n.name,
        slug: n.slug,
        fiatCurrencyCode: n.fiat_currency_code || currency,
        default: !!n.default,
      })),
    })),
  };
}

/**
 * Fetch payment networks with their methods for a currency (public, no auth needed).
 */
export async function getPaymentNetworksForCurrency(currency: string): Promise<CurrencyNetworkData> {
  const res = await jsonFetch(
    `${APIS.offers}/get-currency-and-payment-networks-with-methods?currency=${currency}`,
    { method: "GET" }
  );
  const data = res?.data || res;
  return {
    currency: { code: data.currency?.code || currency, name: data.currency?.name || currency },
    networks: (data.payment_networks || []).map((n: any) => ({
      id: n.id,
      name: n.name,
      slug: n.slug,
      fiatCurrencyCode: n.fiat_currency_code || currency,
      methods: (n.payment_methods || []).map((m: any) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        type: m.payment_method_type?.name || "",
        typeSlug: m.payment_method_type?.slug || "",
        fiatCurrencyCodes: [m.fiat_currency_code || currency],
        networks: [],
      })),
    })),
  };
}

// ── Network Field Config (from API) ─────────────────────────

export interface NetworkFieldValidator {
  validatorName: string;
  pattern?: string;
  message?: string;
}

export interface NetworkFieldConfig {
  field: string;
  label: string;
  description: string;
  placeholder: string;
  type: string;
  required: boolean;
  validators: NetworkFieldValidator[];
}

export interface NetworkConfig {
  slug: string;
  name: string;
  description: string;
  countryCode?: string;
  fields: NetworkFieldConfig[];
  paymentMethodFormats?: Record<string, string>;
  paymentMethodTypeFormats?: Record<string, string>;
}

export interface NetworkFormat {
  id: string;
  name: string;
  description?: string;
  fields: NetworkFieldConfig[];
}

/**
 * Fetch required input fields for a payment network (public, no auth needed).
 * Returns top-level fields if present, otherwise returns formats (e.g. "banks", "mobile-money").
 * The agent should pick the right format based on the payment method type.
 */
export async function getNetworkFieldConfig(networkSlug: string): Promise<NetworkConfig & { formats: NetworkFormat[] }> {
  const res = await jsonFetch(
    `${APIS.offers}/payment-networks/${networkSlug}`,
    { method: "GET" }
  );
  const data = res?.data?.network || res?.network || res?.data || res;

  const mapFields = (fields: any[]) => (fields || []).map((f: any) => ({
    field: f.field,
    label: f.label,
    description: f.description || "",
    placeholder: f.placeholder || "",
    type: f.type || "text",
    required: !!f.required,
    validators: Array.isArray(f.validators)
      ? f.validators.map((validator: any) => ({
          validatorName: validator.validatorName || validator.validator_name,
          pattern: validator.pattern,
          message: validator.message,
        })).filter((validator: NetworkFieldValidator) => !!validator.validatorName)
      : [],
  }));

  const topFields = mapFields(data.fields);
  const formats = (data.formats || []).map((fmt: any) => ({
    id: fmt.id,
    name: fmt.name,
    description: fmt.description,
    fields: mapFields(fmt.fields),
  }));

  // Only expose fallback fields when the network has a single unambiguous format.
  // If a network exposes multiple formats (for example Pesalink supports bank,
  // mobile money, and M-PESA Paybill), callers should resolve the correct fields
  // for the specific payment method via `getPaymentMethodFieldConfig()` below.
  const effectiveFields = topFields.length > 0
    ? topFields
    : formats.length === 1
      ? formats[0].fields
      : [];

  return {
    slug: data.slug || networkSlug,
    name: data.name || networkSlug,
    description: data.description || "",
    countryCode: data.countryCode || data.country_code,
    fields: effectiveFields,
    formats,
    paymentMethodFormats: data.paymentMethodFormats || data.payment_method_formats,
    paymentMethodTypeFormats: data.paymentMethodTypeFormats || data.payment_method_type_formats,
  };
}

const FRONTEND_VALIDATOR_FALLBACKS: Record<
  string,
  { pattern?: RegExp; message: string; customValidator?: (value: string) => boolean | { valid: boolean; message: string } }
> = {
  iban: {
    pattern: /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/,
    message: "Invalid IBAN format",
  },
  swiftCode: {
    pattern: /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
    message: "Invalid SWIFT/BIC code format",
  },
  email: {
    pattern: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    message: "Invalid email format",
  },
  fullName: {
    pattern: /^[a-zA-ZÀ-ÿ\u0100-\u017F\u0400-\u04FF\s'-]{2,50}$/,
    message: "Full name should be 2-50 characters and contain only letters, spaces, hyphens, and apostrophes",
  },
  upiId: {
    pattern: /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/,
    message: "UPI ID must be in format user@bank (e.g., user@icici)",
  },
  ifscCode: {
    pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    message: "IFSC code must be 11 characters (e.g., HDFC0001234)",
  },
  internationalPhone: {
    customValidator: (value: string) => {
      const cleanValue = value.replace(/[^\d+]/g, "");
      const e164Pattern = /^\+[1-9]\d{6,14}$/;
      if (!e164Pattern.test(cleanValue)) {
        return {
          valid: false,
          message: "Phone number must be in international format (+country code followed by 7-15 digits)",
        };
      }
      return { valid: true, message: "" };
    },
    message: "Invalid international phone number format",
  },
  indiaPhone: {
    customValidator: (value: string) => {
      const cleanValue = value.replace(/[^\d+]/g, "");
      const indiaPattern = /^(\+91\d{10}|91\d{10}|\d{10})$/;
      if (!indiaPattern.test(cleanValue)) {
        return {
          valid: false,
          message: "Phone number must be in India format (+91 XXXXX XXXXX, 91 XXXXX XXXXX, or XXXXX XXXXX)",
        };
      }
      return { valid: true, message: "" };
    },
    message: "Invalid India phone number format",
  },
  indiaBankAccount: {
    customValidator: (value: string) => {
      const cleanValue = value.replace(/\D/g, "");
      if (cleanValue.length >= 10 && cleanValue.length <= 16 && /^\d+$/.test(cleanValue)) {
        return { valid: true, message: "" };
      }
      return {
        valid: false,
        message: "Account number must be 10-16 digits",
      };
    },
    message: "Invalid India bank account number format",
  },
};

const FIELD_NORMALIZERS: Record<string, (value: string) => string> = {
  iban: (value: string) => value.replace(/\s+/g, "").toUpperCase(),
  swift_code: (value: string) => value.replace(/\s+/g, "").toUpperCase(),
  ifsc_code: (value: string) => value.replace(/\s+/g, "").toUpperCase(),
  revtag: (value: string) => value.trim().replace(/^@/, ""),
};

export interface ResolvedPaymentMethodFieldConfig {
  currency: { code: string; name: string };
  method: PaymentMethodInfo;
  network: PaymentNetworkInfo;
  networkConfig: NetworkConfig & { formats: NetworkFormat[] };
  selectedFormatId?: string;
  fields: NetworkFieldConfig[];
}

export interface PaymentFieldValidationError {
  field: string;
  message: string;
}

export interface PaymentFieldValidationResult {
  valid: boolean;
  normalizedDetails: Record<string, string>;
  errors: PaymentFieldValidationError[];
}

function normalizeSlug(value: string | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findNormalizedMapValue(map: Record<string, string> | undefined, key: string | undefined): string | undefined {
  if (!map || !key) return undefined;
  const normalizedKey = normalizeSlug(key);
  const entry = Object.entries(map).find(([candidate]) => normalizeSlug(candidate) === normalizedKey);
  return entry?.[1];
}

function findFormatById(formats: NetworkFormat[], formatId: string | undefined): NetworkFormat | undefined {
  if (!formatId) return undefined;
  const normalizedId = normalizeSlug(formatId);
  return formats.find((format) => normalizeSlug(format.id) === normalizedId);
}

export function selectFieldsForPaymentMethod(
  method: Pick<PaymentMethodInfo, "slug" | "typeSlug">,
  networkConfig: NetworkConfig & { formats: NetworkFormat[] }
): { selectedFormatId?: string; fields: NetworkFieldConfig[] } {
  if (networkConfig.formats.length > 0) {
    const methodFormatId = findNormalizedMapValue(networkConfig.paymentMethodFormats, method.slug);
    const methodFormat = findFormatById(networkConfig.formats, methodFormatId);
    if (methodFormat) {
      return {
        selectedFormatId: methodFormat.id,
        fields: methodFormat.fields,
      };
    }

    const typeFormatId = findNormalizedMapValue(networkConfig.paymentMethodTypeFormats, method.typeSlug);
    const typeFormat = findFormatById(networkConfig.formats, typeFormatId);
    if (typeFormat) {
      return {
        selectedFormatId: typeFormat.id,
        fields: typeFormat.fields,
      };
    }

    if (networkConfig.formats.length === 1) {
      return {
        selectedFormatId: networkConfig.formats[0].id,
        fields: networkConfig.formats[0].fields,
      };
    }
  }

  if (networkConfig.fields.length > 0) {
    return { fields: networkConfig.fields };
  }

  return { fields: [] };
}

export async function getPaymentMethodFieldConfig(params: {
  currency: string;
  methodSlug?: string;
  methodId?: number;
  networkSlug?: string;
  networkId?: number;
}): Promise<ResolvedPaymentMethodFieldConfig> {
  const currencyData = await getPaymentMethodsForCurrency(params.currency);
  const method = currencyData.paymentMethods.find((entry) =>
    params.methodId ? entry.id === params.methodId : normalizeSlug(entry.slug) === normalizeSlug(params.methodSlug)
  );

  if (!method) {
    throw new Error(
      `Payment method ${params.methodSlug || params.methodId || "<unknown>"} not found for ${params.currency}`
    );
  }

  const network = params.networkId
    ? method.networks.find((entry) => entry.id === params.networkId)
    : params.networkSlug
      ? method.networks.find((entry) => normalizeSlug(entry.slug) === normalizeSlug(params.networkSlug))
      : method.networks.find((entry) => entry.default) || method.networks[0];

  if (!network) {
    throw new Error(`No payment network found for method ${method.name} (${params.currency})`);
  }

  const networkConfig = await getNetworkFieldConfig(network.slug);
  const resolved = selectFieldsForPaymentMethod(method, networkConfig);

  return {
    currency: currencyData.currency,
    method,
    network,
    networkConfig,
    selectedFormatId: resolved.selectedFormatId,
    fields: resolved.fields,
  };
}

function normalizeFieldValue(field: string, value: string): string {
  const normalizer = FIELD_NORMALIZERS[field];
  return normalizer ? normalizer(value) : value;
}

function validateAgainstApiValidator(value: string, validator: NetworkFieldValidator): string | undefined {
  if (validator.pattern) {
    try {
      const regex = new RegExp(validator.pattern);
      if (!regex.test(value)) {
        return validator.message || `Invalid ${validator.validatorName} format`;
      }
      return undefined;
    } catch {
      // Fall through to frontend-style named validator fallback.
    }
  }

  const fallback = FRONTEND_VALIDATOR_FALLBACKS[validator.validatorName];
  if (!fallback) {
    return undefined;
  }

  if (fallback.pattern && !fallback.pattern.test(value)) {
    return validator.message || fallback.message;
  }

  if (fallback.customValidator) {
    const result = fallback.customValidator(value);
    if (typeof result === "boolean") {
      if (!result) return validator.message || fallback.message;
    } else if (!result.valid) {
      return result.message || validator.message || fallback.message;
    }
  }

  return undefined;
}

export function validatePaymentDetailInput(
  details: Record<string, string>,
  fields: NetworkFieldConfig[],
  options: { countryCode?: string; formatId?: string } = {}
): PaymentFieldValidationResult {
  const errors: PaymentFieldValidationError[] = [];
  const normalizedDetails: Record<string, string> = {};

  for (const fieldConfig of fields) {
    const rawValue = details[fieldConfig.field];
    const trimmedValue = typeof rawValue === "string" ? rawValue.trim() : "";
    const normalizedValue = normalizeFieldValue(fieldConfig.field, trimmedValue);

    if (normalizedValue) {
      normalizedDetails[fieldConfig.field] = normalizedValue;
    }

    if (!normalizedValue) {
      if (fieldConfig.required) {
        errors.push({
          field: fieldConfig.field,
          message: `${fieldConfig.label || fieldConfig.field} is required`,
        });
      }
      continue;
    }

    for (const validator of fieldConfig.validators || []) {
      const error = validateAgainstApiValidator(normalizedValue, validator);
      if (error) {
        errors.push({
          field: fieldConfig.field,
          message: error,
        });
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    normalizedDetails,
    errors,
  };
}
