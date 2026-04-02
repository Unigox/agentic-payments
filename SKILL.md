---
name: send-money
description: >
  Send money to saved contacts via UNIGOX P2P exchange using natural language.
  Use when: (1) user says "send money to [person]", "pay [person]", "transfer to [person]",
  (2) user wants to manage payment contacts (add, list, update, remove),
  (3) user asks about supported payment methods or currencies,
  (4) user wants to check UNIGOX wallet balance before sending,
  (5) an active send-money session is already in progress and the user is replying with
  follow-up details like "yes", "confirm", amount-only replies, legal name, country,
  city, postal code, street, "KYC done", or receipt confirmation.
  Trigger this skill even when the user only names the recipient and gives no amount yet,
  for example "I wanna send money to Aleksandr". Do not answer those turns from general
  chat context. If a send-money session is active, do not let generic profile, memory,
  or note-taking flows steal follow-up turns that belong to the transfer.
  Supports EUR plus API-driven payout methods for INR, NGN, KES, GHS, and other currencies exposed by UNIGOX.
  Requires a UNIGOX account and at least one auth path: EVM login key, TON wallet auth, or email OTP during onboarding. Full EVM automation also needs the separate UNIGOX-exported EVM signing key.
---

# Send Money

Conversational money transfer via UNIGOX P2P exchange.

## Trigger Gate

If the user says anything equivalent to:
- `I wanna send money to Aleksandr`
- `send money to [person]`
- `pay [person]`
- `transfer to [person]`
- `send [amount] to [person]`
- or the user is already inside an active send-money flow and replies with continuation
  details like:
  - `yes`
  - `confirm`
  - `50 EUR`
  - `My full legal name is Alex Grape and my country is Estonia`
  - `Estonia`
  - `Tallinn`
  - `13511`
  - `Oismae tee 140`
  - `KYC done`
  - `Yes money arrived`

this skill must own the turn immediately.

Do not answer those turns from general memory or generic chat reasoning.
Before any user-facing text, run the session-aware transfer runner:

```bash
cat <<'EOF' | bash skills/send-money/scripts/run-transfer-turn.sh --json
<verbatim user message>
EOF
```

Use the runner JSON as the source of truth for the user-facing reply.

- Send `reply` as the main message body.
- If `options` is present, treat those as structured quick replies.
- When the current channel supports buttons or quick replies, render each option as a button instead of spelling it out in prose. Telegram should get buttons when possible.
- Only fall back to plain text choices when the channel cannot render buttons.
- Do not paraphrase human field labels back into machine keys like `full_name=` once the runner has already formatted them cleanly.
- The shell wrapper self-installs the skill's `scripts/` npm dependencies on first run before launching the TypeScript runner. Do not bypass it with a direct `node ... run-transfer-turn.ts` call unless you have already verified the dependencies are present.

Do not freestyle recipient resolution, saved-recipient lookup, balance wording, onboarding wording, or action choices when the runner can answer them.

Important path rule:
- the runner path above is relative to the OpenClaw workspace root
- do not improvise a different path from memory
- if you are already operating inside the skill directory itself, resolve the equivalent skill-local path explicitly before executing

The runner keeps per-chat state automatically using `OPENCLAW_SESSION_ID` / `OPENCLAW_AGENT_ID`, so repeated turns like:
- `I wanna send money to Aleksandr`
- `50 EUR`
- `confirm`
- `My full legal name is Alex Grape and my country is Estonia`
- `Estonia`
- `Yes money arrived`

must continue through the same saved session file instead of restarting from general chat context.

Important saved-recipient rule:
- saved payout details already present on live UNIGOX count as saved recipients, even if local `contacts.json` is empty
- do not say `I don't have X saved as a contact yet` until both local contacts and live UNIGOX saved payout details were checked
- if the user gives a shortened or fuzzy saved name, like `Aleksandr`, and there is one clear saved beneficiary match such as `Aleksandr Example`, confirm the full saved name and use that saved route instead of falling back to new-recipient collection

Expected pattern:
- `I wanna send money to Aleksandr`
- `I found saved payout details for Aleksandr Example. Should I use that saved recipient?`
- or, if the amount is already present and the match is clear, continue directly into the amount / quote / confirmation flow

## First Run — Onboarding

On first use, check if the environment is configured. Read `references/onboarding.md` and follow it step by step.

