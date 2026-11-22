import assert from "node:assert/strict";
import test from "node:test";
import { TypedDataEncoder, Wallet, verifyTypedData } from "ethers";

import { PartnerApiClient, PartnerApiError, partnerApiRequest } from "./partner-api-client.ts";
import type { PartnerApiConfig } from "./partner-api-client.ts";

const API_URL = "https://api.example.test";
const SENDER_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ORDER_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const FORWARDER_ADDRESS = "0x6fFCF38bEc8c733b096958fcd2a8E31A00530EDC";
const TOKEN_ADDRESS = "0x37BF70ee0dC89a408De31B79cCCC3152F0C8AF43";
const ESCROW_ADDRESS = "0x3333333333333333333333333333333333333333";
const FIXED_NOW = new Date("2026-11-22T10:00:00Z");

/** One HTTP call observed by the fake transport. */
interface RecordedCall {
  /** HTTP method. */
  method: string;
  /** Path plus query string, without the host. */
  path: string;
  /** Request headers as sent. */
  headers: Record<string, string>;
  /** Parsed JSON body, or undefined when none was sent. */
  body?: any;
}

/**
 * Builds a fake `fetch` that answers from a routing table and records every call.
 *
 * @param routes Map from `"<METHOD> <path-with-query>"` to the response to give: HTTP status and
 *   JSON body. A route may be a function of the parsed request body.
 * @returns The fake `fetch` and the list of calls it received, in order.
 */
function createFakeFetch(
  routes: Record<string, { status: number; body: unknown } | ((body: any) => { status: number; body: unknown })>
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const route = routes[`${method} ${path}`];
    if (!route) {
      return new Response(JSON.stringify({ success: false, error: { code: "TEST_NO_ROUTE", message: path } }), { status: 599 });
    }
    const answer = typeof route === "function" ? route(body) : route;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Builds a client configuration around a fresh random wallet and a fake transport.
 *
 * @param fetchImpl Fake `fetch` from `createFakeFetch`.
 * @param overrides Fields to replace in the default configuration.
 * @returns The configuration and the wallet whose key it holds.
 */
function createConfig(fetchImpl: typeof fetch, overrides: Partial<PartnerApiConfig> = {}): { config: PartnerApiConfig; wallet: Wallet } {
  const wallet = new Wallet(Wallet.createRandom().privateKey);
  return {
    wallet,
    config: {
      apiUrl: API_URL,
      apiKey: "test-api-key",
      walletPrivateKey: wallet.privateKey,
      xaiRpcUrl: "https://rpc.example.test",
      senderEmail: "sender@example.test",
      fetchImpl,
      now: () => FIXED_NOW,
      ...overrides,
    },
  };
}

const SENDER_ROUTE = {
  "POST /api/v1/partner/users": {
    status: 201,
    body: { success: true, data: { user_uuid: SENDER_UUID, id: SENDER_UUID, email: "sender@example.test", kyc_status: "VERIFIED" } },
  },
};

test("partnerApiRequest sends the API key, omits undefined query values and returns data", async () => {
  const { fetchImpl, calls } = createFakeFetch({
    "GET /api/v1/supported/payment-rails?currency=EUR&direction=offramp": { status: 200, body: { success: true, data: { rails: [] } } },
  });

  const data = await partnerApiRequest<{ rails: unknown[] }>(
    { apiUrl: `${API_URL}/`, apiKey: "k", fetchImpl },
    { method: "GET", path: "/api/v1/supported/payment-rails", query: { currency: "EUR", direction: "offramp", country: undefined } }
  );

  assert.deepEqual(data, { rails: [] });
  assert.equal(calls[0].headers["X-API-Key"], "k");
});

test("partnerApiRequest reports the API's machine code for each failure shape", async () => {
  const { fetchImpl } = createFakeFetch({
    "GET /structured": { status: 409, body: { success: false, error: { code: "NO_OFFERS_AVAILABLE", message: "none", details: { fiat_currency: "XOF" } } } },
    "GET /text": { status: 400, body: { success: false, error: "Key: 'Rail' failed on the 'required' tag" } },
    "GET /key": { status: 401, body: { success: false, data: { error_key: "unauthorized" } } },
  });
  const transport = { apiUrl: API_URL, fetchImpl };

  await assert.rejects(partnerApiRequest(transport, { method: "GET", path: "/structured" }), (error: unknown) => {
    assert.ok(error instanceof PartnerApiError);
    assert.equal(error.code, "NO_OFFERS_AVAILABLE");
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { fiat_currency: "XOF" });
    return true;
  });
  await assert.rejects(partnerApiRequest(transport, { method: "GET", path: "/text" }), (error: unknown) => {
    assert.ok(error instanceof PartnerApiError);
    assert.equal(error.code, "HTTP_400");
    return true;
  });
  await assert.rejects(partnerApiRequest(transport, { method: "GET", path: "/key" }), (error: unknown) => {
    assert.ok(error instanceof PartnerApiError);
    assert.equal(error.code, "UNAUTHORIZED");
    return true;
  });
});

