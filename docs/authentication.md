# Settings and credentials

## Overview

Agentic Payments talks to the public [UNIGOX Partner API](https://developers.unigox.com). There is no sign-in
step in chat. The skill reads four settings from the machine it runs on:

| Setting | Required | What it is |
|---------|----------|------------|
| `UNIGOX_API_KEY` | yes | Partner API key, sent as the `X-API-Key` header. Issued after business onboarding at [unigox.com/business](https://unigox.com/business). |
| `UNIGOX_WALLET_PRIVATE_KEY` | yes | Private key of your UNIGOX partner wallet (`0x` + 64 hex characters). Signs escrow funding and refunds locally. Never sent to UNIGOX. |
| `UNIGOX_XAI_RPC_URL` | yes | JSON-RPC URL of an XAI mainnet node (chain id 660279). Used only to read the wallet's USDC and USDT balance. |
| `UNIGOX_SENDER_EMAIL` | yes | Email of the one KYC-verified person this installation sends for. |
| `UNIGOX_API_URL` | no | API base URL. Defaults to production, `https://api.unigox.com`. Set `https://api-staging.unigox.com` to test with a staging key. |

Without the four required settings the skill can still save contacts, but it will not place a transfer. It
answers a send request with the names of the settings that are missing.

**Never paste a key into chat.** The skill does not ask for keys and does not accept them as messages.

---

## Where to put them

### Claude Desktop

Open the extension's settings after installing the `.mcpb` bundle. Claude Desktop asks for the four values and
stores the two keys as sensitive fields.

### Codex, OpenClaw, OpenAI SDK, command line

Copy `.env.example` in the repository root to `.env` and fill it in. The skill reads, in this order:

1. the process environment
2. the file named by `SEND_MONEY_ENV_PATH`, if set
3. `.env` in the skill directory
4. `~/.openclaw/.env`

`.env` is git-ignored. Do not commit it.

---

## The partner wallet key

Your partner account has one wallet on the XAI chain. Every payout is funded by a signature from that wallet's
key. See [Funding your wallet](https://developers.unigox.com/tutorials/funding-your-wallet).

- The key controls the wallet's **whole balance**. Use a partner account that holds only what the agent is
  allowed to spend, and top it up as needed.
- The skill checks that the API expects the same wallet address as the key before it signs anything. If they
  differ, it signs nothing.
- If you are unsure how to obtain the key for your partner wallet, ask UNIGOX support.

---

## The sender and KYC

`UNIGOX_SENDER_EMAIL` identifies the person the money is sent for. The skill registers that person with the
Partner API on first use. UNIGOX requires the sender to pass identity verification (KYC) before every transfer,
whatever the amount. The skill starts it when needed: it asks for the full legal name and country and returns a
verification link. Once UNIGOX approves, the transfer continues.

One installation serves one sender. The Partner API does not allow several real people to share one sender.

---

## What the skill does with the wallet key

| Action | When | What is signed |
|--------|------|----------------|
| Fund escrow | After you confirm a transfer and a provider accepts it | An EIP-712 request built by UNIGOX that moves exactly the order amount to that order's escrow |
| Refund | When a funded order ends without a payout | A Safe transaction built by UNIGOX that returns the escrow to your partner wallet |

Nothing else is signed. UNIGOX relays both transactions and pays the gas.

---

## Security

- Keep `.env` readable only by you.
- Treat the partner wallet as a spending wallet, not a vault.
- If the machine is lost or shared, ask UNIGOX to replace the API key and move the wallet balance.
