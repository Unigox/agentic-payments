# Setup

## Dependencies

- Node.js 22+
- `ethers` v6
- `@ton/crypto`, `@ton/ton`, `tweetnacl` for TON auth
- `unigox-client.ts` module (the UNIGOX SDK)

## UNIGOX Client Module

The client module lives inside this skill at `scripts/unigox-client.ts`.

## Authentication

Supported auth modes:

### 1. EVM private key

```env
UNIGOX_PRIVATE_KEY=0x...
```

Use this when the agent needs both:
- normal UNIGOX login
- EVM-signed actions (`withdrawFromEscrow()`, `bridgeOut()`)

### 2. TON wallet auth

```env
UNIGOX_AUTH_MODE=ton
UNIGOX_TON_MNEMONIC="word1 word2 ... word24"
UNIGOX_TON_ADDRESS=0:...   # optional override if derived V4 address differs
UNIGOX_TON_NETWORK=-239    # optional, defaults to mainnet
```

This mode uses the frontend TON routes:
- `POST /api/ton-generate-payload`
- `POST /api/ton-login`
- `POST /api/ton-link`

TON auth is only for JWT acquisition and optional wallet linking. After the JWT is obtained, the rest of the client keeps using the same account/trade APIs as before.

### 3. Email OTP onboarding

```env
UNIGOX_EMAIL=agent@example.com
```

Use this for onboarding or recovery. After email login, the agent can:
- generate and link a local EVM wallet, or
- link a TON wallet for future JWT login

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
