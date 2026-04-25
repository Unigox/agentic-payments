/**
 * Privy Signer — HTTP client for the privy-signing backend.
 *
 * All on-chain signing (Forwarder ForwardRequests, Gnosis SafeTx, USDC EIP-3009
 * permits, Hyperliquid typed-data) is performed server-side. The skill never
 * holds a signing key; it just authenticates with the user's Auth0 idToken
 * (obtained at login via SIWE / TON proof / email OTP) and posts the unsigned
 * payload to one of four endpoints.
 *
 * Endpoint reference (mirrors unigox.com `utils/privy-signing.ts`):
 *
 *   POST /sign/forward-request   → { signature }
 *   POST /sign/safe-tx           → { signature }
 *   POST /sign/permit            → { v, r, s }
 *   POST /sign/typed-data        → { signature }
 *
 * Auth: Authorization: Bearer <idToken>; Content-Type: application/json
 */

const DEFAULT_PRIVY_SIGNING_URL = "https://privy-signing-prod-at922.ondigitalocean.app/api/v1";
const TIMEOUT_MS = 30_000;

export type IdTokenProvider = () => Promise<string> | string;

export interface PrivySignerOptions {
  /** Base URL of the privy-signing service. Falls back to PRIVY_SIGNING_URL env, then production default. */
  baseUrl?: string;
  /** Async-safe getter for the current Auth0 idToken. Called for every request. */
  getIdToken: IdTokenProvider;
  /** Optional fetch override (tests). */
  fetch?: typeof fetch;
}

