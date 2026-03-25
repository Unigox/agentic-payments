# Onboarding — First Run Setup

## When to Trigger

Run this flow when no replayable wallet sign-in path is configured yet:
- no `UNIGOX_EVM_LOGIN_PRIVATE_KEY`
- no `UNIGOX_TON_MNEMONIC`

Also check separately whether the signed-action key exists as `UNIGOX_EVM_SIGNING_PRIVATE_KEY` (legacy alias `UNIGOX_PRIVATE_KEY`).

Email-only (`UNIGOX_EMAIL`) counts as recovery / bootstrap, not a replayable wallet path.

---

## Step 1: Welcome

> Welcome to Agentic Payments, powered by UNIGOX. This skill lets you send money to anyone just by asking.
>
> Do you already have a UNIGOX account?

Wait for the user to answer before proceeding.

---

## Step 2a: If they already have an account

> To sign in on UNIGOX, I need one wallet connection path I can replay locally. Which wallet connection path should I use: **EVM wallet connection** or **TON wallet connection**?
>
> 1. **EVM wallet connection** — best if you want me to do everything, but this path has **two** EVM credentials: the wallet key you use to sign in, then the separate UNIGOX-exported signing key used for in-app signed actions.
> 2. **TON wallet connection** — good if you want TON-based login/JWT acquisition. Signed EVM actions still need the separate UNIGOX-exported EVM signing key later.
>
> If neither path is ready yet, we can temporarily use **email OTP** for onboarding or recovery and come back to your wallet choice after that.

### If they choose EVM wallet connection

Use this exact sequence:

1. First ask whether they have **already signed in on unigox.com with that EVM wallet**.
2. If not, stop there and tell them to sign in on unigox.com with the wallet first.
3. Before requesting **either** EVM key, show this warning:
   > 🚨🔐 IMPORTANT WALLET SAFETY WARNING 🔐🚨 Use a **NEWLY CREATED / ISOLATED** wallet for UNIGOX agent setup. **Do NOT use your main wallet.** Do not paste a wallet that holds long-term funds.
4. Only after they confirm that sign-in already happened, ask for the **wallet key already used to sign in on UNIGOX**.
5. As soon as they paste that key, try to delete the key-containing message if the runtime/channel supports it.
6. If automatic deletion is unavailable, immediately tell the user to delete that message themselves and wait for explicit `deleted` confirmation before continuing.
7. Save the cleaned-up login key as `UNIGOX_EVM_LOGIN_PRIVATE_KEY`.
8. Clear `UNIGOX_AUTH_MODE` if it was set to `ton`.
9. Call `login()` to verify EVM sign-in works.
10. If login fails:
   - say: "That login wallet key didn't work. Please double-check the wallet that is actually linked to UNIGOX sign-in and try again."
   - do **not** ask for the export key yet.
11. If login succeeds, tell the user their current UNIGOX username and remind them they can change it later in the agent flow or on unigox.com.
12. Then ask for the **separate UNIGOX-exported EVM signing key** from unigox.com settings, with the same isolated-wallet warning.
13. After they paste the signing key, apply the same delete-message / manual-delete-confirmation rule before continuing.
14. Save that second key as `UNIGOX_EVM_SIGNING_PRIVATE_KEY` (legacy alias `UNIGOX_PRIVATE_KEY` still works).
15. Explain that this second key is required for signed actions such as receipt confirmation / escrow release, escrow withdrawals, and bridge-outs.
16. Proceed to Step 3.

Prompt wording for the signing-key step:

> You're currently signed in as @[username] on UNIGOX. You can change that username later in this agent flow or on unigox.com.
>
> 🚨🔐 IMPORTANT WALLET SAFETY WARNING 🔐🚨 Use a **NEWLY CREATED / ISOLATED** wallet for this key. **Do NOT use your main wallet.**
>
> Login works. One more step: please export the separate UNIGOX EVM signing key from your account settings on unigox.com and paste it here. I’ll store it locally on this machine so I can handle signed actions like receipt confirmation / escrow release.
>
> If the export option is not enabled on your account yet, contact UNIGOX support / hello@unigox.com first.

Important implementation note:
- the skill can verify login with the first key
- the skill does **not** currently have a backend/client API to export the second key automatically
- that export still has to happen manually on unigox.com

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
- If they want the agent to finish signed EVM actions too, separately ask for `UNIGOX_EVM_SIGNING_PRIVATE_KEY` after TON login succeeds

---

## Step 2b: If they don't have an account

