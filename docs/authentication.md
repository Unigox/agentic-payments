# Authentication & Wallet Setup

## Overview

Agentic Payments needs two things to work:

1. **A login wallet** — to sign in to UNIGOX on behalf of your agent
2. **A signing key** — exported from UNIGOX settings, used for secure actions (funding escrow, confirming receipts)

On first run, the skill walks you through both. This page explains the options.

---

## Sign-In Methods

When the skill starts, it offers these sign-in paths:

| Method | What it does | Best for |
|--------|-------------|----------|
| **EVM wallet connection** | Use an existing EVM wallet you already have | Users with MetaMask, Phantom, etc. |
| **TON wallet connection** | Use an existing TON wallet | Users with Tonkeeper, etc. |
| **Create dedicated EVM wallet** | Generate a new isolated EVM wallet locally | Beginners / cleanest setup |
| **Create dedicated TON wallet** | Generate a new isolated TON wallet locally | Beginners who prefer TON |
| **Email OTP** | Sign in with a one-time code to your email | Onboarding or recovery |

The **dedicated wallet** options are the easiest path: the skill creates an isolated login wallet on your machine with no manual key handling required.

---

## EVM Wallet Setup

### Existing EVM wallet

Provide the private key for the EVM wallet you already use on UNIGOX. The skill stores it locally as `UNIGOX_EVM_LOGIN_PRIVATE_KEY`.

### Generated EVM wallet

The skill creates a new EVM wallet locally. No key pasting needed. The key is stored as `UNIGOX_EVM_LOGIN_PRIVATE_KEY` automatically.

You can export the generated wallet later by saying `export this wallet` — this writes a local backup file (default: `~/Downloads/Agentic Payments/`), it does not echo secrets into chat.

---

## TON Wallet Setup

### Existing TON wallet

Two paths:
- **Agent-side derivation**: provide the raw TON address plus either the mnemonic phrase or TON private key. The skill matches the wallet version automatically.
- **TonConnect link/QR**: the skill creates a TonConnect deep link you open in your wallet.

### Generated TON wallet

The skill creates a new TON wallet locally and stores `UNIGOX_TON_PRIVATE_KEY`, `UNIGOX_TON_ADDRESS`, and `UNIGOX_TON_WALLET_VERSION`.

---

## Email Authentication

Useful for onboarding when no wallet is ready. You can link a wallet later.

---

## UNIGOX Signing Key

This is a **separate** key from the login wallet. It is exported from your UNIGOX account settings and is required for secure actions like funding escrow and confirming receipts.

### How to get it

1. Log in to [unigox.com](https://www.unigox.com) using the same wallet/method your agent uses
2. Go to **Account Settings**
3. Look for the option to **export your agentic-payments / signing key**
4. Paste the key when the skill asks for it

The skill stores it as `UNIGOX_EVM_SIGNING_PRIVATE_KEY`.

> If you don't see the export option, agentic-payments beta may not be enabled on your account yet. Email **hello@unigox.com** or use UNIGOX Intercom chat to request access.

### Browser login helper

If the site shows a login QR or link while you're trying to reach settings:
- **EVM wallet**: paste the `wc:` WalletConnect link or share a QR screenshot — the skill can approve the browser login locally
- **TON wallet**: paste the `tc://` TonConnect link or share a QR screenshot — the skill can approve the browser login locally

---

## Security

- Use a **newly created / isolated wallet** for UNIGOX. Never use your main wallet.
- Do not hold large amounts. Treat it as a spending wallet, not a vault.
- Secure your login key and signing key. Anyone with access can authenticate as the agent.
- After pasting a key in chat, delete that message if your platform supports it.
- The signing key cannot be auto-exported yet — the manual export from unigox.com is required.

---

## Environment Variables Reference

| Variable | Description |
|----------|-------------|
| `UNIGOX_EVM_LOGIN_PRIVATE_KEY` | EVM login wallet private key |
| `UNIGOX_EVM_SIGNING_PRIVATE_KEY` | Exported UNIGOX signing key |
| `UNIGOX_PRIVATE_KEY` | Legacy alias for signing key |
| `UNIGOX_EVM_LOGIN_WALLET_ORIGIN` | Auth origin (`evm` or `generated_evm`) |
| `UNIGOX_TON_PRIVATE_KEY` | TON wallet private key |
| `UNIGOX_TON_ADDRESS` | TON wallet address |
| `UNIGOX_TON_MNEMONIC` | TON wallet mnemonic (alternative to private key) |
| `UNIGOX_TON_WALLET_VERSION` | Matched TON wallet version |
| `UNIGOX_TON_LOGIN_WALLET_ORIGIN` | Auth origin (`ton` or `generated_ton`) |
| `UNIGOX_EMAIL` | Email for OTP auth |
| `WALLETCONNECT_PROJECT_ID` | Optional WalletConnect project ID override |

These are stored in `.env` in the project root (or `~/.openclaw/.env` as fallback).
