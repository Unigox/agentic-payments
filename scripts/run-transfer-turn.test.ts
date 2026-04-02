#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatTransferRunnerOutput,
  resolveRunnerSessionKey,
  resolveSessionStatePath,
  runTransferTurn,
} from "./run-transfer-turn.ts";
import type {
  CurrencyPaymentData,
  PaymentDetail,
  PaymentMethodInfo,
  ResolvedPaymentMethodFieldConfig,
  WalletBalance,
} from "./unigox-client.ts";

function makeWalletBalance(usdt = 71, usdc = 1): WalletBalance {
  return {
    usdc,
    usdt,
    totalUsd: usdt + usdc,
    assets: [
      { assetCode: "USDC", amount: usdc },
      { assetCode: "USDT", amount: usdt },
    ],
  } as WalletBalance;
}

function makeRemotePaymentDetail(): PaymentDetail {
  return {
    id: 77,
    fiat_currency_code: "EUR",
    payment_method: { id: 10, name: "Wise", slug: "wise" },
    payment_network: { id: 11, name: "European Transfer (SEPA)", slug: "iban-sepa" },
    details: {
      full_name: "Aleksandr Example",
      iban: "EE382200221020145685",
    },
  };
}

function makeCurrencyData(): CurrencyPaymentData {
  const wise: PaymentMethodInfo = {
    id: 10,
    slug: "wise",
    name: "Wise",
    networks: [
      {
        id: 11,
        slug: "iban-sepa",
        name: "European Transfer (SEPA)",
        details_format: [],
      },
    ],
  };

  return {
    fiatCurrencyCode: "EUR",
    fiatCurrencySymbol: "€",
    paymentMethods: [wise],
  };
}

function makeFieldConfig(): ResolvedPaymentMethodFieldConfig {
  return {
    currency: "EUR",
    methodId: 10,
    methodSlug: "wise",
    methodName: "Wise",
    networkId: 11,
    networkSlug: "iban-sepa",
    networkName: "European Transfer (SEPA)",
    fields: [],
    networkConfig: {
      countryCode: "BE",
    },
    selectedFormatId: undefined,
  } as ResolvedPaymentMethodFieldConfig;
}

test("runner persists session state and resumes it on the next turn", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-"));
  const deps = {
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: false, evmSigningKeyAvailable: true },
    client: {
      getProfile: async () => ({ username: "skill" }),
      getWalletBalance: async () => makeWalletBalance(),
      listPaymentDetails: async () => [makeRemotePaymentDetail()],
      listInitiatorTrades: async () => [],
    },
    getPaymentMethodsForCurrency: async () => makeCurrencyData(),
    getPaymentMethodFieldConfig: async () => makeFieldConfig(),
  };

  const first = await runTransferTurn({
    text: "I wanna send money to Aleksandr",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.match(first.reply, /Aleksandr Example/i);
  assert.match(first.reply, /Should I use that saved recipient\?/i);

  const sessionPath = resolveSessionStatePath("telegram-main", stateDir);
  assert.equal(fs.existsSync(sessionPath), true);

  const second = await runTransferTurn({
    text: "yes",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.match(second.reply, /How much EUR should I send to Aleksandr Example\?/i);
});

test("runner starts fresh on an explicit new transfer even if an old active session exists", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-reset-"));
  const deps = {
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: false, evmSigningKeyAvailable: true },
    client: {
      getProfile: async () => ({ username: "skill" }),
      getWalletBalance: async () => makeWalletBalance(),
      listPaymentDetails: async () => [makeRemotePaymentDetail()],
      listInitiatorTrades: async () => [],
    },
    getPaymentMethodsForCurrency: async () => makeCurrencyData(),
    getPaymentMethodFieldConfig: async () => makeFieldConfig(),
  };

  await runTransferTurn({
    text: "I wanna send money to Aleksandr",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  const fresh = await runTransferTurn({
    text: "I wanna send money to Aleksandr",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.match(fresh.reply, /Should I use that saved recipient\?/i);
});

test("runner resumes an active KYC session when the user sends combined legal-name and country details", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-kyc-"));
  const deps = {
    authState: { hasReplayableAuth: true, authMode: "evm", emailFallbackAvailable: false, evmSigningKeyAvailable: true },
    client: {
      getProfile: async () => ({
        username: "skill",
        id_verification_status: "NOT_VERIFIED",
        total_traded_volume_usd: 40,
      }),
      getWalletBalance: async () => ({
        usdc: 1,
        usdt: 110.2,
        totalUsd: 111.2,
        assets: [
          { assetCode: "USDC", amount: 1 },
          { assetCode: "USDT", amount: 110.2 },
        ],
      }),
      listPaymentDetails: async () => [makeRemotePaymentDetail()],
      listInitiatorTrades: async () => [],
      ensurePaymentDetail: async () => makeRemotePaymentDetail(),
      getKycVerificationStatus: async () => ({ status: "not_started" }),
      initializeKycVerification: async (_params: { fullName: string; country: string }) => ({
        status: "initial",
        verification_url: "https://verify.example/kyc-session",
        verification_seconds_left: 900,
      }),
      getPreflightQuote: async (_params: unknown) => ({
        quoteType: "estimate",
        source: "best_offer",
        cryptoCurrencyCode: "USDT",
        fiatCurrencyCode: "EUR",
        fiatAmount: 60,
        totalCryptoAmount: 72.55,
        feeCryptoAmount: 0.36,
        vendorOfferRate: 0.827,
        paymentMethodName: "Wise",
        paymentNetworkName: "European Transfer (SEPA)",
      }),
    },
    getPaymentMethodsForCurrency: async () => makeCurrencyData(),
    getPaymentMethodFieldConfig: async () => makeFieldConfig(),
  };

  const first = await runTransferTurn({
    text: "send 60 EUR to Aleksandr",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.equal(first.session.stage, "awaiting_kyc_full_name");

  const second = await runTransferTurn({
    text: "My full legal name is Alex Grape and my country is Estonia",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.equal(second.session.stage, "awaiting_kyc_completion");
  assert.equal(second.session.auth.kycFullName, "Alex Grape");
  assert.equal(second.session.auth.kycCountryCode, "EE");
  assert.match(second.reply, /The verification link is ready\./i);
  assert.match(second.reply, /https:\/\/verify\.example\/kyc-session/i);
});

test("formatTransferRunnerOutput appends options as bullets", () => {
  const output = formatTransferRunnerOutput({
    session: {} as any,
    reply: "Pick one",
    options: ["EUR", "USD"],
    done: false,
    events: [],
  });

  assert.equal(output, "Pick one\n\n• EUR\n• USD");
});

test("resolveRunnerSessionKey uses OpenClaw session variables", () => {
  assert.equal(
    resolveRunnerSessionKey({ OPENCLAW_SESSION_ID: "agent:main:telegram:g-agent-main-main" } as NodeJS.ProcessEnv),
    "agent-main-telegram-g-agent-main-main"
  );
});
