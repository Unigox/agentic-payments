import test from "node:test";
import assert from "node:assert/strict";

import {
  describeDepositAddressSelection,
  getFrontendSupportedDepositAssetCodes,
  getFrontendSupportedDepositChains,
  getFrontendSupportedDepositOptions,
} from "./unigox-client.ts";
import type { DepositAddresses, TokenOnChain } from "./unigox-client.ts";

const DEPOSIT_ADDRESSES: DepositAddresses = {
  evmAddress: "0xEvmDepositAddress",
  solanaAddress: "SolanaDepositAddress",
  tronAddress: "TTronDepositAddress",
  tonAddress: "EQTonDepositAddress",
  solanaAddressUnlockSecondsLeft: 0,
};

function token(params: {
  code: string;
  name?: string;
  address?: string;
  chainId: number;
  chainName: string;
  chainType: string;
  enabledForDeposit?: boolean;
  enabledForWithdrawal?: boolean;
}): TokenOnChain {
  return {
    code: params.code,
    name: params.name || params.code,
    address: params.address || `${params.code}-${params.chainId}`,
    decimals: 6,
    chain: {
      id: params.chainId,
      name: params.chainName,
      type: params.chainType,
      enabled_for_deposit: params.enabledForDeposit ?? true,
      enabled_for_withdrawal: params.enabledForWithdrawal ?? true,
    },
  };
}

test("frontend-supported deposit options stay token-first, chain-specific, and exclude unsupported routes", () => {
  const tokens: TokenOnChain[] = [
    token({ code: "USDT", chainId: 1, chainName: "Ethereum Mainnet", chainType: "EVM" }),
    token({ code: "USDT", chainId: 10, chainName: "Optimism Mainnet", chainType: "EVM", address: "usdt-main-optimism" }),
    token({ code: "USDT0", chainId: 10, chainName: "Optimism Mainnet", chainType: "EVM", address: "usdt0-optimism" }),
    token({ code: "USDT", chainId: 728126428, chainName: "Tron", chainType: "TVM" }),
    token({ code: "USDC", chainId: 8453, chainName: "Base Mainnet", chainType: "EVM" }),
    token({ code: "USDC", chainId: 1151111081099710, chainName: "Solana", chainType: "Solana" }),
    token({ code: "USDC", chainId: 660279, chainName: "Xai", chainType: "EVM" }),
    token({ code: "USDT", chainId: 1313161554, chainName: "NEAR Intent", chainType: "Intent" }),
    token({ code: "USDC", chainId: 42161, chainName: "Arbitrum One", chainType: "EVM", enabledForDeposit: false }),
    token({ code: "DAI", chainId: 1, chainName: "Ethereum Mainnet", chainType: "EVM" }),
  ];

  const options = getFrontendSupportedDepositOptions(tokens);
  assert.deepEqual(getFrontendSupportedDepositAssetCodes(tokens), ["USDT", "USDC"]);

  const usdt = options.find((entry) => entry.assetCode === "USDT");
  assert.ok(usdt, "USDT asset option should exist");
  assert.deepEqual(
    usdt!.chains.map((entry) => entry.chainName),
    ["Ethereum Mainnet", "Optimism Mainnet", "Tron"],
  );
  assert.equal(usdt!.chains.find((entry) => entry.chainId === 10)?.tokenCode, "USDT", "main token should win over group token when both exist on a chain");

  const allChains = options.flatMap((entry) => entry.chains.map((chain) => chain.chainName));
  assert.ok(!allChains.includes("NEAR Intent"), "unsupported frontend routes must be excluded");
  assert.ok(!allChains.includes("Xai"), "internal Xai chain must not be offered as a deposit route");
  assert.ok(!allChains.includes("Arbitrum One"), "deposit-disabled routes must be filtered out");
});

test("token-specific deposit chain support is preserved per asset", () => {
  const tokens: TokenOnChain[] = [
    token({ code: "USDC", chainId: 42161, chainName: "Arbitrum One", chainType: "EVM" }),
    token({ code: "USDC", chainId: 8453, chainName: "Base Mainnet", chainType: "EVM" }),
    token({ code: "USDC", chainId: 1151111081099710, chainName: "Solana", chainType: "Solana" }),
    token({ code: "USDT", chainId: 1, chainName: "Ethereum Mainnet", chainType: "EVM" }),
    token({ code: "USDT", chainId: 69696969420, chainName: "TON", chainType: "TON" }),
    token({ code: "USDT", chainId: 728126428, chainName: "Tron", chainType: "TVM" }),
  ];

  assert.deepEqual(
    getFrontendSupportedDepositChains(tokens, "USDC").map((entry) => entry.chainName),
    ["Arbitrum One", "Base Mainnet", "Solana"],
  );
  assert.deepEqual(
    getFrontendSupportedDepositChains(tokens, "USDT").map((entry) => entry.chainName),
    ["Ethereum Mainnet", "TON", "Tron"],
  );
});

test("single deposit selection resolves to one relevant address only after token and chain are chosen", () => {
  const tokens: TokenOnChain[] = [
    token({ code: "USDC", chainId: 42161, chainName: "Arbitrum One", chainType: "EVM" }),
    token({ code: "USDC", chainId: 1151111081099710, chainName: "Solana", chainType: "Solana" }),
    token({ code: "USDT", chainId: 728126428, chainName: "Tron", chainType: "TVM" }),
    token({ code: "USDT", chainId: 69696969420, chainName: "TON", chainType: "TON" }),
  ];

  const arbitrumSelection = describeDepositAddressSelection({ assetCode: "USDC", chainId: 42161 }, tokens, DEPOSIT_ADDRESSES);
  assert.equal(arbitrumSelection.chainName, "Arbitrum One");
  assert.equal(arbitrumSelection.depositAddress, DEPOSIT_ADDRESSES.evmAddress);

  const solanaSelection = describeDepositAddressSelection({ assetCode: "USDC", chainId: 1151111081099710 }, tokens, DEPOSIT_ADDRESSES);
  assert.equal(solanaSelection.depositAddress, DEPOSIT_ADDRESSES.solanaAddress);

  const tronSelection = describeDepositAddressSelection({ assetCode: "USDT", chainId: 728126428 }, tokens, DEPOSIT_ADDRESSES);
  assert.equal(tronSelection.depositAddress, DEPOSIT_ADDRESSES.tronAddress);

  const tonSelection = describeDepositAddressSelection({ assetCode: "USDT", chainId: 69696969420 }, tokens, DEPOSIT_ADDRESSES);
  assert.equal(tonSelection.depositAddress, DEPOSIT_ADDRESSES.tonAddress);

  assert.throws(
    () => describeDepositAddressSelection({ assetCode: "USDC", chainId: 999999 }, tokens, DEPOSIT_ADDRESSES),
    /Unsupported deposit selection/,
  );
});