**Quick check**: before asking any onboarding question, look for a replayable wallet sign-in path in the user's `.env` / environment: `UNIGOX_EVM_LOGIN_PRIVATE_KEY` for EVM sign-in or `UNIGOX_TON_PRIVATE_KEY` for TON (`UNIGOX_TON_MNEMONIC` is legacy env-only fallback for older installs). Separately check whether the signed-action key is present as `UNIGOX_EVM_SIGNING_PRIVATE_KEY` (legacy alias `UNIGOX_PRIVATE_KEY`). If stored auth is already usable, skip auth-path and key-collection questions, hydrate the current UNIGOX username, and surface the current wallet balance at the start of the send flow. Only ask auth questions for the missing piece (for example the exported signing key). If neither wallet login path is available, do **not** jump straight into generic login instructions. First ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?" If neither path is ready yet, use email OTP as the onboarding / recovery fallback.

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
10. Explain clearly why it is needed: login auth only gets a UNIGOX session; secure in-app actions like funding trade escrow, confirming receipt, and releasing escrow still require the separate exported signing key
11. If the user cannot find the export option in UNIGOX settings, explain that this is a beta feature, their account likely still needs agentic-payments access enabled, and tell them to ask UNIGOX via `hello@unigox.com` or Intercom chat to enable it
12. For transfer runs, do not wait until the last secure action to discover a missing signing key. After any auth path succeeds — EVM, TON, or email OTP — block early on the missing exported signing key and explain the export / beta-access path before continuing with recipient, quote, or trade execution
13. For TON, collect the raw TON address first, echo it back and confirm that it is the correct wallet address/version, then collect the TON private key / secret key for that same wallet, apply the same secret-cleanup rule, verify TON login, and store the TON auth locally for later turns
14. Do not accept TON mnemonic phrases in new chat onboarding. They can derive a different wallet version/address than the one the wallet app actually used on UNIGOX
15. If TON login succeeds but the UNIGOX-exported EVM signing key is still missing, ask for that signing key right away instead of waiting for a later runtime failure
16. Optionally link the other wallet path later if the user wants flexibility
17. If the user wants to top up, do it step by step: first ask which top-up method they want — another UNIGOX user sends to their username, or an external/on-chain deposit
18. If they choose another UNIGOX user, clearly show the current UNIGOX username and tell them to have the other user send funds directly to that username; do not switch into token + chain deposit questions for that internal route
19. If they choose an external/on-chain deposit, keep the existing token-first, then chain/network, then single relevant address flow
20. Use the frontend-supported deposit options as the source of truth for the external/on-chain path: start from `getBridgeTokens()`, keep only routes where `chain.enabled_for_deposit` is true, exclude XAI/internal-only routes, keep only frontend-supported address families (EVM, Solana, Tron/TVM, TON), and model token-specific chain support correctly

**Never skip onboarding warnings.** See `references/onboarding.md` for exact messaging.

## Flow

The reusable orchestration layer now lives in `scripts/transfer-orchestrator.ts`.
The executable turn handler lives in `scripts/run-transfer-turn.ts`.
For the end-to-end map, stage transitions, and unhappy-path handling, see `references/transfer-flow.md`.

For every real send-money turn, use `scripts/transfer-orchestrator.ts` as the source of truth. Do not freestyle recipient resolution, saved-payout matching, payment-method questions, or confirmation wording from general chat context when the orchestrator can answer it.

### 1. Parse Request

Extract from user message:
- **Who**: recipient name/alias ("my mom", "John", "Svetlana")
- **How much**: amount ("€50", "100 euros", "50")
- **Currency**: default EUR

### 2. Resolve Contact

Read `contacts.json` from skill directory. Match by `name` or `aliases` (case-insensitive), and also attempt partial saved-contact resolution when the user only gives part of the saved name.

Saved-recipient resolution order:
1. local `contacts.json`
2. live saved payout details on the user's UNIGOX account

For conversational purposes, live saved payout details are equivalent to saved contacts.

- **Single clear saved-contact match** → confirm the full saved name explicitly before continuing
- **Single clear match + exactly one saved currency / payout setup** → use that stored route as the default instead of asking a broad generic currency question
- **Multiple saved-contact matches** → ask a disambiguation question with the full saved names
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
If stored auth already exists, the flow should also feel stateful at the very start: surface the current username and current balance in the first reply instead of re-asking setup questions.

Example:
> "You're signed in as @grape on UNIGOX. Current wallet balance: 250.00 USD total (USDC: 200.00 USD, USDT: 50.00 USD). Send €50 to Svetlana Example via Revolut (@svetlana)?"

Only execute after explicit user confirmation.

### 5. Execute

Use the UNIGOX client module. See `references/integration.md` for code patterns.