> No problem, let's create one. First decide which wallet connection path you want me to use for UNIGOX sign-in going forward: **EVM wallet connection** or **TON wallet connection**.
>
> If neither path is ready yet, we can temporarily use **email OTP** for onboarding or recovery, then link the wallet path you chose once you're in.
>
> Which wallet connection path do you want me to end up using: **EVM** or **TON**?

### If they need email OTP first

> What email do you want to use?

Once they provide the email:
1. Call `requestEmailOTP()` to send the code
2. If agent has access to the email inbox: read the code automatically
3. If not: ask the user: "I just sent a 6-digit code to [email]. What's the code?"
4. Call `verifyEmailOTP(code)` to log in
5. Ask: "Now that you're in, which wallet connection path do you want me to use for future UNIGOX sign-in: EVM wallet connection or TON wallet connection?"
6. If EVM:
   - call `generateAndLinkWallet()`
   - save the returned key as `UNIGOX_EVM_LOGIN_PRIVATE_KEY`
   - save `UNIGOX_EMAIL`
   - explain that this generated key is the **login** key only
   - then ask the user to manually export the separate UNIGOX signing key from unigox.com settings and save it as `UNIGOX_EVM_SIGNING_PRIVATE_KEY`
   - proceed to Step 3 only after that second step is acknowledged
7. If TON:
   - collect TON mnemonic/address
   - call `linkTonWallet()`
   - save `UNIGOX_AUTH_MODE=ton`, `UNIGOX_TON_MNEMONIC`, optional `UNIGOX_TON_ADDRESS`, save `UNIGOX_EMAIL`
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
> Once that works, I'll tell you your current UNIGOX username and then ask for the separate UNIGOX-exported signing key from account settings.

When the user provides the login key:
- Try to delete the key-containing message immediately if the runtime/channel supports it
- If not, require the user to delete that message themselves and reply `deleted` before continuing
- Save `UNIGOX_EVM_LOGIN_PRIVATE_KEY`
- Call `login()` and verify it works
- Tell the user their current UNIGOX username and remind them they can change it in the agent flow or on the web
- Only after success, ask for the separate exported signing key and save it as `UNIGOX_EVM_SIGNING_PRIVATE_KEY`
- Apply the same secret-cleanup rule to the signing key message
- Proceed to Step 3

### If they choose TON wallet

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
- First ask which token they want to deposit: the user-facing wallet flow currently exposes main deposit assets such as USDC and USDT
- Fetch / derive the available deposit routes from the same frontend-supported source the wallet UI uses: `getBridgeTokens()` filtered by `chain.enabled_for_deposit`, main user-facing assets, XAI exclusion, and supported address families only (EVM, Solana, Tron/TVM, TON)
- Then ask which supported chain / network they want for that token
- Only after the token + chain are both chosen, show the single relevant deposit address for that route
- Mention they can also find the same address flow on unigox.com
- Do **not** dump every address up front and do **not** mention unsupported routes that are not selectable in the frontend deposit flow (for example NEAR / intent-style routes)
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
- If `UNIGOX_EVM_SIGNING_PRIVATE_KEY` is missing, block transfer execution and ask for the separate exported signing key before proceeding
- If login fails, re-run onboarding and ask which wallet connection path the user wants to use: EVM or TON

When the agent restarts and finds only legacy `UNIGOX_PRIVATE_KEY` in `.env`:
- Treat it as legacy single-key EVM mode
- Attempt silent login with it
- Recommend migrating to split keys if the user actually uses separate login vs exported signing credentials

When the agent restarts and finds `UNIGOX_TON_MNEMONIC` in `.env`:
- Log in silently using TON auth
- If login fails, check `UNIGOX_TON_ADDRESS` and re-run onboarding if needed, again asking which wallet connection path the user wants: EVM or TON

When the agent restarts and finds `UNIGOX_EMAIL` but no replayable key material:
- First ask which wallet connection path the user wants for UNIGOX sign-in: EVM wallet connection or TON wallet connection
- If neither path is ready yet, use the email flow to re-authenticate
- Agent email: reads OTP automatically
- User email: asks for the code

---

## Security Reminders

Don't dump these all at once. Mention naturally during setup and periodically after every ~10 transfers:

- "Quick reminder: this is a spending wallet. If your balance is getting high, consider moving some out."
- "Use a newly created / isolated wallet for UNIGOX agent setup. Never use your main wallet for this flow."
- "Your login wallet key, signing key, or TON mnemonic is on this machine. Keep your machine secure."

## High Balance Warning

If wallet balance exceeds $500:

> Your balance is at $[amount]. This wallet is meant for spending, not storing. You might want to move some to a more secure wallet.
