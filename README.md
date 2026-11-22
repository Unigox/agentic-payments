# Agentic Payments

Agents can browse. Agents can code. Now they can pay.

Turn any agent into a payment terminal. Send money across borders with a single sentence.

```
> send €50 to john on revolut
```

## What It Does

- **Cross-border payouts** to bank accounts and mobile money wallets (Revolut, Wise, SEPA, UPI/IMPS, M-PESA, and more)
- **Natural language**: no forms, no dashboards
- **Saved contacts**: add recipients once, pay them again by name
- **Confirm before send**: your agent never moves money without your explicit approval
- **Built on the public UNIGOX Partner API**: one API key, no sign-in flow in chat

### Supported Currencies

The skill reads currencies, banks and required fields live from UNIGOX, so there is no fixed list in this repo.
The current list is public:

```bash
curl https://api.unigox.com/api/v1/supported/corridors
```

By default the skill only uses licensed payout providers. `settings.json` can widen that to P2P providers
(`"tradePartner": "p2p"` or `"all"`), which adds further currencies.

---

## How It Pays

The skill pays from **your UNIGOX partner wallet**:

1. You fund the wallet with USDC or USDT in advance.
2. For each transfer the skill saves the recipient's payout details, gets a quote, and asks you to confirm.
3. After you confirm, it signs the transfer into that order's escrow with your wallet key, on your machine.
4. A UNIGOX provider pays the recipient in local currency, and the escrow is released.

Your wallet key is never sent to UNIGOX or pasted into chat. It is read from local settings and used only to sign.

---

## Install

| Platform | Guide | Install method |
|----------|-------|----------------|
| **Claude Desktop** | [Install guide](docs/install-claude-desktop.md) | Open `.mcpb` bundle + upload Skill ZIP + restart |
| **Codex** | [Install guide](docs/install-codex.md) | One install script |
| **OpenClaw** | [Install guide](docs/install-openclaw.md) | Drop-in (auto-detected) |
| **OpenAI SDK** | [Install guide](docs/install-openai.md) | Tool JSON definition |

After installing, add your settings: **[Settings and credentials](docs/authentication.md)**

---

## Getting Started

### 1. Get a UNIGOX partner account

Start business onboarding at [unigox.com/business](https://unigox.com/business). After approval you receive a
Partner API key. See the [UNIGOX developer docs](https://developers.unigox.com/basics/get-onboarded).

### 2. Install on your platform

Pick your platform from the [install table above](#install) and follow the guide.

### 3. Add your settings

Four values: the API key, the partner wallet key, an XAI node address and the sender's email.
See [Settings and credentials](docs/authentication.md).

### 4. Fund your partner wallet

Sign in to unigox.com with your partner account and open **My Wallet**. Send USDC or USDT on XAI to the wallet
address, or use **Add Money** to deposit from another chain. Details:
[Funding your wallet](https://developers.unigox.com/tutorials/funding-your-wallet).

### 5. Verify the sender

UNIGOX requires the sender's identity to be verified (KYC) before every transfer. The skill walks you through it
the first time: it asks for the legal name and country and gives you a verification link.

### 6. Send money

```
> send €200 to john on revolut
```

Your agent resolves the recipient, walks through method selection, checks the wallet balance, shows the estimate
and asks for confirmation before anything moves.

---

## Why UNIGOX?

UNIGOX is a Canadian-regulated money service business built to be agent-friendly.

- **You hold the key**: the skill signs with your partner wallet key on your own machine
- **API-first**: a public Partner API with an API key
- **P2P + licensed providers**: licensed providers by default, P2P on request
- **12 blockchains**: fund the wallet from wherever your crypto lives
- **Trades under 2 minutes**, 24/7/365

## Architecture

For adapter internals, cross-platform compatibility, and developer documentation, see [adapters/README.md](adapters/README.md).
The conversation flow is mapped in [references/transfer-flow.md](references/transfer-flow.md).

## Contact

- [unigox.com](https://www.unigox.com)
- hello@unigox.com
- [@unigox_global](https://t.me/unigox_global) on Telegram
- [linkedin.com/company/unigox](https://linkedin.com/company/unigox)

## License

MIT
