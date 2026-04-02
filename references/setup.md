# Setup

## Dependencies

- Node.js 22+
- `ethers` v6
- `@ton/crypto`, `@ton/ton`, `@tonconnect/sdk`, `tweetnacl` for TON auth
- `unigox-client.ts` module (the UNIGOX SDK)

## UNIGOX Client Module

The client module lives inside this skill at `scripts/unigox-client.ts`.

## Authentication

When auth is missing or login has to be re-established, start with this user-facing question:

> Which wallet connection path should I use to sign in on UNIGOX: **EVM wallet connection** or **TON wallet connection**?
>
> If neither is ready yet, use **email OTP** for onboarding or recovery, then link the wallet path the user chooses.

For EVM, the real integration has **two different credentials**:
1. a **login wallet key** for the wallet already linked to UNIGOX sign-in (`linked_wallet_address`)
2. a separate **UNIGOX-exported signing key** for the internal Privy / app wallet (`evm_address`) used by signed actions

### 1. EVM login key

```env
UNIGOX_EVM_LOGIN_PRIVATE_KEY=0x...
```

Use this key to:
- replay the EVM / SIWE login flow on UNIGOX
- verify that the agent can sign in successfully

Conversation order for EVM:
1. Ask whether the user has already signed in on unigox.com with that wallet.
2. If not, stop there and tell them to sign in first.
3. Only after they confirm that sign-in already happened, ask for this login key and verify it.

### 2. UNIGOX-exported EVM signing key

```env
UNIGOX_EVM_SIGNING_PRIVATE_KEY=0x...
# legacy alias still supported:
# UNIGOX_PRIVATE_KEY=0x...
```

Use this key for EVM-signed actions inside UNIGOX:
- `fundTradeEscrow()`
- `confirmFiatReceived()`
- `bridgeOut()`

If the user only has the old single-key setup (`UNIGOX_PRIVATE_KEY`), the client still treats it as a legacy fallback for both login and signing.

### 3. TON wallet auth

```env
UNIGOX_AUTH_MODE=ton
UNIGOX_TON_PRIVATE_KEY=...   # or use UNIGOX_TON_MNEMONIC for agent-side derivation
UNIGOX_TON_MNEMONIC=...      # first-class agent-side login path when paired with the exact address
UNIGOX_TON_ADDRESS=0:...     # exact wallet address to use as the TON source of truth
UNIGOX_TON_WALLET_VERSION=v4 # persisted after local version matching
UNIGOX_TON_NETWORK=-239      # optional, defaults to mainnet
# optional, if EVM signed actions are also needed later:
UNIGOX_EVM_SIGNING_PRIVATE_KEY=0x...
```

This mode uses the frontend TON routes:
- `POST /api/ton-generate-payload`
- `POST /api/ton-login`
- `POST /api/ton-link`

TON auth is only for JWT acquisition and optional wallet linking. After the JWT is obtained, the rest of the client keeps using the same account/trade APIs as before.

The TON wallet address is the source of truth. For agent-side login, the user can provide either the mnemonic phrase or the TON private key for that same wallet, and the skill checks the supported TON wallet versions locally until one matches the exact address. The matched version is stored in `UNIGOX_TON_WALLET_VERSION`.

The other first-class TON path is a fresh live TonConnect deep link / QR. That flow does not store a reusable QR token. The user must use the current live link (or a QR generated from it right now); old screenshots of prior QR codes are not reusable.

### 4. Email OTP onboarding

```env
UNIGOX_EMAIL=agent@example.com
# optional later, once configured:
UNIGOX_EVM_LOGIN_PRIVATE_KEY=0x...
UNIGOX_EVM_SIGNING_PRIVATE_KEY=0x...
```

Use this for onboarding or recovery. After email login, the agent can:
- generate and link a local EVM **login** wallet, or
- link a TON wallet for future JWT login

Important: the skill can generate/link the **login** wallet, but it does **not** currently have an API to export the separate internal UNIGOX / Privy signing key. That export still has to happen manually on unigox.com.

## Supported APIs

| API | Base URL |
|-----|----------|
| Account | `https://prod-account-gynob.ondigitalocean.app/api/v1` |
| Trades | `https://prod-trades-inrvj.ondigitalocean.app/api/v1` |
| Offers | `https://prod-offers-jwek6.ondigitalocean.app/api/v1` |
| Escrow | `https://prod-escrow-l2eom.ondigitalocean.app/api/v1` |
| Transactor | `https://transactorpoc-mi666.ondigitalocean.app/api/v1` |
| Currency | `https://prod-currencies-trz2y.ondigitalocean.app/api/v1` |
| Quote/Bridge | `https://prod-relay-quote-bwl48.ondigitalocean.app` |
