# Onboarding — First Run Setup

## When to Trigger

Run this flow when no replayable wallet sign-in path is configured yet:
- no `UNIGOX_EVM_LOGIN_PRIVATE_KEY`
- no `UNIGOX_TON_PRIVATE_KEY` (legacy `UNIGOX_TON_MNEMONIC` still counts for older installs)

Email-only (`UNIGOX_EMAIL`) counts as recovery / bootstrap, not a replayable wallet path.

---

## Step 1: Welcome

> Welcome to Agentic Payments, powered by UNIGOX. This skill lets you send money to anyone just by asking.
>
> Do you already have a UNIGOX account?

Wait for the user to answer before proceeding.

---

## Step 2a: If they already have an account

> To sign in on UNIGOX, I need one path I can replay locally. Which setup should I use: **EVM wallet connection**, **TON wallet connection**, **create a dedicated EVM wallet on this device**, or **create a dedicated TON wallet on this device**?
>
> 1. **EVM wallet connection** — best if you already have an EVM wallet linked to UNIGOX and want me to reuse that login.
> 2. **TON wallet connection** — best if you already use a TON wallet on UNIGOX.
> 3. **Create a dedicated EVM wallet on this device** — best beginner path if you want me to generate and keep the login wallet locally on this machine, so you never have to paste the EVM login key.
> 4. **Create a dedicated TON wallet on this device** — same beginner path for TON; I generate the TON login wallet locally and keep the replayable TON key on this machine.
>
> The dedicated-wallet paths do **not** require email OTP. If neither wallet path is ready yet, we can temporarily use **email OTP** for onboarding or recovery and come back to your wallet choice after that.

### If they choose EVM wallet connection

Use this exact sequence:

1. First ask whether they have **already signed in on unigox.com with that EVM wallet**.
2. If not, stop there and tell them to sign in on unigox.com with the wallet first.
3. Before requesting the EVM login key, show this warning:
   > 🚨🔐 IMPORTANT WALLET SAFETY WARNING 🔐🚨 Use a **NEWLY CREATED / ISOLATED** wallet for UNIGOX agent setup. **Do NOT use your main wallet.** Do not paste a wallet that holds long-term funds.
4. Only after they confirm that sign-in already happened, ask for the **wallet key already used to sign in on UNIGOX**.
5. As soon as they paste that key, try to delete the key-containing message if the runtime/channel supports it.
6. If automatic deletion is unavailable, immediately tell the user to delete that message themselves and wait for explicit `deleted` confirmation before continuing.
7. Save the cleaned-up login key as `UNIGOX_EVM_LOGIN_PRIVATE_KEY`.
8. Clear `UNIGOX_AUTH_MODE` if it was set to `ton`.
9. Call `login()` to verify EVM sign-in works.
10. If login fails, say: "That login wallet key didn't work. Please double-check the wallet that is actually linked to UNIGOX sign-in and try again."
11. If login succeeds, tell the user their current UNIGOX username and remind them they can change it later in the agent flow or on unigox.com.
12. Proceed to Step 3.

Once login succeeds, signed in-app actions (escrow funding, receipt confirmation / release, bridge-outs) are handled server-side by the privy-signing backend using the active UNIGOX session — no extra key collection step.

### If they choose TON wallet auth

> For TON, send me the **exact raw TON address** shown by the wallet you used on UNIGOX first.
>
> I’ll echo it back and ask you to confirm whether that exact address/version is the right one.
> After that, you can choose one of three login paths for that same wallet:
> 1. send the mnemonic phrase
> 2. send the TON private key / secret key
> 3. say `TonConnect QR` and I’ll generate a fresh live TonConnect deep link / QR
>
> For the mnemonic/private-key paths, I’ll check the supported TON wallet versions locally and keep the one that actually matches this exact address.
> For TonConnect, I’ll only accept the connection if the wallet comes back as this exact address. Old screenshots of previous QR codes are not reusable login credentials.

When the user provides TON credentials:
- Save to `.env` as:
  - `UNIGOX_AUTH_MODE=ton`
  - `UNIGOX_TON_PRIVATE_KEY=...` or `UNIGOX_TON_MNEMONIC=...`
  - `UNIGOX_TON_ADDRESS=0:...`
  - `UNIGOX_TON_NETWORK=-239` unless they explicitly use testnet
- Call `login()` to verify TON auth works
- If login fails: ask whether the raw TON address is the exact wallet address/version used on UNIGOX
- If login succeeds: proceed to Step 3

