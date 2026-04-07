# Agentic Payments

Agents can browse. Agents can code. Now they can pay.

Turn any agent into a payment terminal. Send money across borders with a single sentence.

```
> send €50 to john on revolut
```

## What It Does

- **Cross-border transfers** to 17+ countries (Revolut, Wise, SEPA, UPI/IMPS, M-PESA, and more)
- **Natural language** — no forms, no dashboards
- **Saved contacts** — add recipients once, pay instantly every time
- **Confirm before send** — your agent never moves money without your explicit approval

### Supported Currencies

EUR, GBP, USD, AUD, NGN, KES, GHS, INR, ZAR, UGX, ARS, ETB, RWF, XAF, KWD, EGP, SAR — more coming soon.

---

## Install

| Platform | Guide | Install method |
|----------|-------|----------------|
| **Claude Desktop** | [Install guide](docs/install-claude-desktop.md) | Open `.mcpb` bundle + upload Skill ZIP + restart |
| **Codex** | [Install guide](docs/install-codex.md) | One install script |
| **OpenClaw** | [Install guide](docs/install-openclaw.md) | Drop-in (auto-detected) |
| **OpenAI SDK** | [Install guide](docs/install-openai.md) | Tool JSON definition |

After installing, set up authentication: **[Authentication & Wallet Setup](docs/authentication.md)**

---

## Getting Started

### 1. Sign up on UNIGOX

Create an account at [unigox.com](https://www.unigox.com) using an EVM wallet, TON wallet, or email. This account belongs to the agent — don't use your personal email.

Don't have a wallet? Create one for free with [MetaMask](https://metamask.io/) or [Phantom](https://phantom.app/).

### 2. Request access

Email **hello@unigox.com** with your UNIGOX username to get agentic-payments enabled.

### 3. Install on your platform

Pick your platform from the [install table above](#install) and follow the guide.

### 4. Fund your wallet

- **Internal top-up**: another UNIGOX user sends funds to your username
- **External deposit**: deposit crypto from another wallet (USDC, USDT on 12+ chains)
- **Bank on-ramp**: top up from a bank account (EUR, NGN, KES — more coming soon)

### 5. Send money

```
> send €200 to john on revolut
```

Your agent resolves the recipient, walks through method selection, checks the balance, and asks for confirmation before anything moves.

---

## Why UNIGOX?

UNIGOX is a Canadian-regulated money service business built to be agent-friendly.

- **Non-custodial** — your wallet, your keys, your funds
- **API-first** — designed for programmatic access
- **P2P + Licensed providers** — best rate from both sides automatically
- **17+ currencies** — Africa, Europe, Asia, Americas
- **12 blockchains** — deposit from wherever your crypto lives
- **Trades under 2 minutes** — 24/7/365

## For Businesses

Building a product that needs to move money? UNIGOX offers a B2B API for payouts to 17+ countries.

**Coming soon:**
- Virtual EUR and GBP bank accounts
- More on-ramp currencies

Reach out at **hello@unigox.com** to learn more.

---

## Architecture

For adapter internals, cross-platform compatibility, and developer documentation, see [adapters/README.md](adapters/README.md).

## Contact

- [unigox.com](https://www.unigox.com)
- hello@unigox.com
- [@unigox_global](https://t.me/unigox_global) on Telegram
- [linkedin.com/company/unigox](https://linkedin.com/company/unigox)

## License

MIT
