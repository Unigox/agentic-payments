import assert from "node:assert/strict";
import test from "node:test";

import { PartnerApiError } from "./partner-api-client.ts";
import type { PartnerApiClient, PartnerOrder, PartnerPaymentDetails, PartnerQuote } from "./partner-api-client.ts";
import { PartnerExecutionClient } from "./partner-execution-client.ts";
import { TransferExecutionError } from "./transfer-execution.ts";

const ORDER_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

/**
 * Builds an order with sensible defaults for an accepted, unfunded EUR payout.
 *
 * @param overrides Fields to replace.
 * @returns A complete `PartnerOrder`.
 */
function order(overrides: Partial<PartnerOrder> = {}): PartnerOrder {
  return {
    orderId: ORDER_ID,
    status: "awaiting_crypto_transfer_authorization",
    nextAction: "authorize_crypto_transfer",
    allowedActions: ["authorize-crypto-transfer", "cancel"],
    hasFiatSettlementNotification: false,
    delayedSettlement: false,
    cryptoAmount: "55.60",
    cryptoCurrency: "USDC",
    fiatAmount: "50.00",
    fiatCurrency: "EUR",
    rate: "0.90",
    ...overrides,
  };
}

/**
 * Builds a live quote with sensible defaults.
 *
 * @param overrides Fields to replace.
 * @returns A complete `PartnerQuote`.
 */
function quote(overrides: Partial<PartnerQuote> = {}): PartnerQuote {
  return {
    quoteId: "q-1",
    rate: "0.90",
    cryptoAmount: "55.60",
    fiatAmount: "50.00",
    feeBreakdown: { platformFee: "0.28", partnerFee: "0.00", totalFee: "0.28" },
    expiresAt: "2026-11-22T10:01:00Z",
    hasFiatSettlementNotification: false,
    delayedSettlement: false,
    ...overrides,
  };
}

/**
 * Builds an execution client over a partial fake of `PartnerApiClient`.
 *
 * @param api The API methods the test needs; any other method throws when called.
 * @returns The client under test, with an instant timer and a 1000 ms poll interval.
 */
function createClient(api: Partial<PartnerApiClient>): PartnerExecutionClient {
  return new PartnerExecutionClient(api as PartnerApiClient, {
    matchPollIntervalMs: 1000,
    sleep: async () => {},
  });
}

const TRADE_REQUEST_PARAMS = {
  cryptoCurrencyCode: "USDC",
  fiatCurrencyCode: "EUR",
  fiatAmount: 50,
  cryptoAmount: 55.6,
  paymentDetailsId: "987",
  tradePartner: "licensed" as const,
};

test("createTradeRequest quotes with the mapped provider scope and initiates when the price is within what was approved", async () => {
  const quoted: unknown[] = [];
  const initiated: string[] = [];
  const client = createClient({
    quoteOfframp: async (params) => { quoted.push(params); return quote(); },
    initiateOfframp: async (quoteId) => { initiated.push(quoteId); return order({ status: "awaiting_liquidity_provider", nextAction: undefined }); },
  });

  const request = await client.createTradeRequest(TRADE_REQUEST_PARAMS);

  assert.deepEqual(quoted, [{ paymentDetailsId: "987", cryptoCurrency: "USDC", fiatCurrency: "EUR", fiatAmount: "50", providerScope: "licensed_only" }]);
  assert.deepEqual(initiated, ["q-1"]);
  assert.equal(request.id, ORDER_ID);
  assert.equal(request.trade, undefined);
});

test("createTradeRequest places nothing and reports the live price when it costs more than was approved", async () => {
  let initiated = false;
  const client = createClient({
    quoteOfframp: async () => quote({ cryptoAmount: "55.61" }),
    initiateOfframp: async () => { initiated = true; return order(); },
  });

  const request = await client.createTradeRequest(TRADE_REQUEST_PARAMS);

  assert.equal(initiated, false);
  assert.equal(request.status, "new_price_confirming_by_initiator");
  assert.equal(request.id, "");
  assert.equal(request.total_crypto_amount, 55.61);
  assert.equal(request.fiat_amount, 50);
});

test("createTradeRequest maps refusals to the failures the flow handles", async () => {
  const cases: Array<[string, string]> = [
    ["KYC_NOT_CLEARED", "kyc_required"],
    ["NO_OFFERS_AVAILABLE", "no_match"],
    ["PRICE_CHANGED_REQUOTE", "price_changed"],
    ["QUOTE_EXPIRED", "price_changed"],
  ];
  for (const [code, reason] of cases) {
    const client = createClient({
      quoteOfframp: async () => { throw new PartnerApiError({ status: 422, code, message: "internal detail" }); },
    });
    await assert.rejects(client.createTradeRequest(TRADE_REQUEST_PARAMS), (error: unknown) => {
      assert.ok(error instanceof TransferExecutionError);
      assert.equal(error.reason, reason);
      return true;
    });
  }

  const delayed = createClient({ quoteOfframp: async () => quote({ delayedSettlement: true }) });
  await assert.rejects(delayed.createTradeRequest(TRADE_REQUEST_PARAMS), (error: unknown) => {
    assert.ok(error instanceof TransferExecutionError);
    assert.equal(error.reason, "no_match");
    return true;
  });

  const other = createClient({
    quoteOfframp: async () => { throw new PartnerApiError({ status: 500, code: "INTERNAL_ERROR", message: "boom" }); },
  });
  await assert.rejects(other.createTradeRequest(TRADE_REQUEST_PARAMS), PartnerApiError);
});