---

## Step 2b: If they don't have an account

> No problem, let's create one. First decide which sign-in setup you want me to end up using for UNIGOX going forward: **EVM wallet connection**, **TON wallet connection**, **create a dedicated EVM wallet on this device**, or **create a dedicated TON wallet on this device**.
>
> If neither path is ready yet, we can temporarily use **email OTP** for onboarding or recovery, then link or generate the wallet path you chose once you're in.
>
> Which sign-in setup do you want me to end up using: **EVM**, **TON**, **generated EVM**, or **generated TON**?

### If they need email OTP first

> What email do you want to use?

Once they provide the email:
1. Call `requestEmailOTP()` to send the code
2. If agent has access to the email inbox: read the code automatically
3. If not: ask the user: "I just sent a 6-digit code to [email]. What's the code?"
4. Call `verifyEmailOTP(code)` to log in
5. Ask: "Now that you're in, should I create a dedicated EVM wallet on this device, create a dedicated TON wallet on this device, or stay on email OTP for now?"
6. If generated EVM:
   - call `generateAndLinkWallet()`
   - save the returned key as `UNIGOX_EVM_LOGIN_PRIVATE_KEY`
   - save `UNIGOX_EMAIL`
   - explain that this generated key is the **login** key only and was created locally from cryptographic randomness
   - for website login, do **not** mention TonConnect; tell the user to use the EVM wallet-connection flow on unigox.com for that same wallet
   - if they want to use the generated wallet in a browser wallet first, remind them they can say `export this wallet`, import it into an isolated EVM wallet app or extension, and complete the WalletConnect-style / browser-wallet approval there
   - proceed to Step 3
7. If generated TON:
   - call `generateAndLinkTonWallet()`
   - save `UNIGOX_AUTH_MODE=ton`, `UNIGOX_TON_PRIVATE_KEY`, `UNIGOX_TON_ADDRESS`, `UNIGOX_TON_WALLET_VERSION`, and `UNIGOX_EMAIL`
   - explain that this generated TON key is the replayable **login** key only and was created locally from cryptographic randomness
   - proceed to Step 3
8. If they want to stay email-only for now:
   - save `UNIGOX_EMAIL`
   - explain that future re-auth may need another OTP and that they can later choose EVM or TON as the replayable wallet path
   - proceed to Step 3

### If they choose EVM wallet connection directly

> Have you already signed in on unigox.com with the EVM wallet you want me to reuse? If not, do that first.
>
> 🚨🔐 IMPORTANT WALLET SAFETY WARNING 🔐🚨 Use a **NEWLY CREATED / ISOLATED** wallet for UNIGOX agent setup. **Do NOT use your main wallet.**
>
> After you confirm that sign-in is done, give me the private key for the wallet you actually use to sign in on UNIGOX so I can verify login.
>
> Once that works, I'll tell you your current UNIGOX username and we're ready to send.

When the user provides the login key:
- Try to delete the key-containing message immediately if the runtime/channel supports it
- If not, require the user to delete that message themselves and reply `deleted` before continuing
- Save `UNIGOX_EVM_LOGIN_PRIVATE_KEY`
- Call `login()` and verify it works
- Tell the user their current UNIGOX username and remind them they can change it in the agent flow or on the web
- Proceed to Step 3

### If they choose TON wallet

> Sign up / log in on unigox.com with your TON wallet first, then give me the exact raw TON address from the wallet app.
>
> I’ll confirm that exact address/version with you, then let you choose how to finish login for that same wallet:
> - send the mnemonic phrase
> - send the TON private key / secret key
> - or use a fresh TonConnect deep link / QR
>
> For mnemonic/private-key flows, I’ll derive supported wallet versions locally until one matches the exact address. For TonConnect, I’ll only accept the wallet if it comes back as that exact address. Everything after the JWT stays on the normal UNIGOX APIs.

When the user provides TON credentials:
- Save `UNIGOX_AUTH_MODE=ton`
- Save `UNIGOX_TON_PRIVATE_KEY`
- Save `UNIGOX_TON_ADDRESS` if they provide it
- Save `UNIGOX_TON_WALLET_VERSION` after local version matching
- Call `login()` to verify TON auth works
- Proceed to Step 3

---

## Step 3: Add contacts

> You're in! Let's add some people you want to send money to.
>
> We'll do this step by step: **recipient name first**, then **payment method / bank**, then the **method-specific details**.
>
> Example sequence:
> 1. "Add Mom"
> 2. "Revolut" or "Wise"
> 3. If needed, choose the route (for example username/tag vs SEPA / bank account)
> 4. Then give the requested detail fields one at a time
>
> Who do you want to add first?

