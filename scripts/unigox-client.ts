#!/usr/bin/env -S node --experimental-strip-types
/**
 * UNIGOX User Client — Standalone Module
 * 
 * Reusable levers for interacting with UNIGOX as a regular user (not vendor).
 * Designed to be imported by automation scripts, AI agent skills, and bots.
 * 
 * Features:
 *   - Wallet-based login with auto-refresh + retry
 *   - Payment details CRUD (create, read, update, delete)
 *   - Trade request creation + polling
 *   - Wallet balance (USDC, USDT on XAI chain)
 *   - Deposit addresses (EVM, Solana, Tron, TON)
 *   - Bridge out (withdraw to any supported chain)
 *   - Escrow withdraw (from automated escrow to wallet)
 *   - Supported chains + tokens listing
 * 
 * Usage:
 *   import { UnigoxClient } from "./unigox-client.ts";
 *   const client = new UnigoxClient({ privateKey: "0x..." });
 *   await client.login();
 *   const details = await client.listPaymentDetails();
 */

import { Wallet, ethers } from "ethers";

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_FRONTEND_URL = "https://www.unigox.com";

const APIS = {
  trades:     "https://prod-trades-inrvj.ondigitalocean.app/api/v1",
  account:    "https://prod-account-gynob.ondigitalocean.app/api/v1",
  offers:     "https://prod-offers-jwek6.ondigitalocean.app/api/v1",
  escrow:     "https://prod-escrow-l2eom.ondigitalocean.app/api/v1",
  transactor: "https://transactorpoc-mi666.ondigitalocean.app/api/v1",
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
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount) returns (bool)",
] as const;

const FORWARDER_ABI = [
  "function nonces(address from) view returns (uint256)",
] as const;

// EIP-712 types for the Forwarder
const FORWARDER_DOMAIN = {
  name: "SyntheticAssetForwarder",
  version: "1",
  chainId: XAI_CHAIN_ID,
  verifyingContract: FORWARDER_ADDRESS,
};

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from",     type: "address" },
    { name: "to",       type: "address" },
    { name: "value",    type: "uint256" },
    { name: "gas",      type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data",     type: "bytes" },
  ],
};

// ── Types ───────────────────────────────────────────────────────────

export interface UnigoxClientConfig {
  privateKey?: string;
  email?: string;
  frontendUrl?: string;
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
  fiat_amount?: number;
  crypto_amount_to_buyer?: number;
  vendor_offer_rate?: number;
  trade?: { id: number; status: string };
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

export interface WalletBalance {
  usdc: number;
  usdt: number;
  totalUsd: number;
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
  automated_escrow_address?: string;
  username?: string;
}

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

// ── Client ──────────────────────────────────────────────────────────

export class UnigoxClient {
  private wallet: Wallet | null;
  private email: string | null;
  private frontendUrl: string;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;
  private userProfile: UserProfile | null = null;

  constructor(config: UnigoxClientConfig) {
    if (!config.privateKey && !config.email) {
      throw new Error("Either privateKey or email is required");
    }
    this.wallet = config.privateKey ? new Wallet(config.privateKey) : null;
    this.email = config.email || null;
    this.frontendUrl = config.frontendUrl || DEFAULT_FRONTEND_URL;
  }

  get address(): string {
    if (!this.wallet) throw new Error("No wallet configured. Complete email signup first.");
    return this.wallet.address;
  }

  // ── Email Auth ──────────────────────────────────────────────

  /**
   * Step 1: Request a one-time password sent to the agent's email.
   * The owner must provide the OTP code to the agent.
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
   * Step 2: Verify the OTP code and get an auth token.
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
    this.token = res.id_token as string;
    this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;

    // Register with account service
    await jsonFetch(`${APIS.account}/account/login`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({}),
    });

    console.log("[UNIGOX] Email login successful");
    return this.token;
  }

  /**
   * Step 3: Generate a local wallet and link it to the email account.
   * Returns the private key - the agent must store this securely.
   */
  async generateAndLinkWallet(): Promise<{ address: string; privateKey: string }> {
    if (!this.token) throw new Error("Must be logged in first (call verifyEmailOTP)");
    const newWallet = Wallet.createRandom();

    // Sign SIWE message for wallet linking
    const domain = new URL(this.frontendUrl).host;
    const nonce = Math.random().toString(36).substring(7);
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

    this.wallet = newWallet;
    console.log(`[UNIGOX] Wallet linked: ${newWallet.address}`);
    return { address: newWallet.address, privateKey: newWallet.privateKey };
  }

  // ── Auth ────────────────────────────────────────────────────────

