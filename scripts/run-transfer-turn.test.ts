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
import { UnigoxClient } from "./unigox-client.ts";
import type {
  CurrencyPaymentData,
  PaymentDetail,
  PaymentMethodInfo,
  ResolvedPaymentMethodFieldConfig,
  WalletBalance,
} from "./unigox-client.ts";

const VALID_LOGIN_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
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

test("runner uses persisted TON auth from the configured env file when approving a fresh tc:// link", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-tonconnect-env-"));
  const envPath = path.join(stateDir, ".env");
  const tonAddress = "UQDcx3iPA77JqK6a5tHK8PsE77HDdt_SGsx7O9IjWpMQAVEK";
  const tcLink = "tc://?v=2&id=b3103ecefbea0dc9beba06ab43354d4ee5140ec047d905235cbd852aaf9ed97d&trace_id=019d62d1-4636-750c-a6b2-5eb083f9c9d1&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fwww.unigox.com%2Fapi%2Ftonconnect-manifest%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%22b19fab0fec923203e6f0b93d609fe1660575cfa548e7239832025c72007524d6%22%7D%5D%7D&ret=none";

  fs.writeFileSync(envPath, [
    "UNIGOX_AUTH_MODE=ton",
    `UNIGOX_TON_PRIVATE_KEY=${VALID_TON_PRIVATE_KEY}`,
    `UNIGOX_TON_ADDRESS=${tonAddress}`,
    "UNIGOX_TON_WALLET_VERSION=v4",
    "UNIGOX_TON_NETWORK=-239",
  ].join("\n") + "\n");

  const originalApprove = UnigoxClient.prototype.approveTonConnectBrowserLogin;
  const originalGetProfile = UnigoxClient.prototype.getProfile;
  const approvedLinks: string[] = [];

  UnigoxClient.prototype.getProfile = async function () {
    return { username: "skill" } as any;
  };

  UnigoxClient.prototype.approveTonConnectBrowserLogin = async function (universalLink: string) {
    approvedLinks.push(universalLink);
    assert.equal(this["tonPrivateKey"] === null, false);
    assert.match(this["tonAddressOverride"] || "", /^0:/);
    return {
      bridgeUrl: "https://bridge.tonapi.io/bridge",
      walletAddress: this["tonAddressOverride"],
      manifestUrl: "https://www.unigox.com/api/tonconnect-manifest",
      tonProofPayload: "proof-hash",
    };
  };

  try {
    const result = await withEnv(
      {
        SEND_MONEY_ENV_PATH: envPath,
        SEND_MONEY_DISABLE_ENV_FILE_LOOKUP: undefined,
      },
      () => runTransferTurn({
        text: tcLink,
        sessionKey: "telegram:main",
        stateDir,
        deps: {
          authState: { hasReplayableAuth: true, authMode: "ton", emailFallbackAvailable: false, evmSigningKeyAvailable: false },
          client: {
            getProfile: async () => ({ username: "skill" }),
          } as any,
        },
      })
    );

    assert.equal(result.session.stage, "awaiting_evm_signing_key");
    assert.equal(result.session.amount, undefined);
    assert.match(result.reply, /approved that fresh UNIGOX TonConnect browser-login request locally/i);
    assert.deepEqual(approvedLinks, [tcLink]);
  } finally {
    UnigoxClient.prototype.approveTonConnectBrowserLogin = originalApprove;
    UnigoxClient.prototype.getProfile = originalGetProfile;
  }
});

test("runner can continue an active missing-signing-key step from a WalletConnect QR screenshot path", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-walletconnect-qr-"));
  const wcLink = "wc:266081884b684924211ce2e68e0808e18c6c7f82cda45dcf59837aca50979a05@2?relay-protocol=irn&symKey=6fba76027bd0bc22245b7c5223201ee3e07ac3856e02224ab0c6a4a7f498abe2";
  const deps = {
    authState: { hasReplayableAuth: true, authMode: "evm", choice: "generated_evm", emailFallbackAvailable: false, evmSigningKeyAvailable: false },
    client: {
      getProfile: async () => ({ username: "skill" }),
      getWalletBalance: async () => makeWalletBalance(),
      listPaymentDetails: async () => [makeRemotePaymentDetail()],
      listInitiatorTrades: async () => [],
    },
    getPaymentMethodsForCurrency: async () => makeCurrencyData(),
    getPaymentMethodFieldConfig: async () => makeFieldConfig(),
    decodeEvmWalletConnectQr: async (imagePath: string) => {
      assert.equal(imagePath, "/tmp/unigox-walletconnect-qr.png");
      return wcLink;
    },
    approveEvmWalletConnectLink: async (uri: string) => {
      assert.equal(uri, wcLink);
      return {
        sessionTopic: "session-topic",
        pairingTopic: "pairing-topic",
        requestedChains: ["eip155:1"],
        approvedChains: ["eip155:1"],
        requestedMethods: ["eth_accounts"],
        handledMethods: ["eth_accounts"],
        requestCount: 1,
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
    imagePath: "/tmp/unigox-walletconnect-qr.png",
    sessionKey: "telegram:main",
    stateDir,
    deps,
  });

  assert.equal(second.session.stage, "awaiting_evm_signing_key");
  assert.match(second.reply, /approved that fresh UNIGOX WalletConnect browser-login request locally/i);
});