test("waitForTradeMatch returns once a provider accepts, and reports timeout and ended orders", async () => {
  const statuses = ["awaiting_liquidity_provider", "awaiting_liquidity_provider", "awaiting_crypto_transfer_authorization"];
  const accepting = createClient({ getOrder: async () => order({ status: statuses.shift()! }) });
  const matched = await accepting.waitForTradeMatch(ORDER_ID, 5000);
  assert.deepEqual(matched.trade, { id: ORDER_ID, status: "awaiting_escrow_funding_by_seller" });

  let reads = 0;
  const waiting = createClient({ getOrder: async () => { reads += 1; return order({ status: "awaiting_liquidity_provider", nextAction: undefined }); } });
  await assert.rejects(waiting.waitForTradeMatch(ORDER_ID, 2000), (error: unknown) => {
    assert.ok(error instanceof TransferExecutionError);
    assert.equal(error.reason, "match_timeout");
    return true;
  });
  assert.equal(reads, 3);

  const ended = createClient({ getOrder: async () => order({ status: "cancelled", nextAction: undefined }) });
  await assert.rejects(ended.waitForTradeMatch(ORDER_ID, 2000), (error: unknown) => {
    assert.ok(error instanceof TransferExecutionError);
    assert.equal(error.reason, "no_match");
    return true;
  });
});

test("getTrade maps order statuses to the settlement statuses the monitor classifies", async () => {
  const cases: Array<[Partial<PartnerOrder>, string, string[]]> = [
    [{}, "awaiting_escrow_funding_by_seller", ["action_fund_escrow"]],
    [{ status: "crypto_transfer_authorization_pending", nextAction: undefined }, "trade_created", []],
    [{ status: "crypto_received", nextAction: undefined }, "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer", []],
    [{ status: "fiat_payment_started", nextAction: undefined }, "fiat_payment_proof_submitted_by_buyer", []],
    [{ status: "fiat_payment_started", nextAction: undefined, hasFiatSettlementNotification: true }, "escrow_funded_or_reserved_awaiting_payment_proof_from_buyer", []],
    [{ status: "awaiting_fiat_received_confirmation", nextAction: "confirm_fiat_received" }, "fiat_payment_proof_accepted_by_system", []],
    [{ status: "crypto_release_pending", nextAction: undefined }, "fiat_payment_confirmed_by_seller_escrow_release_started", []],
    [{ status: "completed", nextAction: undefined }, "escrow_released_to_buyer", []],
    [{ status: "cancelled", nextAction: undefined }, "canceled_by_seller", []],
    [{ status: "cancelled", nextAction: "authorize_refund" }, "escrow_refund_authorization_required", ["action_authorize_refund"]],
    [{ status: "failed", nextAction: undefined }, "escrow_funding_error", []],
    [{ status: "dispute_started", nextAction: undefined }, "dispute_started", []],
    [{ status: "crypto_received", nextAction: "sign_settlement_consent", delayedSettlement: true }, "delayed_settlement_not_supported", []],
  ];
  for (const [overrides, expectedStatus, expectedActions] of cases) {
    const client = createClient({ getOrder: async () => order(overrides) });
    const trade = await client.getTrade(ORDER_ID);
    assert.equal(trade.status, expectedStatus, JSON.stringify(overrides));
    assert.deepEqual(trade.possible_actions, expectedActions, JSON.stringify(overrides));
  }
});

test("an order waiting for personal details is shown as a trade that needs extra payout details", async () => {
  const waiting = order({
    nextAction: "update_kyc_address",
    actionRequired: { type: "update_kyc_address", fields: [{ field: "address", label: "Street address" }, { field: "postal_code", label: "" }] },
  });
  const updates: Array<Record<string, string>> = [];
  const client = createClient({
    getOrder: async () => waiting,
    updateKycFields: async (fields) => { updates.push(fields); },
  });

  const trade = await client.getTrade(ORDER_ID);
  const diff = await client.getPartnerPaymentDetailsDiff(ORDER_ID);
  await client.createOrUpdatePartnerPaymentDetails({ internalDetailsId: "", partner: "unigox", details: { address: "Svitrigailos g 29" } });

  assert.equal(trade.status, "trade_created");
  assert.equal(trade.partner_short_name, "unigox");
  assert.equal(trade.partner_details_checked_at, null);
  assert.deepEqual(diff.differences.missing_fields, [
    { partner_field_name: "address", required: true, hint: "Street address" },
    { partner_field_name: "postal_code", required: true, hint: undefined },
  ]);
  assert.deepEqual(updates, [{ address: "Svitrigailos g 29" }]);
});