test("partnerApiRequest reports a transport failure as NETWORK_ERROR", async () => {
  const fetchImpl = (async () => { throw new Error("socket hang up"); }) as typeof fetch;

  await assert.rejects(partnerApiRequest({ apiUrl: API_URL, fetchImpl }, { method: "GET", path: "/x" }), (error: unknown) => {
    assert.ok(error instanceof PartnerApiError);
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.status, 0);
    return true;
  });
});

test("ensureSender registers the configured email once and reuses the result", async () => {
  const { fetchImpl, calls } = createFakeFetch(SENDER_ROUTE);
  const client = new PartnerApiClient(createConfig(fetchImpl).config);

  const first = await client.ensureSender();
  const second = await client.ensureSender();

  assert.deepEqual(first, { userUuid: SENDER_UUID, email: "sender@example.test", kycStatus: "VERIFIED" });
  assert.equal(second, first);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { user_ref: "sender@example.test", email: "sender@example.test" });
});

test("startKycHandoff submits the handoff method and returns the verification link", async () => {
  const { fetchImpl, calls } = createFakeFetch({
    ...SENDER_ROUTE,
    [`POST /api/v1/partner/users/${SENDER_UUID}/kyc-submissions`]: {
      status: 200,
      body: { success: true, data: { kyc_status: "IN_PROGRESS", verification_url: "https://verify.example.test/abc" } },
    },
  });
  const client = new PartnerApiClient(createConfig(fetchImpl).config);

  const verification = await client.startKycHandoff({ firstName: "Ada", lastName: "Obi", countryCode: "NG" });

  assert.equal(verification.status, "IN_PROGRESS");
  assert.equal(verification.verificationUrl, "https://verify.example.test/abc");
  assert.deepEqual(calls[1].body, {
    method: "handoff",
    data: { pii: { first_name: "Ada", last_name: "Obi", country_code: "NG" } },
  });
});

test("createPaymentDetails and quoteOfframp send the documented request bodies", async () => {
  const { fetchImpl, calls } = createFakeFetch({
    ...SENDER_ROUTE,
    [`POST /api/v1/partner/users/${SENDER_UUID}/payment-details`]: {
      status: 201,
      body: {
        success: true,
        data: { payment_details_id: "987", rail: "iban-sepa", currency: "EUR", institution_name: "Revolut", institution_id: "revolut", details: { iban: "EE382200221020145685", full_name: "John Doe" } },
      },
    },
    "POST /api/v1/partner/offramp/quote": {
      status: 200,
      body: {
        success: true,
        data: {
          quote_id: "q-1", rate: "0.90", crypto_amount: "55.60", fiat_amount: "50.00", expires_at: "2026-11-22T10:01:00Z",
          fee_breakdown: { platform_fee: "0.28", partner_fee: "0.00", total_fee: "0.28" },
          has_fiat_settlement_notification: true, delayed_settlement: false,
        },
      },
    },
  });
  const client = new PartnerApiClient(createConfig(fetchImpl).config);

  const saved = await client.createPaymentDetails({
    currency: "EUR",
    rail: "iban-sepa",
    institutionId: "revolut",
    details: { iban: "EE382200221020145685", full_name: "John Doe" },
  });
  const quote = await client.quoteOfframp({
    paymentDetailsId: saved.paymentDetailsId,
    cryptoCurrency: "USDC",
    fiatCurrency: "EUR",
    fiatAmount: "50.00",
    providerScope: "licensed_only",
  });

  assert.equal(saved.paymentDetailsId, "987");
  assert.deepEqual(calls[1].body, {
    currency: "EUR",
    rail: "iban-sepa",
    institution_id: "revolut",
    details: { iban: "EE382200221020145685", full_name: "John Doe" },
  });
  assert.deepEqual(calls[2].body, {
    user_uuid: SENDER_UUID,
    payment_details_id: 987,
    crypto_currency: "USDC",
    fiat_currency: "EUR",
    fiat_amount: "50.00",
    provider_scope: "licensed_only",
  });
  assert.equal(quote.quoteId, "q-1");
  assert.equal(quote.cryptoAmount, "55.60");
  assert.equal(quote.hasFiatSettlementNotification, true);
  assert.equal(quote.feeBreakdown.totalFee, "0.28");
});

