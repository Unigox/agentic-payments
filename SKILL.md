---
name: send-money
description: >
  Send money to saved contacts via UNIGOX P2P exchange using natural language.
  Use when: (1) user says "send money to [person]", "pay [person]", "transfer to [person]",
  (2) user wants to manage payment contacts (add, list, update, remove),
  (3) user asks about supported payment methods or currencies,
  (4) user wants to check UNIGOX wallet balance before sending.
  Supports EUR (Revolut, Wise, SEPA, N26, LHV, Coop Pank) with extensible currency support.
  Requires a UNIGOX account and wallet private key.
---

# Send Money

Conversational money transfer via UNIGOX P2P exchange.

## First Run — Onboarding

On first use, check if the environment is configured. Read `references/onboarding.md` and follow it step by step.

**Quick check**: look for `UNIGOX_PRIVATE_KEY` in the user's `.env` or environment. If not found, start the onboarding flow.

The onboarding flow:
1. Explain what this skill does and the security model
2. Ask the user to provide or import a wallet private key
3. Save it to the project's `.env` file (never in skill files or contacts.json)
4. Verify login works
5. Show deposit addresses so the user can fund the wallet

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

EUR payment methods and required fields:

| Method | Key | Required Fields |
|--------|-----|----------------|
| Revolut | `revolut` | `revtag` (e.g. `@username`) |
| Wise | `wise` | `iban`, `full_name` |
| N26 | `n26` | `iban`, `full_name` |
| LHV Bank | `lhv` | `iban`, `full_name` |
| Coop Pank | `coop` | `iban`, `full_name` |
| Other SEPA | `sepa` | `iban`, `full_name`, `bank_name` |

Full method IDs and network IDs: see `references/payment-methods.md`.

### 4. Confirm

Always confirm before executing:
> "Sending €50 to Svetlana Example via Revolut (@svetlana). Proceed?"

Only execute after explicit user confirmation.

### 5. Execute

Use the UNIGOX client module. See `references/integration.md` for code patterns.

```
1. Login with private key
2. Check wallet balance (warn if insufficient)
3. Ensure payment detail exists on UNIGOX
4. Create trade request (SELL crypto → fiat to recipient)
5. Report trade request ID to user
```

## Contact Management

Contacts persist in `contacts.json` (skill directory). Use `scripts/manage-contacts.ts` for CLI operations.

**Add**: "add mom as contact" → ask name, method, details → save
**List**: "who can I send money to?" → show all contacts
**Update**: "update mom's revolut tag" → update details
**Remove**: "remove John from contacts" → delete

Schema: see `references/contact-schema.md`.

## Environment

The private key is stored in the project `.env` file as `UNIGOX_PRIVATE_KEY`. 

**Loading order:**
1. Check `UNIGOX_PRIVATE_KEY` env var
2. Check `.env` file in skill directory
3. Check `~/.openclaw/.env`
4. If none found → run onboarding

**Never store the private key in contacts.json, SKILL.md, or any tracked file.**

## Rules

- **Always confirm** before executing transfers
- **Never assume** payment details — ask if missing
- **Check balance** before attempting (warn if insufficient)
- **Default currency** is EUR
- **Trade type is SELL** (sell crypto to send fiat)
- **Show security warnings** on first run and when balance is high
- Save new contacts immediately for persistence
