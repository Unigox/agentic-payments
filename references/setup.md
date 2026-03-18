# Setup

## Dependencies

- Node.js 22+
- `ethers` v6 (`npm install ethers`)
- `unigox-client.ts` module (the UNIGOX SDK)

## UNIGOX Client Module

The client module lives at the project level (not bundled in the skill).

Location options:
- `/home/grape/projects/unigox-sdk/src/client.ts` (standalone repo)
- `/home/grape/projects/agent-scripts/unigox-client.ts` (shared)
- Or install from the unigox-sdk repo

## Authentication

Set `UNIGOX_USER_PRIVATE_KEY` environment variable with an EVM wallet private key that has a UNIGOX account.

The client handles:
- Wallet-based login (SIWE message signing)
- Auto token refresh with exponential backoff (5 retries)
- Token expiry detection on all API calls

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
