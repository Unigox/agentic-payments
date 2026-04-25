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
  const tonPrivateKey = loadEnvValue("UNIGOX_TON_PRIVATE_KEY");
  const tonMnemonic = loadEnvValue("UNIGOX_TON_MNEMONIC");
  const tonWalletVersion = loadEnvValue("UNIGOX_TON_WALLET_VERSION");
  const email = loadEnvValue("UNIGOX_EMAIL");

  if (evmLoginPrivateKey) {
    return {
      authMode: "evm",
      evmLoginPrivateKey,
      ...(email && { email }),
    };
  }

  if (tonPrivateKey || tonMnemonic) {
    return {
      authMode: "ton",
      ...(tonPrivateKey && { tonPrivateKey }),
      ...(tonMnemonic && { tonMnemonic }),
      tonAddress: loadEnvValue("UNIGOX_TON_ADDRESS"),
      ...(tonWalletVersion && { tonWalletVersion }),
      tonNetwork: loadEnvValue("UNIGOX_TON_NETWORK") || "-239",
      ...(email && { email }),
    };
  }

  if (email) {
    return { email, authMode: "email" };
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

Once login succeeds, signed actions are handled server-side by the privy-signing backend using the Auth0 idToken from the active UNIGOX session — no additional key collection step.

## Email → TON linking

```typescript
const client = new UnigoxClient({
  email: process.env.UNIGOX_EMAIL,
  tonPrivateKey: process.env.UNIGOX_TON_PRIVATE_KEY,
  tonAddress: process.env.UNIGOX_TON_ADDRESS,
  tonWalletVersion: process.env.UNIGOX_TON_WALLET_VERSION,
});

await client.verifyEmailOTP(code);
await client.linkTonWallet();
```

## Agent-side TON derivation login

```typescript
const client = new UnigoxClient({
  authMode: "ton",
  tonMnemonic: process.env.UNIGOX_TON_MNEMONIC, // or tonPrivateKey
  tonAddress: process.env.UNIGOX_TON_ADDRESS,
  tonWalletVersion: process.env.UNIGOX_TON_WALLET_VERSION,
});

await client.login();
```

The exact raw TON address is the source of truth. The client derives the supported TON wallet versions locally until one matches that exact address, then persists the matched version as `UNIGOX_TON_WALLET_VERSION`.

## Fresh TonConnect login

Use the same frontend flow the UNIGOX website uses:

1. `createTonLoginPayloadTokenPair()` to get `{ payloadToken, payloadTokenHash }`
2. Generate a fresh live TonConnect deep link / QR with `payloadTokenHash`
3. Wait for the wallet to approve and return `tonProof`
4. Call `loginWithTonConnect({ address, network, public_key, proof, payloadToken })`

Important:
- only accept the TonConnect result if the returned wallet address matches the exact address the user confirmed earlier
- use the current live link (or a QR generated from it right now)
- do not treat old QR screenshots as reusable login credentials

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

// 5. If the partner requires extra payout fields, submit them first
//    and revalidate before attempting funding.

// 6. Fund the live trade escrow only
const trade = matched.trade?.id ? await client.getTrade(matched.trade.id) : undefined;
if (trade?.id && trade.escrow_address) {
  await client.fundTradeEscrow(
    matched.crypto_currency_code === "USDC" ? "USDC" : "USDT",
    String(matched.total_crypto_amount),
    trade.escrow_address
  );
}

// 7. Monitor the post-match lifecycle
console.log(`Trade status: ${trade?.status}`);

// 8. Only after explicit receipt confirmation
if (trade?.id) {
  await client.confirmFiatReceived(trade.id);
}
```

Important: for `send-money`, escrow funding means sending the matched amount to the live trade's `escrow_address`. Do not use automated escrow deposit / withdraw helpers as part of this flow.

## Server-side signing

Once the user is signed in (SIWE / TON proof / email OTP), the client captures the Auth0 idToken from the active UNIGOX session and forwards it as `Authorization: Bearer <idToken>` to the privy-signing backend (default `https://privy-signing-prod-at922.ondigitalocean.app`, override with `PRIVY_SIGNING_URL`). All on-chain signing for `fundTradeEscrow()`, `confirmFiatReceived()`, `bridgeOut()`, and similar signed actions is performed there. The relevant endpoints:

- `POST /sign/forward-request` — XAI Forwarder ForwardRequest (escrow funding, generic forwarded calls)
- `POST /sign/safe-tx` — XAI Gnosis SafeTx (escrow release / trade actions)
- `POST /sign/permit` — Arbitrum USDC EIP-3009
- `POST /sign/typed-data` — generic EIP-712 fallback

TON auth covers login / JWT acquisition; signed actions follow the same backend path through the captured idToken.

## Important limitations

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
| `getEscrowBalance(token)` | Automated escrow balance for diagnostics only; not part of the send-money transfer path |
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
| `fundTradeEscrow(token, amount, escrowAddress)` | Send matched funds to the live trade escrow address |
| `confirmFiatReceived(tradeId)` | Sign + call backend `confirm-payment` to release after explicit receipt confirmation |
| `getBridgeQuote(params)` | Get bridge quote |
| `bridgeOut(params)` | Withdraw to external chain (requires EVM key) |
