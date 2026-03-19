# Onboarding — First Run Setup

## When to Trigger

Run this flow when `UNIGOX_PRIVATE_KEY` is not found in the environment or `.env` file.

## Step 1: Welcome

---

Welcome to Agentic Payments, powered by UNIGOX.

To get started, you need a UNIGOX account.

You have three options:

- **Use your agent's email** (recommended) - The agent handles everything autonomously. It sends itself an OTP, reads it from its own inbox, and logs in whenever a payment is needed. No action required from you after setup.
- **Use your own email** - You receive the OTP each time the agent needs to log in. More control, but you'll need to provide the code when prompted.
- **Use a web3 wallet** - Create an account with MetaMask, Phantom, etc. Export the private key and give it to the agent. No OTP needed after setup.

Already have an account? Great, let's connect it.

---

## Step 2: Connect wallet

---

Export your wallet private key from UNIGOX account settings and paste it here.

---

### If user provides a key:
- Validate it's a valid hex string (64 chars, with or without 0x prefix)
- Save to `.env` as `UNIGOX_PRIVATE_KEY=<key>`
- Test login: instantiate UnigoxClient, call `login()`, verify success
- Respond: "Connected! Wallet: 0x1234...5678"

### If user wants a new wallet:
- Generate: `const wallet = ethers.Wallet.createRandom()`
- Show address and private key
- "Save this private key somewhere safe. If you lose it, the funds are gone."
- Save to `.env` as `UNIGOX_PRIVATE_KEY=<key>`

## Step 3: Fund

---

Your balance is $0. To send money, fund your wallet:

- **Have crypto?** Send USDC or USDT to your deposit address. I can show it, or find it on unigox.com.
- **No crypto?** Top up from your bank account (EUR, NGN, KES).

---

## Step 4: Ready

---

You're set. Try "send €50 to john on revolut" or "add a contact" to get started.

---

## Security (weave in naturally, don't dump)

Key points to mention briefly during setup:
- Private key stored locally only
- Keep balance low - spending wallet, not vault
- Confirmation before every transfer

## High Balance Warning

If wallet balance exceeds $500, mention: "Your balance is getting high. This wallet is for spending, not storing. Consider moving excess out."