Let the user add as many contacts as they want. When they're done or say they want to move on, proceed to Step 4.

---

## Step 4: Funding

> We're all set. Now, in order to send money, we need to have a little balance. You can top up your balance when we're sending it, or you can top up in advance so the sending is faster. Which one would you like to go with?

If they want to top up now:
- First ask which top-up method they want:
  - another UNIGOX user sends funds directly to their username
  - external / on-chain deposit
- Before the top-up ask, load the best available preflight quote / best-offer data if UNIGOX exposes it for the exact payout route. Show the current rate basis, the estimated total wallet coverage needed, and the current shortfall in the same flow. If it is not a locked quote, label it clearly as an estimate and explain that the final matched rate / required amount can still change.
- If they choose the internal UNIGOX route:
  - clearly show their current UNIGOX username
  - tell them exactly how much they still need to top up based on that preflight quote / estimate
  - tell them to have the other UNIGOX user send funds directly to that username
  - do **not** switch into token + chain questions for this route unless they explicitly change to external deposit
- If they choose the external / on-chain route:
  - first ask which token they want to deposit: the user-facing wallet flow currently exposes main deposit assets such as USDC and USDT
  - fetch / derive the available deposit routes from the same frontend-supported source the wallet UI uses: `getBridgeTokens()` filtered by `chain.enabled_for_deposit`, main user-facing assets, XAI exclusion, and supported address families only (EVM, Solana, Tron/TVM, TON)
  - then ask which supported chain / network they want for that token
  - only after the token + chain are both chosen, show the single relevant deposit address for that route
  - mention they can also find the same address flow on unigox.com
  - do **not** dump every address up front and do **not** mention unsupported routes that are not selectable in the frontend deposit flow (for example NEAR / intent-style routes)
- If no crypto: mention on-ramp available in EUR, NGN, and KES

If they want to top up later: that's fine, proceed to Step 5.

---

## Step 5: Ready

> You're good to go. Just say "send €50 to mom" and I'll handle the rest.
>
> Before any trade is created, I'll show your current balance and do the preflight checks in the same chat flow. I'll always ask for final confirmation before sending.

---

## Returning Sessions

When the agent restarts and finds `UNIGOX_EVM_LOGIN_PRIVATE_KEY` in `.env`:
- Log in silently using the saved EVM login key
- At the start of the next send flow, surface the current UNIGOX username and current wallet balance instead of re-asking auth-path questions
- If login fails, re-run onboarding and ask which wallet connection path the user wants to use: EVM or TON

When the agent restarts and finds `UNIGOX_TON_PRIVATE_KEY` in `.env`:
- Log in silently using TON auth
- At the start of the next send flow, surface the current UNIGOX username and current wallet balance instead of restarting onboarding
- If login fails, check `UNIGOX_TON_ADDRESS` and re-run onboarding if needed, again asking which wallet connection path the user wants: EVM or TON

When the agent restarts and finds legacy `UNIGOX_TON_MNEMONIC` in `.env`:
- Keep supporting that older install for backward compatibility
- Do not ask for mnemonic phrases again in new chat onboarding
- Prefer migrating the machine to `UNIGOX_TON_PRIVATE_KEY` plus `UNIGOX_TON_ADDRESS` when the user reconfigures TON auth

When the agent restarts and finds `UNIGOX_EMAIL` but no replayable key material:
- First ask which sign-in setup the user wants for UNIGOX: direct EVM, direct TON, generated EVM, or generated TON
- If the user explicitly chooses a dedicated EVM or TON wallet path, generate that login wallet directly without forcing email first
- If neither path is ready yet, use the email flow to re-authenticate and then offer the generated wallet setup
- Agent email: reads OTP automatically
- User email: asks for the code

---

## Security Reminders

Don't dump these all at once. Mention naturally during setup and periodically after every ~10 transfers:

- "Quick reminder: this is a spending wallet. If your balance is getting high, consider moving some out."
- "Use a newly created / isolated wallet for UNIGOX agent setup. Never use your main wallet for this flow."
- "Your login wallet key or TON private key is on this machine. Keep your machine secure."

## High Balance Warning

If wallet balance exceeds $500:

> Your balance is at $[amount]. This wallet is meant for spending, not storing. You might want to move some to a more secure wallet.