test("ensurePaymentDetail reuses equal saved details and saves new ones otherwise", async () => {
  const saved: PartnerPaymentDetails = {
    paymentDetailsId: "987",
    rail: "iban-sepa",
    currency: "EUR",
    institutionName: "Revolut",
    institutionId: "revolut",
    details: { iban: "EE382200221020145685", full_name: "John Doe" },
  };
  const created: unknown[] = [];
  const client = createClient({
    listPaymentDetails: async () => [saved],
    createPaymentDetails: async (params) => { created.push(params); return { ...saved, paymentDetailsId: "988", details: params.details }; },
  });

  const reused = await client.ensurePaymentDetail({
    fiatCurrencyCode: "EUR",
    paymentMethodSlug: "revolut",
    paymentNetworkSlug: "iban-sepa",
    details: { iban: "EE382200221020145685", full_name: "John Doe" },
  });
  const fresh = await client.ensurePaymentDetail({
    fiatCurrencyCode: "EUR",
    paymentMethodSlug: "revolut",
    paymentNetworkSlug: "iban-sepa",
    details: { iban: "DE89370400440532013000", full_name: "John Doe" },
  });

  assert.equal(reused.id, "987");
  assert.deepEqual(reused.payment_method, { name: "Revolut", slug: "revolut" });
  assert.equal(fresh.id, "988");
  assert.deepEqual(created, [{ currency: "EUR", rail: "iban-sepa", institutionId: "revolut", details: { iban: "DE89370400440532013000", full_name: "John Doe" } }]);
});

test("getPreflightQuote returns an estimate, or nothing when no provider serves the payout", async () => {
  const priced = createClient({
    estimateOfframp: async () => ({ rate: "0.90", cryptoAmount: "55.60", fiatAmount: "50.00", feeBreakdown: { platformFee: "0.28", partnerFee: "0.00", totalFee: "0.28" } }),
  });
  const unserved = createClient({
    estimateOfframp: async () => { throw new PartnerApiError({ status: 409, code: "NO_OFFERS_AVAILABLE", message: "none" }); },
  });
  const params = { cryptoCurrencyCode: "USDC", fiatCurrencyCode: "EUR", fiatAmount: 50, tradePartner: "all" as const };

  assert.deepEqual(await priced.getPreflightQuote(params), {
    quoteType: "estimate",
    source: "best_offer",
    cryptoCurrencyCode: "USDC",
    fiatCurrencyCode: "EUR",
    fiatAmount: 50,
    totalCryptoAmount: 55.6,
    feeCryptoAmount: 0.28,
    vendorOfferRate: 0.9,
  });
  assert.equal(await unserved.getPreflightQuote(params), undefined);
});

test("fundTradeEscrow reports an uncovered order as insufficient balance", async () => {
  const client = createClient({
    authorizeCryptoTransfer: async () => { throw new PartnerApiError({ status: 422, code: "INSUFFICIENT_BALANCE", message: "wallet 0x… has 1 but 3 is required" }); },
  });

  await assert.rejects(client.fundTradeEscrow(ORDER_ID), (error: unknown) => {
    assert.ok(error instanceof TransferExecutionError);
    assert.equal(error.reason, "insufficient_balance");
    return true;
  });
});

test("profile, KYC and balance are reported in the flow's vocabulary", async () => {
  const client = createClient({
    ensureSender: async () => ({ userUuid: "u-1", email: "sender@example.test", kycStatus: "NOT_INITIATED" }),
    getKycVerification: async () => ({ status: "COMPLETED", verificationUrl: "https://verify.example.test/abc", providerMessages: [] }),
    startKycHandoff: async (params) => {
      assert.deepEqual(params, { firstName: "Ada", lastName: "Lovelace Obi", countryCode: "NG" });
      return { status: "IN_PROGRESS", verificationUrl: "https://verify.example.test/abc", providerMessages: [] };
    },
    getWalletBalance: async () => ({ walletAddress: "0x1", assets: [{ assetCode: "USDC", amount: 125.5 }, { assetCode: "USDT", amount: 10 }] }),
  });

  assert.deepEqual(await client.getProfile(), { username: "sender@example.test", id_verification_status: "in_progress" });
  assert.equal((await client.getKycVerificationStatus()).verification_url, "https://verify.example.test/abc");
  assert.equal((await client.initializeKycVerification({ fullName: " Ada Lovelace Obi ", country: "ng" })).status, "in_progress");
  assert.deepEqual(await client.getWalletBalance(), {
    usdc: 125.5,
    usdt: 10,
    totalUsd: 135.5,
    assets: [{ assetCode: "USDC", amount: 125.5 }, { assetCode: "USDT", amount: 10 }],
  });
});