test("runner uses persisted EVM auth from the configured env file when approving a fresh wc: link", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-walletconnect-env-"));
  const envPath = path.join(stateDir, ".env");
  const wcLink = "wc:266081884b684924211ce2e68e0808e18c6c7f82cda45dcf59837aca50979a05@2?relay-protocol=irn&symKey=6fba76027bd0bc22245b7c5223201ee3e07ac3856e02224ab0c6a4a7f498abe2";

  fs.writeFileSync(envPath, [
    `UNIGOX_EVM_LOGIN_PRIVATE_KEY=${VALID_LOGIN_KEY}`,
    "UNIGOX_LOGIN_WALLET_ORIGIN=generated_evm",
  ].join("\n") + "\n");

  const originalApprove = UnigoxClient.prototype.approveEvmWalletConnectBrowserLogin;
  const originalGetProfile = UnigoxClient.prototype.getProfile;
  const approvedUris: string[] = [];

  UnigoxClient.prototype.getProfile = async function () {
    return { username: "skill" } as any;
  };

  UnigoxClient.prototype.approveEvmWalletConnectBrowserLogin = async function (uri: string, options: { projectId: string; sessionKey?: string }) {
    approvedUris.push(uri);
    assert.equal(this["loginWallet"]?.privateKey, VALID_LOGIN_KEY);
    assert.equal(options.projectId, "test-project-id");
    assert.equal(options.sessionKey, "telegram-main");
    return {
      sessionTopic: "session-topic",
      pairingTopic: "pairing-topic",
      requestedChains: ["eip155:1"],
      approvedChains: ["eip155:1"],
      requestedMethods: ["eth_accounts"],
      handledMethods: ["eth_accounts"],
      requestCount: 1,
      walletAddress: this["loginWallet"]?.address,
    };
  };

  try {
    const result = await withEnv(
      {
        SEND_MONEY_ENV_PATH: envPath,
        SEND_MONEY_DISABLE_ENV_FILE_LOOKUP: undefined,
        WALLETCONNECT_PROJECT_ID: "test-project-id",
      },
      () => runTransferTurn({
        text: wcLink,
        sessionKey: "telegram:main",
        stateDir,
        deps: {
          authState: { hasReplayableAuth: true, authMode: "evm", choice: "generated_evm", emailFallbackAvailable: false, evmSigningKeyAvailable: false },
          client: {
            getProfile: async () => ({ username: "skill" }),
          } as any,
        },
      }),
    );

    assert.equal(result.session.stage, "awaiting_evm_signing_key");
    assert.equal(result.session.amount, undefined);
    assert.match(result.reply, /approved that fresh UNIGOX WalletConnect browser-login request locally/i);
    assert.deepEqual(approvedUris, [wcLink]);
  } finally {
    UnigoxClient.prototype.approveEvmWalletConnectBrowserLogin = originalApprove;
    UnigoxClient.prototype.getProfile = originalGetProfile;
  }
});

