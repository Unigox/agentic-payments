# Integration — Code Patterns

## Loading Auth Config

```typescript
import fs from "fs";
import path from "path";
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

  throw new Error("UNIGOX auth config not found. Run onboarding first.");
}
```

## Creating the Client

```typescript
import UnigoxClient from "./unigox-client";

const client = new UnigoxClient(loadUnigoxConfig());
await client.login();
```

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

## Send Money Flow

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
  fiatCurrencyCode: "EUR",
  details: contact.details,
});

// 3. Create trade request
const tr = await client.createTradeRequest({
  tradeType: "SELL",
  fiatCurrencyCode: "EUR",
  fiatAmount: amount,
  cryptoAmount: amount,
  paymentDetailsId: pd.id,
  paymentMethodId: contact.methodId,
  paymentNetworkId: contact.networkId,
});

// 4. Report
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