export class PrivySigningError extends Error {
  readonly status: number;
  readonly endpoint?: string;
  constructor(status: number, message: string, endpoint?: string) {
    super(message);
    this.name = "PrivySigningError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

export interface ForwardRequestFields {
  from: string;
  to: string;
  value: string;
  gas: string;
  nonce: string;
  deadline: string;
  data: string;
}

export interface ForwardRequestInput extends ForwardRequestFields {
  forwarder: string;
  chainId: number;
}

export interface SafeTxFields {
  to: string;
  value: string;
  data: string;
  operation: number;
  /** Optional overrides — default to "0" / zero address per privy-signing spec. */
  safeTxGas?: string;
  baseGas?: string;
  gasPrice?: string;
  gasToken?: string;
  refundReceiver?: string;
  nonce: string | number;
}

export interface SafeTxInput {
  chainId: number;
  safe: string;
  tx: SafeTxFields;
}

export interface PermitInput {
  chainId: number;
  token: string;
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 0x-prefixed 32-byte nonce. */
  nonce: string;
}

export interface TypedDataInput {
  chainId: number;
  from: string;
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class PrivySigner {
  private readonly baseUrl: string;
  private readonly getIdToken: IdTokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PrivySignerOptions) {
    this.baseUrl = (options.baseUrl
      || process.env.PRIVY_SIGNING_URL
      || process.env.NEXT_PUBLIC_PRIVY_SIGNING_URL
      || DEFAULT_PRIVY_SIGNING_URL).replace(/\/+$/, "");
    this.getIdToken = options.getIdToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const idToken = await this.getIdToken();
    if (!idToken) {
      throw new PrivySigningError(401, "No UNIGOX idToken available — sign in first.", path);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = res.statusText;
      try {
        const json = text ? JSON.parse(text) : null;
        if (json && typeof json.error === "string") message = json.error;
      } catch {
        if (text) message = text.slice(0, 300);
      }
      throw new PrivySigningError(res.status, message, path);
    }

    return res.json() as Promise<T>;
  }

  // ── ForwardRequest ──────────────────────────────────────────────

  async signForwardRequest(input: ForwardRequestInput): Promise<{ signature: string }> {
    return this.post("/sign/forward-request", {
      chain_id: input.chainId,
      forwarder: input.forwarder,
      request: {
        from: input.from,
        to: input.to,
        value: input.value,
        gas: input.gas,
        nonce: input.nonce,
        deadline: input.deadline,
        data: input.data,
      },
    });
  }

  /** signForwardRequest with a single 502 retry, mirroring the unigox.com client. */
  async signForwardRequestWithRetry(input: ForwardRequestInput): Promise<string> {
    try {
      const { signature } = await this.signForwardRequest(input);
      return signature;
    } catch (err) {
      if (err instanceof PrivySigningError && err.status === 502) {
        const { signature } = await this.signForwardRequest(input);
        return signature;
      }
      throw err;
    }
  }

  // ── SafeTx ──────────────────────────────────────────────────────

  async signSafeTx(input: SafeTxInput): Promise<{ signature: string }> {
    const tx = input.tx;
    return this.post("/sign/safe-tx", {
      chain_id: input.chainId,
      safe: input.safe,
      tx: {
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: tx.operation,
        safeTxGas: tx.safeTxGas ?? "0",
        baseGas: tx.baseGas ?? "0",
        gasPrice: tx.gasPrice ?? "0",
        gasToken: tx.gasToken ?? ZERO_ADDRESS,
        refundReceiver: tx.refundReceiver ?? ZERO_ADDRESS,
        nonce: String(tx.nonce),
      },
    });
  }

  /**
   * Sign an EIP-712 SafeTx given the typed-data shape returned by an API
   * (e.g. `GET /trade/{id}/signature-data`). Pulls the safe address from
   * `domain.verifyingContract` and the tx fields from `message`.
   */
  async signSafeTxFromTypedData(args: {
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  }): Promise<string> {
    const safe = args.domain?.verifyingContract;
    if (typeof safe !== "string" || !safe) {
      throw new Error("SafeTx: domain.verifyingContract (safe address) is missing");
    }
    const chainIdRaw = args.domain?.chainId;
    const chainId = typeof chainIdRaw === "number"
      ? chainIdRaw
      : typeof chainIdRaw === "string"
        ? Number(chainIdRaw)
        : NaN;
    if (!Number.isFinite(chainId)) {
      throw new Error("SafeTx: domain.chainId is missing or invalid");
    }

    const m = args.message as Partial<SafeTxFields>;
    if (typeof m.operation !== "number") {
      throw new Error("SafeTx: message.operation is missing or not a number");
    }
    if (m.to == null || m.value == null || m.data == null || m.nonce == null) {
      throw new Error("SafeTx: message is missing required fields (to/value/data/nonce)");
    }

    const { signature } = await this.signSafeTx({
      chainId,
      safe,
      tx: {
        to: String(m.to),
        value: String(m.value),
        data: String(m.data),
        operation: m.operation,
        safeTxGas: m.safeTxGas != null ? String(m.safeTxGas) : undefined,
        baseGas: m.baseGas != null ? String(m.baseGas) : undefined,
        gasPrice: m.gasPrice != null ? String(m.gasPrice) : undefined,
        gasToken: typeof m.gasToken === "string" ? m.gasToken : undefined,
        refundReceiver: typeof m.refundReceiver === "string" ? m.refundReceiver : undefined,
        nonce: String(m.nonce),
      },
    });
    return signature;
  }

  // ── EIP-3009 Permit ─────────────────────────────────────────────

  async signPermit(input: PermitInput): Promise<{ v: number; r: string; s: string }> {
    return this.post("/sign/permit", {
      chain_id: input.chainId,
      token: input.token,
      from: input.from,
      to: input.to,
      value: input.value,
      valid_after: input.validAfter,
      valid_before: input.validBefore,
      nonce: input.nonce,
    });
  }

  // ── Generic typed data (Hyperliquid + fallback) ────────────────

  async signTypedData(input: TypedDataInput): Promise<{ signature: string }> {
    return this.post("/sign/typed-data", {
      chain_id: input.chainId,
      from: input.from,
      domain: input.domain,
      types: input.types,
      primary_type: input.primaryType,
      message: input.message,
    });
  }
}

export const PRIVY_SIGNING_DEFAULT_URL = DEFAULT_PRIVY_SIGNING_URL;
