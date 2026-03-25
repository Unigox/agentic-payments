---
name: send-money
description: >
  Send money to saved contacts via UNIGOX P2P exchange using natural language.
  Use when: (1) user says "send money to [person]", "pay [person]", "transfer to [person]",
  (2) user wants to manage payment contacts (add, list, update, remove),
  (3) user asks about supported payment methods or currencies,
  (4) user wants to check UNIGOX wallet balance before sending.
  Supports EUR plus API-driven payout methods for INR, NGN, KES, GHS, and other currencies exposed by UNIGOX.
  Requires a UNIGOX account and at least one auth path: EVM login key, TON wallet auth, or email OTP during onboarding. Full EVM automation also needs the separate UNIGOX-exported EVM signing key.
---

# Send Money

Conversational money transfer via UNIGOX P2P exchange.

## First Run — Onboarding

On first use, check if the environment is configured. Read `references/onboarding.md` and follow it step by step.

**Quick check**: look for a replayable wallet sign-in path in the user's `.env` / environment: `UNIGOX_EVM_LOGIN_PRIVATE_KEY` for EVM sign-in or `UNIGOX_TON_MNEMONIC` for TON. Separately check whether the signed-action key is present as `UNIGOX_EVM_SIGNING_PRIVATE_KEY` (legacy alias `UNIGOX_PRIVATE_KEY`). If neither wallet login path is available, do **not** jump straight into generic login instructions. First ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?" If neither path is ready yet, use email OTP as the onboarding / recovery fallback.

The onboarding flow:
1. Explain what this skill does and the security model
2. Ask the user which wallet connection path they want to use for UNIGOX sign-in: EVM wallet connection or TON wallet connection
3. If neither wallet path is ready yet, offer email OTP as the temporary onboarding / recovery fallback
4. For EVM, first ask whether they have already signed in on unigox.com with that wallet and instruct them to do so before sharing any key
5. Before requesting **either** EVM key, show a strong warning: 🚨 use a **NEWLY CREATED / ISOLATED wallet only** and **never** the user's main wallet
6. After they confirm the wallet sign-in is already done, collect the **login** wallet key (`UNIGOX_EVM_LOGIN_PRIVATE_KEY`) and verify login works
7. Right after the user pastes an EVM key, try to delete that key-containing chat message if the runtime/channel supports it; otherwise stop and ask the user to delete it themselves, then wait for explicit "deleted" confirmation before continuing
8. After successful EVM login, tell the user their current UNIGOX username and remind them they can change it in the agent flow or on the web
9. Only after successful EVM login, collect and save the separate **UNIGOX-exported signing** key (`UNIGOX_EVM_SIGNING_PRIVATE_KEY`, legacy alias `UNIGOX_PRIVATE_KEY` still supported), with the same isolated-wallet warning and secret-cleanup rule
10. For TON, verify TON login and only ask for an EVM signing key later if signed EVM actions are needed
11. Optionally link the other wallet path later if the user wants flexibility
12. If the user wants to top up, do it step by step: first ask which token they want to deposit, then ask which supported chain/network they want for that token, and only then show the single relevant deposit address
13. Use the frontend-supported deposit options as the source of truth: start from `getBridgeTokens()`, keep only routes where `chain.enabled_for_deposit` is true, exclude XAI/internal-only routes, keep only frontend-supported address families (EVM, Solana, Tron/TVM, TON), and model token-specific chain support correctly

**Never skip onboarding warnings.** See `references/onboarding.md` for exact messaging.

## Flow

The reusable orchestration layer now lives in `scripts/transfer-orchestrator.ts`.
For the end-to-end map, stage transitions, and unhappy-path handling, see `references/transfer-flow.md`.

### 1. Parse Request

Extract from user message:
- **Who**: recipient name/alias ("my mom", "John", "Svetlana")
- **How much**: amount ("€50", "100 euros", "50")
- **Currency**: default EUR

### 2. Resolve Contact

Read `contacts.json` from skill directory. Match by `name` or `aliases` (case-insensitive).

- **Found with details** → run balance preflight, then confirm
- **Found without details** → ask for payment details, save, proceed
- **Not found** → ask for full name, payment method, details, save as new contact

### 3. Collect Missing Info

Do **not** assume EUR-only payout methods anymore.

Preferred flow:

1. Detect or confirm the target fiat currency
2. Ask for the recipient first
3. Fetch live options with `getPaymentMethodsForCurrency(currency)`
4. Ask for the payout provider / bank / method first (do **not** ask for method details in the same breath)
5. If that provider exposes multiple payout routes, ask the exact route next (for example username/tag vs SEPA / bank account)
6. Resolve the required fields with `getPaymentMethodFieldConfig({ currency, methodSlug, networkSlug? })`
7. Validate user input with `validatePaymentDetailInput(details, fields, { countryCode, formatId })`
8. Collect method-specific details one field at a time; if the API/frontend requires `bank_name`, make sure it is collected before moving on
9. Save the normalized details to the contact and proceed

Rule: the frontend/payment-network config is the source of truth for both field selection and validation. Do not add country-specific validation guesses unless the frontend/API does not expose enough detail.

Examples of now-supported live flows:

- **EUR** — Revolut username, Wise, SEPA banks
- **INR** — UPI and IMPS / NEFT transfer
- **NGN** — NIP Nigeria bank and digital-bank payouts (API-driven institution list)
- **KES** — M-PESA, Airtel Money, M-PESA Paybill, Kenyan banks
- **GHS** — MTN MoMo, Vodafone Cash, Telecel Cash, Ghana banks

