# Onboarding — First Run Setup

## When to Trigger

Run this flow when `UNIGOX_PRIVATE_KEY` is not found in the environment or `.env` file.

## Step 1: Introduction & Security Warning

Send this message (adapt to your voice, keep all warnings):

---

**💸 Send Money Skill — Setup**

This skill lets you send money to people using natural language. Under the hood it uses UNIGOX, a P2P crypto exchange, to convert your USDC/USDT into fiat (EUR, etc.) and send it to your contacts.

**⚠️ Important — please read:**

- This skill controls a crypto wallet using a **private key** you provide.
- The private key is stored locally in your `.env` file. It is **never** sent anywhere except to UNIGOX for authentication.
- **Do not keep large amounts** in this wallet. Treat it like a spending wallet, not a vault. Load only what you plan to send in the near term.
- This is an **AI agent** managing real money. While safeguards are in place (confirmation before every transfer), use it responsibly.
- **You are responsible** for the funds in this wallet. OpenClaw and skill authors are not liable for any loss.

---

## Step 2: Private Key Import

Ask the user:

> To get started, I need a wallet private key. This wallet will be used to log into UNIGOX and hold the crypto that gets converted to fiat when you send money.
>
> **Options:**
> 1. Provide an existing EVM private key
> 2. I can generate a new wallet for you
>
> Which do you prefer?

### If user provides a key:
- Validate it's a valid hex string (64 chars, with or without 0x prefix)
- Save to `.env` as `UNIGOX_PRIVATE_KEY=<key>`
- Test login: instantiate UnigoxClient, call `login()`, verify success
- Show the wallet address

### If user wants a new wallet:
- Generate: `const wallet = ethers.Wallet.createRandom()`
- Show address and private key
- **Warn**: "Save this private key somewhere safe. If you lose it, the funds are gone."
- Save to `.env` as `UNIGOX_PRIVATE_KEY=<key>`

## Step 3: Verify & Show Deposit Info

After key is saved:

1. Login to UNIGOX
2. Get profile (show username, user ID)
3. Get deposit addresses
4. Check wallet balance

Send:

> ✅ **Setup complete!**
>
> **Wallet:** `0x1234...5678`
> **UNIGOX user:** username (ID: 1234)
>
> **Deposit addresses** (send USDC or USDT here to fund your wallet):
> - **EVM (Ethereum/Polygon/Arbitrum/Base):** `0xABC...`
> - **Solana:** `ABC123...`
> - **Tron:** `TXYZ...`
>
> **Current balance:** $0.00
>
> ⚠️ Remember: only load what you plan to send. This is a hot wallet controlled by an AI agent.

## Step 4: First Contact (Optional)

Ask:

> Want to add your first contact now? Just tell me their name and how you'd send them money (Revolut, Wise, bank transfer).

## Security Reminders

Show these periodically (not every time, but on first run and every ~10 transfers):

- "Reminder: this wallet is controlled by an AI agent. Keep balances low."
- "Your private key is stored in `.env`. If someone accesses your machine, they access the key."
- "For large transfers, consider using UNIGOX directly rather than this skill."

## High Balance Warning

If wallet balance exceeds $500 equivalent, show:

> ⚠️ Your wallet balance is ${balance}. Consider moving excess funds to a more secure wallet. This is an AI-controlled hot wallet — keep only what you need for upcoming transfers.