  private async loginOnce(): Promise<string> {
    if (!this.wallet) throw new Error("No wallet configured. Use email login flow instead.");
    const domain = new URL(this.frontendUrl).host;
    const nonce = Math.random().toString(36).substring(7);
    const issuedAt = new Date().toISOString();
    const message = `${domain} wants you to sign in with your Ethereum account:\n${this.address}\n\nSign in to Unigox\n\nURI: https://${domain}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
    const signature = await this.wallet.signMessage(message);

    const loginRes = await jsonFetch(`${this.frontendUrl}/api/web3-login`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: this.address, signature, message }),
    });

    if (!loginRes.id_token) {
      throw new Error(`Login failed: ${JSON.stringify(loginRes)}`);
    }

    const token = loginRes.id_token as string;

    // Register with account service
    await jsonFetch(`${APIS.account}/account/login`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wallet_address: this.address }),
    });

    return token;
  }

  async login(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const MAX_RETRIES = 5;
    const BASE_DELAY = 3000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.token = await this.loginOnce();
        this.tokenExpiresAt = Date.now() + 50 * 60 * 1000; // 50 min
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
      automated_escrow_address: user.automated_escrow_address,
      username: user.username,
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
  }): Promise<TradeRequest> {
    const body = {
      crypto_currency_code: params.cryptoCurrencyCode || "USDC",
      fiat_currency_code: params.fiatCurrencyCode,
      trade_type: params.tradeType,
      amount: params.fiatAmount,
      payment_details_id: params.paymentDetailsId,
      best_deal_fiat_amount: params.fiatAmount,
      best_deal_crypto_amount: params.cryptoAmount,
      payment_method_id: params.paymentMethodId,
      payment_network_id: params.paymentNetworkId,
      trade_partner: "all",
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

  async waitForTradeMatch(tradeRequestId: number, timeoutMs = 120_000): Promise<TradeRequest> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tr = await this.getTradeRequest(tradeRequestId);
      if (tr.status === "accepted_by_vendor" && tr.trade?.id) return tr;
      if (["canceled_by_initiator", "not_accepted_by_any_vendor", "matching_timeout_reached", "escrow_deployment_failed"].includes(tr.status)) {
        throw new Error(`Trade request ${tradeRequestId} ended: ${tr.status}`);
      }
      await sleep(2000);
    }
    throw new Error(`Trade request ${tradeRequestId} timed out after ${timeoutMs / 1000}s`);
  }

  async getTrade(tradeId: number): Promise<any> {
    const res = await this.authedGet(APIS.trades, `/trade/${tradeId}`);
    return unwrap<any>(res);
  }

  // ── Wallet Balances (on-chain, XAI) ─────────────────────────────

  async getWalletBalance(): Promise<WalletBalance> {
    const provider = new ethers.JsonRpcProvider(XAI_RPC);

    const usdcContract = new ethers.Contract(TOKENS.USDC.address, ["function balanceOf(address) view returns (uint256)"], provider);
    const usdtContract = new ethers.Contract(TOKENS.USDT.address, ["function balanceOf(address) view returns (uint256)"], provider);

    const [usdcRaw, usdtRaw] = await Promise.all([
      usdcContract.balanceOf(this.address),
      usdtContract.balanceOf(this.address),
    ]);

    const usdc = Number(ethers.formatUnits(usdcRaw, TOKENS.USDC.decimals));
    const usdt = Number(ethers.formatUnits(usdtRaw, TOKENS.USDT.decimals));

    return { usdc, usdt, totalUsd: usdc + usdt };
  }

  // ── Escrow Balances ─────────────────────────────────────────────

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

  // ── Escrow Withdraw (to wallet) ─────────────────────────────────

  async withdrawFromEscrow(tokenCode: "USDC" | "USDT", amount: string): Promise<{ txId: number; txHash: string }> {
    const profile = await this.ensureProfile();
    if (!profile.automated_escrow_address) throw new Error("No escrow address");

    const token = TOKENS[tokenCode];
    const amountWei = ethers.parseUnits(amount, token.decimals);

    // Build withdraw calldata
    const iface = new ethers.Interface(["function withdraw(address token, uint256 amount) returns (bool)"]);
    const callData = iface.encodeFunctionData("withdraw", [token.address, amountWei]);

    // Get nonce
    const provider = new ethers.JsonRpcProvider(XAI_RPC);
    const forwarder = new ethers.Contract(FORWARDER_ADDRESS, ["function nonces(address) view returns (uint256)"], provider);
    const nonce = await forwarder.nonces(this.address);

    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const forwardRequest = {
      from: this.address,
      to: profile.automated_escrow_address,
      value: "0",
      gas: "500000",
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      data: callData,
    };

    // Sign EIP-712
    const signature = await this.wallet.signTypedData(
      FORWARDER_DOMAIN,
      FORWARD_REQUEST_TYPES,
      forwardRequest,
    );

    // Submit to transactor
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

    // Poll for confirmation
    const txHash = await this.pollTransaction(txId);
    return { txId, txHash };
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
    const profile = await this.ensureProfile();
    const evmAddr = profile.evm_address || this.address;
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
    const searchParams = new URLSearchParams({
      fromChain: params.fromChainId.toString(),
      toChain: params.toChainId.toString(),
      fromToken: params.fromTokenAddress,
      toToken: params.toTokenAddress,
      amount: params.amount,
      userAddress: this.address,
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
    const token = TOKENS[params.tokenCode];
    const amountWei = ethers.parseUnits(params.amount, token.decimals).toString();

    // 1. Get quote
    const quote = await this.getBridgeQuote({
      fromChainId: XAI_CHAIN_ID,
      toChainId: params.toChainId,
      fromTokenAddress: token.address,
      toTokenAddress: params.toTokenAddress,
      amount: amountWei,
      recipientAddress: params.recipientAddress || this.address,
    });

    if (!quote.snapshot.isLiquiditySufficient) {
      throw new Error("Insufficient bridge liquidity");
    }

    // 2. Execute the bridge tx via transactor (the quote txData contains the bridge calldata)
    const provider = new ethers.JsonRpcProvider(XAI_RPC);
    const forwarder = new ethers.Contract(FORWARDER_ADDRESS, ["function nonces(address) view returns (uint256)"], provider);
    const nonce = await forwarder.nonces(this.address);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // The quote parameters contain the target contract and calldata
    const forwardRequest = {
      from: this.address,
      to: quote.parameters.txData ? this.address : this.address, // bridge txs go through solver
      value: quote.parameters.txData?.value || "0",
      gas: "500000",
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      data: quote.parameters.txData?.data || "0x",
    };

    const signature = await this.wallet.signTypedData(
      FORWARDER_DOMAIN,
      FORWARD_REQUEST_TYPES,
      forwardRequest,
    );

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
