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
  const privateKey = loadEnvValue("UNIGOX_PRIVATE_KEY");
  const tonMnemonic = loadEnvValue("UNIGOX_TON_MNEMONIC");

  if (privateKey) {
    return { privateKey, authMode: "evm" };
  }

  if (tonMnemonic) {
    return {
      authMode: loadEnvValue("UNIGOX_AUTH_MODE") === "ton" ? "ton" : "auto",
      tonMnemonic,
      tonAddress: loadEnvValue("UNIGOX_TON_ADDRESS"),
      tonNetwork: loadEnvValue("UNIGOX_TON_NETWORK") || "-239",
      email: loadEnvValue("UNIGOX_EMAIL"),
    };
  }

  const email = loadEnvValue("UNIGOX_EMAIL");
  if (email) return { email, authMode: "email" };

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
It handles:
- saved vs new recipient branching
- live method / network selection
- field-by-field collection + validation
- stale-contact revalidation
- save/update decisions
- confirmation
- balance / trade request / wait-for-match unhappy paths

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

// 4. Wait / report
console.log(`Trade request #${tr.id} created`);
```

## Important limitation

TON auth only covers login / JWT acquisition. Methods that sign EVM transactions still require `UNIGOX_PRIVATE_KEY`:
- `withdrawFromEscrow()`
- `bridgeOut()`

## Token Addresses (XAI Chain)

| Token | Address | Decimals |
|-------|---------|----------|
| USDC | `0x37BF70ee0dC89a408De31B79cCCC3152F0C8AF43` | 6 |
| USDT | `0xf86Cc81F4E480CF54Eb013FFe6929a0C2Ad5EdCA` | 6 |

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
| `listPaymentDetails()` | All saved payment methods |
| `createPaymentDetail(params)` | Add new payment method |
| `updatePaymentDetail(id, details)` | Update details |
| `deletePaymentDetail(id)` | Remove payment method |
| `ensurePaymentDetail(params)` | Find-or-create |
| `createTradeRequest(params)` | Initiate a trade |
| `waitForTradeMatch(id, timeout)` | Poll until vendor accepts |
| `getTrade(id)` | Get trade status |
| `getBridgeTokens()` | Supported chains + tokens |
| `getBridgeQuote(params)` | Get bridge quote |
| `bridgeOut(params)` | Withdraw to external chain (requires EVM key) |
| `withdrawFromEscrow(token, amount)` | Escrow → wallet (requires EVM key) |