test("getOrder maps status, actions and amounts", async () => {
  const { fetchImpl } = createFakeFetch({
    [`GET /api/v1/partner/orders/${ORDER_ID}`]: {
      status: 200,
      body: {
        success: true,
        data: {
          order_id: ORDER_ID,
          status: "awaiting_crypto_transfer_authorization",
          next_action: "update_kyc_address",
          allowed_actions: ["authorize-crypto-transfer", "cancel"],
          action_required: { type: "update_kyc_address", message: "internal wording", endpoint: "/kyc", fields: [{ field: "address", label: "Street address" }] },
          has_fiat_settlement_notification: false,
          delayed_settlement: false,
          crypto_transfer_authorization_seconds_left: 540,
          amounts: { crypto_amount: "55.60", crypto_currency: "USDC", fiat_amount: "50.00", fiat_currency: "EUR", rate: "0.90" },
        },
      },
    },
  });
  const client = new PartnerApiClient(createConfig(fetchImpl).config);

  const order = await client.getOrder(ORDER_ID);

  assert.equal(order.status, "awaiting_crypto_transfer_authorization");
  assert.equal(order.nextAction, "update_kyc_address");
  assert.deepEqual(order.allowedActions, ["authorize-crypto-transfer", "cancel"]);
  assert.deepEqual(order.actionRequired, { type: "update_kyc_address", fields: [{ field: "address", label: "Street address" }] });
  assert.equal(order.cryptoTransferAuthorizationSecondsLeft, 540);
  assert.equal(order.cryptoCurrency, "USDC");
});

test("authorizeCryptoTransfer signs the server-built transfer with the partner wallet", async () => {
  const { fetchImpl, calls } = createFakeFetch({});
  const { config, wallet } = createConfig(fetchImpl);
  const routed = createFakeFetch({
    [`GET /api/v1/partner/orders/${ORDER_ID}/transfer-authorization-parameters`]: {
      status: 200,
      body: {
        success: true,
        data: {
          order_id: ORDER_ID,
          chain_id: "660279",
          token_address: TOKEN_ADDRESS,
          forwarder_address: FORWARDER_ADDRESS,
          recipient_address: ESCROW_ADDRESS,
          sender_address: wallet.address,
          amount_atomic: "55600000",
          recommended_gas_limit: "500000",
          recommended_ttl_seconds: 3600,
          transfer_data: "0xa9059cbb",
          forwarder_nonce: "7",
        },
      },
    },
    [`POST /api/v1/partner/orders/${ORDER_ID}/authorize-crypto-transfer`]: { status: 200, body: { success: true, data: {} } },
  });
  const client = new PartnerApiClient({ ...config, fetchImpl: routed.fetchImpl });

  await client.authorizeCryptoTransfer(ORDER_ID);

  assert.equal(calls.length, 0);
  const submitted = routed.calls[1].body;
  assert.deepEqual(submitted.forward_request, {
    from: wallet.address,
    to: TOKEN_ADDRESS,
    value: "0",
    gas: "500000",
    nonce: "7",
    deadline: String(Math.floor(FIXED_NOW.getTime() / 1000) + 3600),
    data: "0xa9059cbb",
  });
  const signer = verifyTypedData(
    { name: "SyntheticAssetForwarder", version: "1", chainId: 660279, verifyingContract: FORWARDER_ADDRESS },
    {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    },
    submitted.forward_request,
    submitted.signature
  );
  assert.equal(signer, wallet.address);
});

