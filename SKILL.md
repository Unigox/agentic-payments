---
name: send-money
description: >
  Send money to saved contacts via UNIGOX P2P exchange using natural language.
  Use when: (1) user says "send money to [person]", "pay [person]", "transfer to [person]",
  (2) user wants to manage payment contacts (add, list, update, remove),
  (3) user asks about supported payment methods or currencies,
  (4) user wants to check UNIGOX wallet balance before sending.
  Supports EUR plus API-driven payout methods for INR, NGN, KES, GHS, and other currencies exposed by UNIGOX.
  Requires a UNIGOX account and at least one auth path: EVM private key, TON wallet auth, or email OTP during onboarding.
---

# Send Money

Conversational money transfer via UNIGOX P2P exchange.

## First Run — Onboarding

On first use, check if the environment is configured. Read `references/onboarding.md` and follow it step by step.

**Quick check**: look for a replayable wallet sign-in path in the user's `.env` / environment: `UNIGOX_PRIVATE_KEY` for EVM or `UNIGOX_TON_MNEMONIC` for TON. If neither is available, do **not** jump straight into generic login instructions. First ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?" If neither path is ready yet, use email OTP as the onboarding / recovery fallback.

The onboarding flow:
1. Explain what this skill does and the security model
2. Ask the user which wallet connection path they want to use for UNIGOX sign-in: EVM wallet connection or TON wallet connection
3. If neither wallet path is ready yet, offer email OTP as the temporary onboarding / recovery fallback
4. Save the chosen credentials to the project's `.env` file (never in skill files or contacts.json)
5. Verify login works
6. Optionally link the other wallet path later if the user wants flexibility
7. Show deposit addresses so the user can fund the wallet

**Never skip onboarding warnings.** See `references/onboarding.md` for exact messaging.

## Flow

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

### 4. Confirm

Always confirm before executing:
> "Sending €50 to Svetlana Example via Revolut (@svetlana). Proceed?"

Only execute after explicit user confirmation.

### 5. Execute

Use the UNIGOX client module. See `references/integration.md` for code patterns.

```
1. If login is needed and no replayable wallet path is configured, ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?"
2. If the user has neither path ready, use email OTP as onboarding / recovery, then continue toward their chosen wallet path
3. Login with the configured auth mode (EVM private key or TON wallet auth)
4. Check wallet balance (warn if insufficient)
5. Ensure payment detail exists on UNIGOX
6. Create trade request (SELL crypto → fiat to recipient)
7. Report trade request ID to user
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
- `UNIGOX_PRIVATE_KEY` — EVM auth + EVM-signed actions
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
- **EVM-signed actions** like escrow withdraw / bridge-out still require `UNIGOX_PRIVATE_KEY`
- Save new contacts immediately for persistence