test("runner falls back to the bundled WalletConnect project id when no env override is configured", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-walletconnect-default-"));
  const envPath = path.join(stateDir, ".env");
  const wcLink = "wc:266081884b684924211ce2e68e0808e18c6c7f82cda45dcf59837aca50979a05@2?relay-protocol=irn&symKey=6fba76027bd0bc22245b7c5223201ee3e07ac3856e02224ab0c6a4a7f498abe2";

  fs.writeFileSync(envPath, [
    `UNIGOX_EVM_LOGIN_PRIVATE_KEY=${VALID_LOGIN_KEY}`,
    "UNIGOX_LOGIN_WALLET_ORIGIN=generated_evm",
  ].join("\n") + "\n");

  const originalApprove = UnigoxClient.prototype.approveEvmWalletConnectBrowserLogin;
  const originalGetProfile = UnigoxClient.prototype.getProfile;
  const approvedUris: string[] = [];

  UnigoxClient.prototype.getProfile = async function () {
    return { username: "skill" } as any;
  };

  UnigoxClient.prototype.approveEvmWalletConnectBrowserLogin = async function (uri: string, options: { projectId: string; sessionKey?: string }) {
    approvedUris.push(uri);
    assert.equal(options.projectId, "5b859bb2b321133226b5b03b00ace35b");
    assert.equal(options.sessionKey, "telegram-main");
    return {
      sessionTopic: "session-topic",
      pairingTopic: "pairing-topic",
      requestedChains: ["eip155:1"],
      approvedChains: ["eip155:1"],
      requestedMethods: ["eth_accounts"],
      handledMethods: ["eth_accounts"],
      requestCount: 1,
      walletAddress: this["loginWallet"]?.address,
    };
  };

  try {
    const result = await withEnv(
      {
        SEND_MONEY_ENV_PATH: envPath,
        SEND_MONEY_DISABLE_ENV_FILE_LOOKUP: undefined,
        WALLETCONNECT_PROJECT_ID: undefined,
        REOWN_PROJECT_ID: undefined,
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: undefined,
      },
      () => runTransferTurn({
        text: wcLink,
        sessionKey: "telegram:main",
        stateDir,
        deps: {
          authState: { hasReplayableAuth: true, authMode: "evm", choice: "generated_evm", emailFallbackAvailable: false, evmSigningKeyAvailable: false },
          client: {
            getProfile: async () => ({ username: "skill" }),
          } as any,
        },
      }),
    );

    assert.equal(result.session.stage, "awaiting_evm_signing_key");
    assert.match(result.reply, /approved that fresh UNIGOX WalletConnect browser-login request locally/i);
    assert.deepEqual(approvedUris, [wcLink]);
  } finally {
    UnigoxClient.prototype.approveEvmWalletConnectBrowserLogin = originalApprove;
    UnigoxClient.prototype.getProfile = originalGetProfile;
  }
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
  assert.match(envBody, /UNIGOX_LOGIN_WALLET_ORIGIN=ton/);
});

test("runner writes a generated TON wallet export file when asked", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-runner-export-"));
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-money-export-"));
  const mnemonic = "hospital stove relief fringe tongue always charge angry urge sentence again match nerve inquiry senior coconut label tumble carry category beauty bean road solution";

  await withEnv(
    {
      SEND_MONEY_EXPORT_DIR: exportDir,
      UNIGOX_LOGIN_WALLET_ORIGIN: "generated_ton",
      UNIGOX_TON_PRIVATE_KEY: VALID_TON_PRIVATE_KEY,
      UNIGOX_TON_MNEMONIC: mnemonic,
      UNIGOX_TON_ADDRESS: "0:9d7ff9b839333a63db09a70cd19ed3c277f6889f3108cce528a628306ae8c737",
      UNIGOX_TON_WALLET_VERSION: "v4",
      UNIGOX_EVM_SIGNING_PRIVATE_KEY: undefined,
      UNIGOX_PRIVATE_KEY: undefined,
    },
    async () => {
      const result = await runTransferTurn({
        text: "export this wallet",
        sessionKey: "telegram:export",
        stateDir,
        deps: {
          authState: { hasReplayableAuth: true, authMode: "ton", choice: "generated_ton", emailFallbackAvailable: false, evmSigningKeyAvailable: false },
          client: {} as any,
        },
      });

      assert.match(result.reply, /dedicated TON login wallet/i);
      assert.match(result.reply, /local file:/i);

      const files = fs.readdirSync(exportDir);
      assert.equal(files.length, 1);
      const exportPath = path.join(exportDir, files[0]);
      assert.match(result.reply, new RegExp(exportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const parsed = JSON.parse(fs.readFileSync(exportPath, "utf-8"));
      assert.equal(parsed.wallet_type, "ton");
      assert.equal(parsed.origin, "generated_ton");
      assert.equal(parsed.private_key, VALID_TON_PRIVATE_KEY);
      assert.equal(parsed.mnemonic, mnemonic);
      assert.equal(parsed.address, "0:9d7ff9b839333a63db09a70cd19ed3c277f6889f3108cce528a628306ae8c737");
      assert.equal(parsed.wallet_version, "v4");
    }
  );
});