Static EUR IDs are still documented for convenience. For non-EUR flows, prefer the live API response over hardcoded IDs. Full method + field notes: see `references/payment-methods.md` and `references/field-validators.md`.

If a saved contact already has details for the chosen currency, re-validate those saved details against the live field config before sending. If they are stale or incomplete, switch into field-by-field update mode instead of blindly reusing them.

If the user changes currency or payment method mid-flow, clear the dependent selection/details and re-run live method + field resolution for the new choice.

### 4. Confirm

Always run balance / identity preflight before the final confirmation.

Example:
> "You're signed in as @grape on UNIGOX. Current wallet balance: 250.00 USD. Send €50 to Svetlana Example via Revolut (@svetlana)?"

Only execute after explicit user confirmation.

### 5. Execute

Use the UNIGOX client module. See `references/integration.md` for code patterns.

```
1. If login is needed and no replayable wallet path is configured, ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?"
2. If the user has neither path ready, use email OTP as onboarding / recovery, then continue toward their chosen wallet path
3. For EVM, first confirm the user has already signed in on unigox.com with that wallet, then verify login with `UNIGOX_EVM_LOGIN_PRIVATE_KEY`, and only after that require the separate exported signing key before transfer execution
4. Login with the configured auth mode (EVM login key or TON wallet auth)
5. Fetch the current UNIGOX username when available and tell the user during onboarding / auth confirmation
6. Check wallet balance early in the same conversational flow, before trade creation and before the final confirmation prompt
7. If balance is insufficient, stop there — do **not** create a trade request
8. Ensure payment detail exists on UNIGOX
9. Create trade request (SELL crypto → fiat to recipient)
10. Report trade request ID to user
11. Wait for vendor match / status and handle the main unhappy paths:
   - missing auth
   - insufficient balance
   - invalid field input
   - existing contact with stale details
   - no vendor match / matching timeout
   - save contact only
   - user changes currency or method mid-flow
```

## Contact Management

Contacts persist in `contacts.json` (skill directory). Use `scripts/manage-contacts.ts` for CLI operations.

**Add**: "add mom as contact" → ask name, method, details → save
**List**: "who can I send money to?" → show all contacts
**Update**: "update mom's revolut tag" → update details
**Remove**: "remove John from contacts" → delete

Schema: see `references/contact-schema.md`.

## Environment

Preferred auth environment variables:
- `UNIGOX_EVM_LOGIN_PRIVATE_KEY` — EVM wallet key used to sign in on UNIGOX
- `UNIGOX_EVM_SIGNING_PRIVATE_KEY` — separate UNIGOX-exported EVM key used for signed actions
- `UNIGOX_PRIVATE_KEY` — legacy alias for `UNIGOX_EVM_SIGNING_PRIVATE_KEY` and legacy single-key fallback
- `UNIGOX_AUTH_MODE=ton`
- `UNIGOX_TON_MNEMONIC` — TON mnemonic used only for TON login / linking
- `UNIGOX_TON_ADDRESS` — optional raw TON address override when the derived V4 address does not match the wallet
- `UNIGOX_TON_NETWORK` — defaults to `-239` (mainnet)
- `UNIGOX_EMAIL` — email OTP onboarding / fallback

**Loading order:**
1. Check process env
2. Check `.env` file in skill directory
3. Check `~/.openclaw/.env`
4. If none found → run onboarding

**Never store the private key or TON mnemonic in contacts.json, SKILL.md, or any tracked file.**

## Rules

- **Always confirm** before executing transfers
- **Never assume** payment details — ask if missing
- **Surface balance early** in any send flow, before trade creation and before the final confirmation prompt
- **If balance is clearly insufficient, stop before trade creation**
- **Default currency** is EUR
- **Trade type is SELL** (sell crypto to send fiat)
- **Show security warnings** on first run and when balance is high
- **When auth is missing or needs recovery, explicitly ask for the wallet sign-in path first**: EVM wallet connection or TON wallet connection
- **If the user chooses EVM, do not ask for a key immediately**. First confirm they have already signed in on unigox.com with that wallet; only after that confirmation should you ask for the login wallet key
- **Before requesting either EVM key, show the isolated-wallet warning**: newly created / isolated wallet only, never the main wallet
- **After the user pastes an EVM key, try to delete that message if the runtime supports it**; otherwise instruct the user to delete it themselves and wait for explicit confirmation before continuing
- **Email OTP is fallback**, not the first phrasing for repeatable sign-in. Use it when the chosen wallet path is not ready yet or for recovery
- **TON auth only covers JWT acquisition** — keep using the existing post-login APIs unchanged
- **EVM-signed actions** like receipt confirmation / escrow release, escrow withdraw, and bridge-out require the exported signing key (`UNIGOX_EVM_SIGNING_PRIVATE_KEY` or legacy `UNIGOX_PRIVATE_KEY`)
- **Do not dump every deposit address at once**. For top-ups, ask token first, then network, then return only the one relevant address for that selection
- **Deposit options must come from the real frontend-supported routes** exposed by `getBridgeTokens()` plus the frontend wallet rules (`enabled_for_deposit`, main assets shown to users, XAI excluded, supported address families only)
- **Do not offer unsupported deposit routes** such as NEAR / intent-style paths that are not actually selectable in the frontend deposit flow
- Save new contacts immediately for persistence
