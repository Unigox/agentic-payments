# Integration — Code Patterns

## Loading Auth Config

```typescript
import fs from "fs";
import path from "path";
import { getUnigoxWalletConnectionPrompt } from "./unigox-client";
import type { UnigoxClientConfig } from "./unigox-client";

function loadEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];

  const candidates = [
    path.join(__dirname, ".env"),
    path.join(process.env.HOME || "", ".openclaw", ".env"),
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const line = fs.readFileSync(envPath, "utf-8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).trim();
  }
}

function loadUnigoxConfig(): UnigoxClientConfig {
  const evmLoginPrivateKey = loadEnvValue("UNIGOX_EVM_LOGIN_PRIVATE_KEY");
  const evmSigningPrivateKey = loadEnvValue("UNIGOX_EVM_SIGNING_PRIVATE_KEY") || loadEnvValue("UNIGOX_PRIVATE_KEY");
  const tonMnemonic = loadEnvValue("UNIGOX_TON_MNEMONIC");
  const email = loadEnvValue("UNIGOX_EMAIL");

  if (evmLoginPrivateKey) {
    return {
      authMode: "evm",
      evmLoginPrivateKey,
      ...(evmSigningPrivateKey && { evmSigningPrivateKey }),
      ...(email && { email }),
    };
  }

  if (tonMnemonic) {
    return {
      authMode: loadEnvValue("UNIGOX_AUTH_MODE") === "ton" ? "ton" : "auto",
      tonMnemonic,
      tonAddress: loadEnvValue("UNIGOX_TON_ADDRESS"),
      tonNetwork: loadEnvValue("UNIGOX_TON_NETWORK") || "-239",
      ...(email && { email }),
      ...(evmSigningPrivateKey && { evmSigningPrivateKey }),
    };
  }

  if (email) {
    return {
      email,
      authMode: "email",
      ...(evmSigningPrivateKey && { evmSigningPrivateKey }),
    };
  }

  if (evmSigningPrivateKey) {
    return { privateKey: evmSigningPrivateKey, authMode: "evm" };
  }

  throw new Error(`UNIGOX auth config not found. ${getUnigoxWalletConnectionPrompt()}`);
}
```

## Creating the Client

```typescript
import UnigoxClient from "./unigox-client";

const client = new UnigoxClient(loadUnigoxConfig());
await client.login();
```

## Prompt when auth is missing or only recovery email is available

Use this exact user-facing prompt before asking for credentials:

> Which wallet connection path should I use to sign in on UNIGOX: **EVM wallet connection** or **TON wallet connection**?
>
> If neither is ready yet, we can still use **email OTP** for onboarding or recovery first.

This keeps the skill's normal sign-in language centered on the two replayable wallet paths, while preserving email as the fallback.

## EVM onboarding prompt sequence

For EVM, use this exact order:

1. Ask whether the user has **already signed in on unigox.com with that EVM wallet**.
2. If not, stop and tell them to sign in on unigox.com with that wallet first.
3. Only after they confirm the wallet sign-in already happened, ask for the **wallet key they used to sign in on UNIGOX**.
4. Save it as `UNIGOX_EVM_LOGIN_PRIVATE_KEY`.
5. Call `client.login()` to verify that login works.
6. Only after login succeeds, ask for the separate **UNIGOX-exported EVM signing key**.
7. Save that second key as `UNIGOX_EVM_SIGNING_PRIVATE_KEY` (legacy `UNIGOX_PRIVATE_KEY` still works).

Important: the current integration does **not** expose a backend/client API to export that second key automatically. The user still has to export it manually from unigox.com settings.

## Email → TON linking

```typescript
const client = new UnigoxClient({
  email: process.env.UNIGOX_EMAIL,
  tonMnemonic: process.env.UNIGOX_TON_MNEMONIC,
  tonAddress: process.env.UNIGOX_TON_ADDRESS,
});

await client.verifyEmailOTP(code);
await client.linkTonWallet();
```

## Resolving dynamic payment fields before save / send

The frontend/payment-network config is the source of truth here:
- `getPaymentMethodFieldConfig()` resolves fields using the same format-mapping strategy the frontend uses (and now supports either `networkSlug` or `networkId` so saved contacts can be revalidated accurately)
- `validatePaymentDetailInput()` applies the field validators exposed by the API and falls back to frontend validator-name behavior only when the API omits a regex pattern

```typescript
import {
  getPaymentMethodsForCurrency,
  getPaymentMethodFieldConfig,
  validatePaymentDetailInput,
} from "./unigox-client";

const methods = await getPaymentMethodsForCurrency("KES");
const selectedMethod = methods.paymentMethods.find((m) => m.slug === "mpesa-paybill");

if (!selectedMethod) throw new Error("mpesa-paybill not available for KES");

const fieldConfig = await getPaymentMethodFieldConfig({
  currency: "KES",
  methodSlug: selectedMethod.slug,
  networkSlug: selectedMethod.networks[0]?.slug,
});

const validation = validatePaymentDetailInput(
  {
    paybill: "247247",
    account_number: "INV-1024",
    full_name: "Jane Doe",
  },
  fieldConfig.fields,
  {
    countryCode: fieldConfig.networkConfig.countryCode,
    formatId: fieldConfig.selectedFormatId,
  }
);

if (!validation.valid) {
  throw new Error(JSON.stringify(validation.errors));
}
```

## Send Money Flow

