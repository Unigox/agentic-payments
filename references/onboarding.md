# Onboarding — First Run Setup

## When to Trigger

Run this flow when neither `UNIGOX_PRIVATE_KEY` nor `UNIGOX_TON_MNEMONIC` is configured and no email session is active.

---

## Step 1: Welcome

> Welcome to Agentic Payments, powered by UNIGOX. This skill lets you send money to anyone just by asking.
>
> Do you already have a UNIGOX account?

Wait for the user to answer before proceeding.

---

## Step 2a: If they already have an account

> To connect your account, I need one auth path I can replay locally. You can use either:
>
> 1. **EVM private key** — best if you want me to do everything, including EVM-signed withdrawals and bridge-outs.
> 2. **TON wallet auth** — good if you only want TON-based login/JWT acquisition. Sending still works after login, but EVM-signed helper methods still need an EVM key.
>
> Which one do you want to use?

### If they choose EVM private key

> Email hello@unigox.com and request private key export access. Once it's enabled, go to your account settings on unigox.com and export the wallet private key.
>
> Paste it here when you're ready. I store it locally on this machine, nowhere else.

When the user provides the key:
- Validate it's a valid hex string (64 chars, with or without 0x prefix)
- Save to `.env` as `UNIGOX_PRIVATE_KEY`
- Clear `UNIGOX_AUTH_MODE` if it was set to `ton`
- Call `login()` to verify it works
- If login fails: "That key didn't work. Double-check you exported the right one from your UNIGOX account settings. Want to try again?"
- If login succeeds: proceed to Step 3

### If they choose TON wallet auth

> I need your TON wallet mnemonic so I can locally generate the same TON proof your wallet would sign. In most cases I can derive the address, but if your wallet uses a different contract version, I may also need the raw TON address from the wallet app.
>
> Paste the mnemonic and raw address when you're ready. I store them locally on this machine, nowhere else.

When the user provides TON credentials:
- Save to `.env` as:
  - `UNIGOX_AUTH_MODE=ton`
  - `UNIGOX_TON_MNEMONIC=...`
  - `UNIGOX_TON_ADDRESS=0:...` (optional but recommended)
  - `UNIGOX_TON_NETWORK=-239` unless they explicitly use testnet
- Call `login()` to verify TON auth works
- If login fails: ask whether the raw address is correct and mention the wallet may not be using the default V4 derived address
- If login succeeds: proceed to Step 3

---

## Step 2b: If they don't have an account

> No problem, let's create one. You have three options:
>
> 1. **Email** - sign up with an email address. Can be yours or your agent's. If it's the agent's, it can log in on its own whenever needed.
> 2. **Web3 wallet** - sign up with a wallet like MetaMask or Phantom. You'll give the agent the private key directly.
> 3. **TON wallet** - sign up / log in with a TON wallet and let me reuse that wallet for JWT login.
>
> Which do you prefer? I can explain more about any of them if you need.

### If they choose email:

> What email do you want to use?

Once they provide the email:
1. Call `requestEmailOTP()` to send the code
2. If agent has access to the email inbox: read the code automatically
3. If not: ask the user: "I just sent a 6-digit code to [email]. What's the code?"
4. Call `verifyEmailOTP(code)` to log in
5. Ask whether they want to link an EVM wallet now, a TON wallet now, or keep email-only for the moment
6. If EVM: call `generateAndLinkWallet()`, save `UNIGOX_PRIVATE_KEY`, save `UNIGOX_EMAIL`, proceed to Step 3
7. If TON: collect TON mnemonic/address, call `linkTonWallet()`, save `UNIGOX_AUTH_MODE=ton`, `UNIGOX_TON_MNEMONIC`, optional `UNIGOX_TON_ADDRESS`, save `UNIGOX_EMAIL`, proceed to Step 3
8. If email-only: save `UNIGOX_EMAIL`, explain that future re-auth may need another OTP, then proceed to Step 3

### If they choose web3 wallet:

> Sign up at unigox.com with your wallet, then export your private key from the account settings. You'll need to email hello@unigox.com to request export access first.
>
> Paste the key here when you're ready.

When the user provides the key:
- Validate, save to `.env`, call `login()`, verify
- Proceed to Step 3

### If they choose TON wallet:

> Sign up / log in on unigox.com with your TON wallet first, then give me the TON mnemonic plus the raw TON address from the wallet app.
>
> I’ll use that wallet only to generate the TON proof for login. Everything after the JWT stays on the normal UNIGOX APIs.

When the user provides TON credentials:
- Save `UNIGOX_AUTH_MODE=ton`
- Save `UNIGOX_TON_MNEMONIC`
- Save `UNIGOX_TON_ADDRESS` if they provide it
- Call `login()` to verify TON auth works
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
- Log in silently using the saved EVM key
- No onboarding needed
- If login fails (expired/revoked), re-run onboarding

When the agent restarts and finds `UNIGOX_TON_MNEMONIC` in `.env`:
- Log in silently using TON auth
- If login fails, check `UNIGOX_TON_ADDRESS` and re-run onboarding if needed

When the agent restarts and finds `UNIGOX_EMAIL` but no replayable key material:
- Use the email flow to re-authenticate
- Agent email: reads OTP automatically
- User email: asks for the code

---

## Security Reminders

Don't dump these all at once. Mention naturally during setup and periodically after every ~10 transfers:

- "Quick reminder: this is a spending wallet. If your balance is getting high, consider moving some out."
- "Your private key or TON mnemonic is on this machine. Keep your machine secure."

## High Balance Warning

If wallet balance exceeds $500:

> Your balance is at $[amount]. This wallet is meant for spending, not storing. You might want to move some to a more secure wallet.
