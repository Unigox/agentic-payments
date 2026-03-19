# Onboarding — First Run Setup

## When to Trigger

Run this flow when `UNIGOX_PRIVATE_KEY` is not found in the environment or `.env` file and no email session is active.

---

## Step 1: Welcome & Account Choice

The agent introduces the skill and asks how the user wants to set up their account. Present all three options clearly, explain the tradeoff, and let them choose.

**What the agent says:**

> Welcome to Agentic Payments, powered by UNIGOX.
>
> To get started, I need a UNIGOX account to send payments from. There are three ways to set this up:
>
> 1. **Give me my own email** - You give me an email address I can access (like a dedicated agent inbox). I'll handle login completely on my own. Every time I need to make a payment, I log in automatically. You never have to do anything. This is the easiest option if your agent has email access.
>
> 2. **Use your email** - I'll send a login code to your email whenever I need to make a payment. You give me the code, and I proceed. You stay in the loop every time, but it means you'll be prompted for a code each session.
>
> 3. **Give me a wallet key** - If you already have a UNIGOX account, you can export your wallet's private key from the UNIGOX settings and give it to me. I'll use it to log in directly. No codes, no emails, fully autonomous.
>
> Which works best for you?

Wait for the user to choose before proceeding.

---

## Step 2a: Agent Email Flow

User chose option 1 (agent's own email).

**What the agent asks:**

> What email address should I use? This should be an inbox I can read, like a dedicated agent email.

Once the user provides the email:

1. Call `requestEmailOTP()` to send the code
2. Agent reads the code from its own inbox (using Gmail API, IMAP, or whatever email access the agent has)
3. Call `verifyEmailOTP(code)` to log in
4. Call `generateAndLinkWallet()` to create a local wallet and link it to the account
5. Save the private key to `.env` as `UNIGOX_PRIVATE_KEY`
6. Save the email to `.env` as `UNIGOX_EMAIL`

**What the agent says after success:**

> All set. I've created your UNIGOX account and linked a wallet to it.
>
> Wallet: `0x1234...5678`
>
> From now on, I'll log in on my own whenever I need to send a payment. Your private key is stored locally and never leaves this machine.
>
> One thing to keep in mind: treat this wallet like a spending account. Load what you plan to send, not your life savings.

---

## Step 2b: User Email Flow

User chose option 2 (their own email).

**What the agent asks:**

> What's your email address? I'll send a login code there now.

Once the user provides the email:

1. Call `requestEmailOTP()` to send the code
2. Ask the user for the code:

> I just sent a 6-digit code to [email]. What's the code?

3. Call `verifyEmailOTP(code)` to log in
4. Call `generateAndLinkWallet()` to create a local wallet and link it
5. Save the private key to `.env` as `UNIGOX_PRIVATE_KEY`
6. Save the email to `.env` as `UNIGOX_EMAIL`

**What the agent says after success:**

> You're in. I've created your UNIGOX account and linked a wallet.
>
> Wallet: `0x1234...5678`
>
> Since I'm using your email, I'll ask you for a code whenever I need to log in for a payment. Your private key is stored locally.
>
> Keep this wallet light. Load what you plan to send, not your savings.

---

## Step 2c: Wallet Key Flow

User chose option 3 (existing wallet key).

**What the agent asks:**

> Paste your UNIGOX wallet private key here. You can export it from your UNIGOX account settings.
>
> If you don't have a UNIGOX account yet, go to unigox.com, sign up with a web3 wallet like MetaMask or Phantom, then export the key from settings.

Once the user provides the key:

1. Validate it's a valid hex string (64 chars, with or without 0x prefix)
2. Save to `.env` as `UNIGOX_PRIVATE_KEY`
3. Call `login()` to verify it works
4. Fetch profile and balance

**What the agent says after success:**

> Connected. Wallet: `0x1234...5678`
>
> I'll use this key to log in automatically whenever you want to send money. It's stored locally on this machine, nowhere else.
>
> Keep this wallet light. It's a spending account, not a vault.

**If login fails:**

> That key didn't work. Double-check you exported the right one from your UNIGOX account settings. Want to try again?

---

## Step 3: Fund the Wallet

After any signup path, check the balance. If it's zero:

**What the agent says:**

> Your balance is $0. To send money, you'll need to fund your wallet first.
>
> If you already have crypto, send USDC or USDT to your deposit address. I can show it for any chain you want (EVM, Solana, Tron, TON), or you can find it on unigox.com.
>
> If you don't have crypto, you can top up from your bank account. On-ramp is available in EUR, NGN, and KES right now.
>
> Want me to show your deposit address?

---

## Step 4: First Contact

After funding or if user wants to proceed:

**What the agent says:**

> You're ready to send money. You can say things like "send €50 to john on revolut" and I'll handle the rest.
>
> Want to add a contact now? Just tell me their name and how they receive money.

---

## Returning Sessions

When the agent restarts and finds `UNIGOX_PRIVATE_KEY` in `.env`:
- Log in silently using the saved key
- No onboarding needed
- If login fails (expired/revoked), re-run onboarding

When the agent restarts and finds `UNIGOX_EMAIL` but no key:
- Use the email flow to re-authenticate
- Agent email: reads OTP automatically
- User email: asks for the code

---

## Security Reminders

Don't dump these all at once. Weave them in naturally during setup (as shown above) and periodically after every ~10 transfers:

- "Quick reminder: this is a spending wallet. If your balance is getting high, consider moving some out."
- "Your private key is on this machine. Keep your machine secure."

## High Balance Warning

If wallet balance exceeds $500:

> Your balance is at $[amount]. This wallet is meant for spending, not storing. You might want to move some to a more secure wallet.