For the chat/state-machine layer, use `scripts/transfer-orchestrator.ts`.
It now handles:
- saved vs new recipient branching
- live method / network selection
- field-by-field collection + validation
- stale-contact revalidation
- save/update decisions
- confirmation
- balance / trade request / wait-for-match unhappy paths
- post-match settlement monitoring via `scripts/settlement-monitor.ts`
- receipt confirmation prompts (`received` / `not received`)
- reminder / timeout tracking for unanswered receipt confirmation
- safe deferred placeholder handling for unsupported post-match replies / statuses

```typescript
import { startTransferFlow, advanceTransferFlow } from "./transfer-orchestrator";

let result = await startTransferFlow("I want to send money", { client });
console.log(result.reply);

result = await advanceTransferFlow(result.session, "new recipient", { client });
console.log(result.reply);
```

Under the hood, execution still follows the same UNIGOX client sequence:

```typescript
// 1. Check balance
const balance = await client.getWalletBalance();
if (balance.totalUsd < amount * 1.05) {
  // Warn: insufficient funds
}

// 2. Ensure payment detail on UNIGOX
const pd = await client.ensurePaymentDetail({
  paymentMethodId: contact.methodId,
  paymentNetworkId: contact.networkId,
  fiatCurrencyCode: contact.currency,
  details: contact.details,
});

// 3. Create trade request
const tr = await client.createTradeRequest({
  tradeType: "SELL",
  fiatCurrencyCode: contact.currency,
  fiatAmount: amount,
  cryptoAmount: amount,
  paymentDetailsId: pd.id,
  paymentMethodId: contact.methodId,
  paymentNetworkId: contact.networkId,
});

// 4. Wait for vendor match
const matched = await client.waitForTradeMatch(tr.id, 120_000);
console.log(`Trade request #${matched.id} matched`);

// 5. Monitor the post-match lifecycle
const trade = matched.trade?.id ? await client.getTrade(matched.trade.id) : undefined;
console.log(`Trade status: ${trade?.status}`);

// 6. Only after explicit receipt confirmation
if (trade?.id) {
  await client.confirmFiatReceived(trade.id);
}
```

## Important limitations

TON auth only covers login / JWT acquisition. Methods that sign EVM transactions still require the exported signing key (`UNIGOX_EVM_SIGNING_PRIVATE_KEY` or legacy `UNIGOX_PRIVATE_KEY`):
- `withdrawFromEscrow()`
- `bridgeOut()`
- `confirmFiatReceived()`

Likewise, EVM login and EVM signing are now modeled separately:
- `UNIGOX_EVM_LOGIN_PRIVATE_KEY` -> wallet login / SIWE replay (`linked_wallet_address`)
- `UNIGOX_EVM_SIGNING_PRIVATE_KEY` -> internal UNIGOX / Privy wallet signing (`evm_address`)

Dispute handling is intentionally deferred in this phase of the skill.
If the user says anything other than explicit `received` / `not received`, or if the trade moves into an unsupported post-match status such as dispute-related states, the orchestrator keeps escrow untouched and routes to a safe deferred/manual follow-up placeholder instead of inventing a dispute workflow.

## Token Addresses (XAI Chain)

| Token | Address | Decimals |
|-------|---------|----------|
| USDC | `0x37BF70ee0dC89a408De31B79cCCC3152F0C8AF43` | 6 |
| USDT | `0xf86Cc81F4E480CF54Eb013FFe6929a0C2Ad5EdCA` | 6 |

## Deposit Route Source of Truth

For conversational wallet top-ups, mirror the frontend wallet flow instead of inventing deposit routes from raw backend data. The current rule set is:

- start from `getBridgeTokens()`
- keep only `chain.enabled_for_deposit === true` routes
- keep only user-facing main assets (`USDT`, `USDC`) and their frontend token groups
- exclude XAI / internal-only routes from deposit choice prompts
- exclude chain types that do not map to a real single deposit address (`EVM`, `Solana`, `TVM`/Tron, `TON` are currently supported)
- after the user chooses token + chain, resolve exactly one address with `describeDepositSelection(...)`

This is how the skill avoids showing unsupported options such as NEAR / intent-style routes when they are not actually selectable in the frontend deposit UI.

## Client Methods Reference

| Method | Description |
|--------|-------------|
| `login()` | Auth with retry (EVM or TON, depending on config) |
| `verifyEmailOTP(code)` | Finish email OTP login |
| `linkTonWallet()` | Link TON wallet to the current authenticated account |
| `getProfile()` | User ID, username, linked addresses, escrow address |
| `getWalletBalance()` | USDC + USDT on XAI chain |
| `getEscrowBalance(token)` | Escrow balance (available, reserved) |
| `getDepositAddresses()` | EVM, Solana, Tron, TON addresses |
| `getBridgeTokens()` | Raw bridge token + chain metadata from the backend |
| `getSupportedDepositOptions()` | Frontend-style deposit asset/network options after filtering unsupported routes |
| `describeDepositSelection({ assetCode, chainId })` | Resolve one token+chain choice to the single relevant deposit address |
| `listPaymentDetails()` | All saved payment methods |
| `createPaymentDetail(params)` | Add new payment method |
| `updatePaymentDetail(id, details)` | Update details |
| `deletePaymentDetail(id)` | Remove payment method |
| `ensurePaymentDetail(params)` | Find-or-create |
| `createTradeRequest(params)` | Initiate a trade |
| `waitForTradeMatch(id, timeout)` | Poll until vendor accepts |
| `getTrade(id)` | Get trade status |
| `confirmFiatReceived(tradeId)` | Sign + call backend `confirm-payment` to release after explicit receipt confirmation |
| `getBridgeQuote(params)` | Get bridge quote |
| `bridgeOut(params)` | Withdraw to external chain (requires EVM key) |
| `withdrawFromEscrow(token, amount)` | Escrow → wallet (requires EVM key) |
