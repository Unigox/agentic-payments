# Onboarding — First Run Setup

## When to Trigger

Run this flow when `UNIGOX_PRIVATE_KEY` is not found in the environment or `.env` file and no email session is active.

---

## Step 1: Welcome

> Welcome to Agentic Payments, powered by UNIGOX. This skill lets you send money to anyone just by asking.
>
> Do you already have a UNIGOX account?

Wait for the user to answer before proceeding.

---

## Step 2a: If they already have an account

> To connect your account, I need a way to sign transactions on your behalf. On UNIGOX, your wallet has a private key. Think of it like a password that lets me send payments from your account. UNIGOX never holds your funds. Every transaction is signed with this key, which means only whoever has it can move money.
>
> To get your key, email hello@unigox.com and request private key export access. Once it's enabled, go to your account settings on unigox.com and export it.
>
> Paste it here when you're ready. I store it locally on this machine, nowhere else.

When the user provides the key:
- Validate it's a valid hex string (64 chars, with or without 0x prefix)
- Save to `.env` as `UNIGOX_PRIVATE_KEY`
- Call `login()` to verify it works
- If login fails: "That key didn't work. Double-check you exported the right one from your UNIGOX account settings. Want to try again?"
- If login succeeds: proceed to Step 3

---

## Step 2b: If they don't have an account

> No problem, let's create one. You have two options:
>
> 1. **Email** - sign up with an email address. Can be yours or your agent's. If it's the agent's, it can log in on its own whenever needed.
> 2. **Web3 wallet** - sign up with a wallet like MetaMask or Phantom. You'll give the agent the private key directly.
>
> Which do you prefer? I can explain more about either one if you need.

### If they choose email:

> What email do you want to use?

Once they provide the email:
1. Call `requestEmailOTP()` to send the code
2. If agent has access to the email inbox: read the code automatically
3. If not: ask the user: "I just sent a 6-digit code to [email]. What's the code?"
4. Call `verifyEmailOTP(code)` to log in
5. Call `generateAndLinkWallet()` to create a local wallet and link it
6. Save private key to `.env` as `UNIGOX_PRIVATE_KEY`
7. Save email to `.env` as `UNIGOX_EMAIL`
8. Proceed to Step 3

### If they choose web3 wallet:

> Sign up at unigox.com with your wallet, then export your private key from the account settings. You'll need to email hello@unigox.com to request export access first.
>
> Paste the key here when you're ready.

When the user provides the key:
- Validate, save to `.env`, call `login()`, verify
- Proceed to Step 3

---

## Step 3: Add contacts

> You're in! Let's add some people you want to send money to. Just tell me their name and how they receive payments. For example:
>
> "Add Mom - Revolut @momname"
> "Add John - Wise, IBAN EE1234..."
>
> Who do you want to add first?

Let the user add as many contacts as they want. When they're done or say they want to move on, proceed to Step 4.

---

## Step 4: Funding

> We're all set. Now, in order to send money, we need to have a little balance. You can top up your balance when we're sending it, or you can top up in advance so the sending is faster. Which one would you like to go with?

If they want to top up now:
- Show deposit address for their preferred chain
- Mention they can also find it on unigox.com
- If no crypto: mention on-ramp available in EUR, NGN, and KES

If they want to top up later: that's fine, proceed to Step 5.

---

## Step 5: Ready

> You're good to go. Just say "send €50 to mom" and I'll handle the rest. I'll always confirm with you before sending.

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

Don't dump these all at once. Mention naturally during setup and periodically after every ~10 transfers:

- "Quick reminder: this is a spending wallet. If your balance is getting high, consider moving some out."
- "Your private key is on this machine. Keep your machine secure."

## High Balance Warning

If wallet balance exceeds $500:

> Your balance is at $[amount]. This wallet is meant for spending, not storing. You might want to move some to a more secure wallet.