```
1. On flow start, check stored auth first (`UNIGOX_EVM_LOGIN_PRIVATE_KEY`, `UNIGOX_EVM_SIGNING_PRIVATE_KEY` / `UNIGOX_PRIVATE_KEY`, `UNIGOX_TON_PRIVATE_KEY`, legacy `UNIGOX_TON_MNEMONIC`, `UNIGOX_EMAIL`) instead of defaulting to onboarding.
2. If login is needed and no replayable wallet path is configured, ask: "Which wallet connection path should I use to sign in on UNIGOX: EVM wallet connection or TON wallet connection?"
3. If the user has neither path ready, use email OTP as onboarding / recovery, then continue toward their chosen wallet path
4. For EVM, first confirm the user has already signed in on unigox.com with that wallet, then verify login with `UNIGOX_EVM_LOGIN_PRIVATE_KEY`, and only after that require the separate exported signing key before transfer execution
5. Login with the configured auth mode (EVM login key or TON wallet auth)
6. Fetch the current UNIGOX username when available and show it early
7. Check wallet balance early in the same conversational flow, including at flow start when stored auth is already usable, before trade creation and before the final confirmation prompt
8. If balance is insufficient, stop there — do **not** create a trade request
9. Ensure payment detail exists on UNIGOX
10. Create trade request (SELL crypto → fiat to recipient)
11. Report trade request ID to user
12. Wait for vendor match / status and handle the main unhappy paths:
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
- `UNIGOX_TON_PRIVATE_KEY` — TON private key / secret key for agent-side TON proof signing in new installs
- `UNIGOX_TON_MNEMONIC` — legacy env-only TON fallback for older installs
- `UNIGOX_TON_ADDRESS` — raw TON address to use as the wallet source of truth for TON login
- `UNIGOX_TON_NETWORK` — defaults to `-239` (mainnet)
- `UNIGOX_EMAIL` — email OTP onboarding / fallback

**Loading order:**
1. Check process env
2. Check `.env` file in skill directory
3. Check `~/.openclaw/.env`
4. If none found → run onboarding

**Never store the private key, TON private key, or TON mnemonic in contacts.json, SKILL.md, or any tracked file.**

## Rules

- **Always confirm** before executing transfers
- **Never assume** payment details — ask if missing
- **Never fund automated escrow as part of this skill.** `send-money` only funds the live matched trade escrow at that trade's `escrow_address` after vendor match and any required payout-detail completion / revalidation.
- **Surface balance early** in any send flow, before trade creation and before the final confirmation prompt
- **If balance is clearly insufficient, stop before trade creation**
- **Default currency** is EUR
- **Trade type is SELL** (sell crypto to send fiat)
- **Show security warnings** on first run and when balance is high
- **When auth is missing or needs recovery, explicitly ask for the wallet sign-in path first**: EVM wallet connection or TON wallet connection
- **If stored auth is already usable, do not re-ask auth-path or key-collection questions.** Surface the current username and current balance first, then continue the send flow.
- **If the user chooses EVM, do not ask for a key immediately**. First confirm they have already signed in on unigox.com with that wallet; only after that confirmation should you ask for the login wallet key
- **Before requesting either EVM key, show the isolated-wallet warning**: newly created / isolated wallet only, never the main wallet
- **After the user pastes an EVM key, try to delete that message if the runtime supports it**; otherwise instruct the user to delete it themselves and wait for explicit confirmation before continuing
- **Email OTP is fallback**, not the first phrasing for repeatable sign-in. Use it when the chosen wallet path is not ready yet or for recovery
- **TON auth only covers JWT acquisition** — keep using the existing post-login APIs unchanged
- **EVM-signed actions** like receipt confirmation / escrow release, escrow withdraw, and bridge-out require the exported signing key (`UNIGOX_EVM_SIGNING_PRIVATE_KEY` or legacy `UNIGOX_PRIVATE_KEY`)
- **Ask for top-up method first when funding is needed**. Offer at least: another UNIGOX user sends to the user's username, or an external/on-chain deposit
- **Show preflight economics before the top-up ask whenever possible**. Use the best available UNIGOX preflight quote / best-offer data to show the current rate basis, estimated total wallet coverage needed, and the current shortfall before asking how the user wants to fund the wallet
- **Internal UNIGOX top-ups stay internal**. Show the current username clearly, tell the user how much they need to top up, include the rate / quote basis plus an explicit estimate-vs-locked-quote caveat, and do not ask token + chain unless they switch to external deposit
- **Do not dump every deposit address at once**. For the external/on-chain top-up path, ask token first, then network, then return only the one relevant address for that selection
- **Deposit options must come from the real frontend-supported routes** exposed by `getBridgeTokens()` plus the frontend wallet rules (`enabled_for_deposit`, main assets shown to users, XAI excluded, supported address families only)
- **Do not offer unsupported deposit routes** such as NEAR / intent-style paths that are not actually selectable in the frontend deposit flow
- Save new contacts immediately for persistence
