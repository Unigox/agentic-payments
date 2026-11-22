# Setup

## Dependencies

```bash
cd scripts
npm install
```

Node 22.6 or newer is required: the scripts run TypeScript directly with `--experimental-strip-types`.

Runtime packages: `ethers` (local signing and the balance read), `@modelcontextprotocol/sdk` and `zod`
(MCP server only).

## Settings

Copy `.env.example` to `.env` in the repository root and fill it in. See `docs/authentication.md` for what
each setting is. All reads go through `scripts/partner-api-config.ts`.

```bash
UNIGOX_API_KEY=...
UNIGOX_WALLET_PRIVATE_KEY=0x...
UNIGOX_XAI_RPC_URL=https://...
UNIGOX_SENDER_EMAIL=you@example.com
# optional, for testing:
# UNIGOX_API_URL=https://api-staging.unigox.com
```

## Running one turn

```bash
echo "send 50 EUR to John" | bash scripts/run-transfer-turn.sh --json
```

The session is kept in `workflows/sessions/` between turns, keyed by `--session-key` or the agent's session id.

## Tests

```bash
cd scripts
npm test
```

The tests use in-memory fakes and make no network calls.

## APIs used

Everything goes to one host, the UNIGOX Partner API (`https://api.unigox.com`, or the staging host when
`UNIGOX_API_URL` is set). Reference: https://developers.unigox.com

| Purpose | Endpoint |
|---------|----------|
| Check the key | `GET /api/v1/partner/verify-auth` |
| Register the sender | `POST /api/v1/partner/users` |
| KYC | `POST /api/v1/partner/users/{user_uuid}/kyc-submissions`, `GET .../verification-status`, `PATCH .../kyc` |
| Saved payout details | `GET` and `POST /api/v1/partner/users/{user_uuid}/payment-details` |
| Catalogue (public) | `GET /api/v1/supported/payment-rails`, `/institutions`, `/blockchains` |
| Price | `POST /api/v1/partner/offramp/estimate`, `POST /api/v1/partner/offramp/quote` |
| Order | `POST /api/v1/partner/offramp/initiate`, `GET /api/v1/partner/orders/{order_id}` |
| Fund escrow | `GET .../transfer-authorization-parameters`, `POST .../authorize-crypto-transfer` |
| Refund | `GET .../refund-authorization-parameters`, `POST .../authorize-refund` |
| Receipt | `POST .../confirm-fiat-received` |

The only other network call is the balance read: an ERC-20 `balanceOf` on the XAI node named by
`UNIGOX_XAI_RPC_URL`.
