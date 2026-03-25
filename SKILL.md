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

**Quick check**: look for a replayable wallet sign-in path in the user's `.env` / environment: `UNIGOX_EVM_LOGIN_PRIVATE_KEY` (or legacy `UNIGOX_PRIVATE_KEY`) for EVM or `UNIGOX_TON_MNEMONIC` for TON. If neither is available, do **not** jump straight into generic login instructions. First ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?" If neither path is ready yet, use email OTP as the onboarding / recovery fallback.

The onboarding flow:
1. Explain what this skill does and the security model
2. Ask the user which wallet connection path they want to use for UNIGOX sign-in: EVM wallet connection or TON wallet connection
3. If neither wallet path is ready yet, offer email OTP as the temporary onboarding / recovery fallback
4. For EVM, collect and save the **login** wallet key first (`UNIGOX_EVM_LOGIN_PRIVATE_KEY`), then verify login works
5. Only after successful EVM login, collect and save the separate **UNIGOX-exported signing** key (`UNIGOX_EVM_SIGNING_PRIVATE_KEY`, legacy alias `UNIGOX_PRIVATE_KEY` still supported)
6. For TON, verify TON login and only ask for an EVM signing key later if signed EVM actions are needed
7. Optionally link the other wallet path later if the user wants flexibility
8. Show deposit addresses so the user can fund the wallet

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

- **Found with details** → proceed to confirm
- **Found without details** → ask for payment details, save, proceed
- **Not found** → ask for full name, payment method, details, save as new contact

### 3. Collect Missing Info

Do **not** assume EUR-only payout methods anymore.

Preferred flow:

1. Detect or confirm the target fiat currency
2. Fetch live options with `getPaymentMethodsForCurrency(currency)`
3. Pick the exact payment method + network from the API result
4. Resolve the required fields with `getPaymentMethodFieldConfig({ currency, methodSlug, networkSlug? })`
5. Validate user input with `validatePaymentDetailInput(details, fields, { countryCode, formatId })`
6. Save the normalized details to the contact and proceed

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

Always confirm before executing:
> "Sending €50 to Svetlana Example via Revolut (@svetlana). Proceed?"

Only execute after explicit user confirmation.

### 5. Execute

Use the UNIGOX client module. See `references/integration.md` for code patterns.

```
1. If login is needed and no replayable wallet path is configured, ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?"
2. If the user has neither path ready, use email OTP as onboarding / recovery, then continue toward their chosen wallet path
3. For EVM, verify login with `UNIGOX_EVM_LOGIN_PRIVATE_KEY` first, then require the separate exported signing key before transfer execution
4. Login with the configured auth mode (EVM login key or TON wallet auth)
5. Check wallet balance (warn if insufficient)
6. Ensure payment detail exists on UNIGOX
7. Create trade request (SELL crypto → fiat to recipient)
8. Report trade request ID to user
9. Wait for vendor match / status and handle the main unhappy paths:
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
- **Check balance** before attempting (warn if insufficient)
- **Default currency** is EUR
- **Trade type is SELL** (sell crypto to send fiat)
- **Show security warnings** on first run and when balance is high
- **When auth is missing or needs recovery, explicitly ask for the wallet sign-in path first**: EVM wallet connection or TON wallet connection
- **Email OTP is fallback**, not the first phrasing for repeatable sign-in. Use it when the chosen wallet path is not ready yet or for recovery
- **TON auth only covers JWT acquisition** — keep using the existing post-login APIs unchanged
- **EVM-signed actions** like receipt confirmation / escrow release, escrow withdraw, and bridge-out require the exported signing key (`UNIGOX_EVM_SIGNING_PRIVATE_KEY` or legacy `UNIGOX_PRIVATE_KEY`)
- Save new contacts immediately for persistence