test("authorizeCryptoTransfer refuses to sign for a wallet other than the configured one", async () => {
  const { fetchImpl, calls } = createFakeFetch({
    [`GET /api/v1/partner/orders/${ORDER_ID}/transfer-authorization-parameters`]: {
      status: 200,
      body: { success: true, data: { sender_address: "0x4444444444444444444444444444444444444444", token_address: TOKEN_ADDRESS } },
    },
  });
  const client = new PartnerApiClient(createConfig(fetchImpl).config);

  await assert.rejects(client.authorizeCryptoTransfer(ORDER_ID), (error: unknown) => {
    assert.ok(error instanceof PartnerApiError);
    assert.equal(error.code, "WALLET_MISMATCH");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("authorizeRefund signs the server-built Safe transaction and ignores a listed domain type", async () => {
  const types = {
    EIP712Domain: [
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const domain = { chainId: 660279, verifyingContract: ESCROW_ADDRESS };
  const safeParams = { to: TOKEN_ADDRESS, value: "0", data: "0xa9059cbb", nonce: "0" };
  const placeholder = createFakeFetch({});
  const { config, wallet } = createConfig(placeholder.fetchImpl);
  const { fetchImpl, calls } = createFakeFetch({
    [`GET /api/v1/partner/orders/${ORDER_ID}/refund-authorization-parameters`]: {
      status: 200,
      body: { success: true, data: { signer_address: wallet.address, recipient_address: wallet.address, safe_params: safeParams, domain, types } },
    },
    [`POST /api/v1/partner/orders/${ORDER_ID}/authorize-refund`]: { status: 200, body: { success: true, data: {} } },
  });
  const client = new PartnerApiClient({ ...config, fetchImpl });

  await client.authorizeRefund(ORDER_ID);

  const signature = calls[1].body.signature;
  const digest = TypedDataEncoder.hash(domain, { SafeTx: types.SafeTx }, safeParams);
  assert.equal(new Wallet(wallet.privateKey).signingKey.sign(digest).serialized, signature);
});

test("getWalletBalance reads funding tokens listed for the settlement chain", async () => {
  const { fetchImpl } = createFakeFetch({
    "GET /api/v1/supported/blockchains": {
      status: 200,
      body: {
        success: true,
        data: [
          { slug: "ethereum", crypto_currencies: [{ code: "USDC", contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }] },
          {
            slug: "xai",
            crypto_currencies: [
              { code: "USDC", contract: TOKEN_ADDRESS, decimals: 6 },
              { code: "USDT", contract: "0xf86Cc81F4E480CF54Eb013FFe6929a0C2Ad5EdCA", decimals: 6 },
            ],
          },
        ],
      },
    },
  });
  const reads: string[] = [];
  const { config, wallet } = createConfig(fetchImpl, {
    readErc20Balance: async ({ rpcUrl, tokenAddress, ownerAddress }) => {
      reads.push(`${rpcUrl}|${tokenAddress}|${ownerAddress}`);
      return tokenAddress === TOKEN_ADDRESS ? 125_500_000n : 0n;
    },
  });
  const client = new PartnerApiClient(config);

  const balance = await client.getWalletBalance();

  assert.equal(balance.walletAddress, wallet.address);
  assert.deepEqual(balance.assets, [
    { assetCode: "USDC", amount: 125.5 },
    { assetCode: "USDT", amount: 0 },
  ]);
  assert.equal(reads[0], `https://rpc.example.test|${TOKEN_ADDRESS}|${wallet.address}`);
});

test("getWalletBalance fails closed when the settlement chain does not list a funding token", async () => {
  const { fetchImpl } = createFakeFetch({
    "GET /api/v1/supported/blockchains": {
      status: 200,
      body: { success: true, data: [{ slug: "xai", crypto_currencies: [{ code: "USDC", contract: TOKEN_ADDRESS, decimals: 6 }] }] },
    },
  });
  const { config } = createConfig(fetchImpl, { readErc20Balance: async () => 0n });
  const client = new PartnerApiClient(config);

  await assert.rejects(client.getWalletBalance(), (error: unknown) => {
    assert.ok(error instanceof PartnerApiError);
    assert.equal(error.code, "SETTLEMENT_TOKEN_UNKNOWN");
    return true;
  });
});
