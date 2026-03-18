# Integration — Code Patterns

## Loading the Private Key

```typescript
import fs from "fs";
import path from "path";

function loadPrivateKey(): string {
  // 1. Environment variable
  if (process.env.UNIGOX_PRIVATE_KEY) return process.env.UNIGOX_PRIVATE_KEY;
  
  // 2. Skill directory .env
  const skillEnv = path.join(__dirname, ".env");
  if (fs.existsSync(skillEnv)) {
    const line = fs.readFileSync(skillEnv, "utf-8")
      .split("\n").find(l => l.startsWith("UNIGOX_PRIVATE_KEY="));
    if (line) return line.split("=")[1].trim();
  }
  
  // 3. OpenClaw .env
  const ocEnv = path.join(process.env.HOME || "", ".openclaw", ".env");
  if (fs.existsSync(ocEnv)) {
    const line = fs.readFileSync(ocEnv, "utf-8")
      .split("\n").find(l => l.startsWith("UNIGOX_PRIVATE_KEY="));
    if (line) return line.split("=")[1].trim();
  }
  
  throw new Error("UNIGOX_PRIVATE_KEY not found. Run onboarding first.");
}
```

## Creating the Client

```typescript
import UnigoxClient from "unigox-client"; // or from the SDK repo

const client = new UnigoxClient({ privateKey: loadPrivateKey() });
await client.login();
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
  paymentMethodId: contact.methodId,    // e.g. 2 for Revolut
  paymentNetworkId: contact.networkId,  // e.g. 47 for Revolut Username
  fiatCurrencyCode: "EUR",
  details: contact.details,             // e.g. { revtag: "@mom" }
});

// 3. Create trade request
const tr = await client.createTradeRequest({
  tradeType: "SELL",           // sell crypto to get fiat out
  fiatCurrencyCode: "EUR",
  fiatAmount: amount,
  cryptoAmount: amount,        // ~1:1 for stablecoins
  paymentDetailsId: pd.id,
  paymentMethodId: contact.methodId,
  paymentNetworkId: contact.networkId,
});

// 4. Report
console.log(`Trade request #${tr.id} created`);
```

## Generating a New Wallet

```typescript
import { ethers } from "ethers";

const wallet = ethers.Wallet.createRandom();
console.log("Address:", wallet.address);
console.log("Private Key:", wallet.privateKey);

// Save to .env
fs.appendFileSync(".env", `\nUNIGOX_PRIVATE_KEY=${wallet.privateKey}\n`);
```

## Token Addresses (XAI Chain)

| Token | Address | Decimals |
|-------|---------|----------|
| USDC | `0x37BF70ee0dC89a408De31B79cCCC3152F0C8AF43` | 6 |
| USDT | `0xf86Cc81F4E480CF54Eb013FFe6929a0C2Ad5EdCA` | 6 |

## Client Methods Reference

| Method | Description |
|--------|-------------|
| `login()` | Auth with retry (5 attempts, exponential backoff) |
| `getProfile()` | User ID, username, escrow address |
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
| `bridgeOut(params)` | Withdraw to external chain |
| `withdrawFromEscrow(token, amount)` | Escrow → wallet |
