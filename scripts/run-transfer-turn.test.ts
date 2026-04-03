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

const VALID_TON_PRIVATE_KEY = "4444444444444444444444444444444444444444444444444444444444444444";

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

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
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

test("runner can continue an active missing-signing-key step from a TonConnect QR screenshot path", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-tonconnect-qr-"));
  const tcLink = "tc://?v=2&id=17051a42b960dd99f0a75589efb2210371230a7d274246bc48073e89e661ca5e&trace_id=019d510c-b56a-75ee-99e8-926b5aaaf916&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fwww.unigox.com%2Fapi%2Ftonconnect-manifest%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%22e72b645a2904fe70a743c8a1f2d82979cecfe66f443109b493074bf5ae9ca22f%22%7D%5D%7D&ret=none";
  const deps = {
    authState: { hasReplayableAuth: true, authMode: "ton", emailFallbackAvailable: false, evmSigningKeyAvailable: false },
    client: {
      getProfile: async () => ({ username: "skill" }),
      getWalletBalance: async () => makeWalletBalance(),
      listPaymentDetails: async () => [makeRemotePaymentDetail()],
      listInitiatorTrades: async () => [],
    },
    getPaymentMethodsForCurrency: async () => makeCurrencyData(),
    getPaymentMethodFieldConfig: async () => makeFieldConfig(),
    decodeTonConnectQr: async (imagePath: string) => {
      assert.equal(imagePath, "/tmp/unigox-qr.png");
      return tcLink;
    },
    approveTonConnectLink: async (link: string) => {
      assert.equal(link, tcLink);
      return {
        bridgeUrl: "https://bridge.tonapi.io/bridge",
        walletAddress: "0:942dcad7691db2159cd34ac9045ec697f6ce009b659eec939e7b89ef88cb090e",
        manifestUrl: "https://www.unigox.com/api/tonconnect-manifest",
      };
    },
  };

  const first = await runTransferTurn({
    text: "send 50 EUR to Aleksandr",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.equal(first.session.stage, "awaiting_evm_signing_key");

  const second = await runTransferTurn({
    imagePath: "/tmp/unigox-qr.png",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.equal(second.session.stage, "awaiting_evm_signing_key");
  assert.match(second.reply, /approved that fresh UNIGOX TonConnect browser-login request locally/i);
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

test("runner persists TON auth secrets into the skill env file by default", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-ton-"));
  const envPath = path.join(stateDir, ".env");
  const tonAddress = "UQDcx3iPA77JqK6a5tHK8PsE77HDdt_SGsx7O9IjWpMQAVEK";
  const tonPrivateKey = VALID_TON_PRIVATE_KEY;

  await withEnv(
    {
      SEND_MONEY_ENV_PATH: envPath,
      SEND_MONEY_DISABLE_ENV_FILE_LOOKUP: "1",
      UNIGOX_EVM_SIGNING_PRIVATE_KEY: undefined,
      UNIGOX_PRIVATE_KEY: undefined,
    },
    async () => {
    const deps = {
      authState: { hasReplayableAuth: false, authMode: undefined, emailFallbackAvailable: false, evmSigningKeyAvailable: false },
      verifyTonLogin: async ({ tonPrivateKey: normalizedKey, tonAddress: normalizedAddress }: { tonPrivateKey?: string; tonAddress?: string }) => ({
        success: normalizedKey === tonPrivateKey && Boolean(normalizedAddress?.startsWith("0:")),
        username: "tonuser",
        tonWalletVersion: "v5r1",
      }),
      handleSensitiveInput: async () => ({ deleted: true, note: "Deleted automatically." }),
    };

    await runTransferTurn({
      text: "send 50 EUR to mom",
      sessionKey: "telegram:main",
      stateDir,
      deps,
    });

    await runTransferTurn({
      text: "ton",
      sessionKey: "telegram:main",
      stateDir,
      deps,
    });

    await runTransferTurn({
      text: tonAddress,
      sessionKey: "telegram:main",
      stateDir,
      deps,
    });

    const result = await runTransferTurn({
      text: "this address is correct",
      sessionKey: "telegram:main",
      stateDir,
      deps,
    });

    const finalResult = await runTransferTurn({
      text: tonPrivateKey,
      sessionKey: "telegram:main",
      stateDir,
      deps,
    });

    assert.equal(result.session.stage, "awaiting_ton_auth_method");
    assert.match(result.reply, /TON mnemonic|TON private key|TonConnect/i);
    assert.equal(finalResult.session.auth.mode, "ton");
    assert.equal(finalResult.session.auth.available, true);
    assert.ok(["awaiting_evm_signing_key", "awaiting_payment_method"].includes(finalResult.session.stage));
  }
  );

  const envBody = fs.readFileSync(envPath, "utf-8");
  assert.match(envBody, /UNIGOX_AUTH_MODE=ton/);
  assert.match(envBody, /UNIGOX_TON_PRIVATE_KEY=4444444444444444444444444444444444444444444444444444444444444444/);
  assert.match(envBody, /UNIGOX_TON_ADDRESS=0:/);
  assert.match(envBody, /UNIGOX_TON_WALLET_VERSION=v5r1/);
  assert.match(envBody, /UNIGOX_TON_NETWORK=-239/);
});
