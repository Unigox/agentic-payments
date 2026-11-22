---
name: send-money
description: >
  Send money to saved contacts or new recipients through UNIGOX using natural language.
  Use when: (1) user says "send money to [person]", "pay [person]", "transfer to [person]",
  (2) user wants to manage payment contacts (add, list, update, remove),
  (3) user asks about supported payment methods or currencies,
  (4) user wants to check the UNIGOX partner wallet balance before sending,
  (5) an active send-money session is already in progress and the user is replying with
  follow-up details like "yes", "confirm", amount-only replies, legal name, country,
  city, postal code, street, "KYC done", "I want to do KYC", "give me the KYC link",
  "Do I need to do KYC?", "recheck balance", or receipt confirmation.
  Trigger this skill even when the user only names the recipient and gives no amount yet,
  for example "I wanna send money to Aleksandr". Do not answer those turns from general
  chat context. If a send-money session is active, do not let generic profile, memory,
  or note-taking flows steal follow-up turns that belong to the transfer.
  Currencies and payout methods are read live from the UNIGOX Partner API.
  Requires a UNIGOX partner account: a Partner API key and the partner wallet key, configured
  in local settings. The skill never asks for keys in chat.
---

# Send Money

Conversational money transfer through the UNIGOX Partner API, paid from the operator's partner wallet.

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
  - `I want to do KYC`
  - `Give me the KYC link`
  - `Do I need to do KYC?`
  - `Tallinn`
  - `13511`
  - `Oismae tee 140`
  - `KYC done`
  - `recheck balance`
  - `Yes money arrived`
  - or the user asks a question about the current payment state, such as:
  - `what's my balance?`
  - `who am I sending as?`
  - `what stage is this at?`

this skill must own the turn immediately.

Do not answer those turns from general memory or generic chat reasoning.
Before any user-facing text, run the session-aware transfer runner:

```bash
cat <<'EOF_TURN' | bash skills/send-money/scripts/run-transfer-turn.sh --json
<verbatim user message>
EOF_TURN
```

Use the runner JSON as the source of truth for the user-facing reply.

- Send `reply` as the main message body.
- If `options` is present, treat those as structured quick replies.
- When the current channel supports buttons or quick replies, render each option as a button instead of spelling it out in prose. Telegram should get buttons when possible.
- Only fall back to plain text choices when the channel cannot render buttons.
- Do not paraphrase human field labels back into machine keys like `full_name=` once the runner has already formatted them cleanly.
- The shell wrapper self-installs the skill's `scripts/` npm dependencies on first run before launching the TypeScript runner. Do not bypass it with a direct `node ... run-transfer-turn.ts` call unless you have already verified the dependencies are present.

Do not freestyle recipient resolution, saved-recipient lookup, balance wording, setup wording, or action choices when the runner can answer them.

Flow-state rule:
- if the user asks any question about the sender, the wallet, the balance, why a step is needed, or what happened in the flow, pass that question to the runner verbatim and relay the runner's answer
- do not guess, infer from prior runner output, or reconstruct the answer from memory: prior runner output may be stale

KYC continuation rule:
- if the user says `I want to do KYC`, `give me the KYC link`, `complete KYC`, `Do I need to do KYC?`, or similar while the send-money flow is active, pass that turn to the runner verbatim
- do not guess whether the runner wants the legal name, the country, or should repeat the live verification link; relay the runner's KYC answer closely
- UNIGOX requires the sender to be verified before every transfer. There is no amount below which KYC is skipped.

Important path rule:
- the runner path above is relative to the OpenClaw workspace root
- do not improvise a different path from memory
- if you are already operating inside the skill directory itself, resolve the equivalent skill-local path explicitly before executing

The runner keeps per-chat state automatically using `OPENCLAW_SESSION_ID` / `OPENCLAW_AGENT_ID`, so repeated turns like:
- `I wanna send money to Aleksandr`
- `50 EUR`
- `confirm`
- `My full legal name is Alex Grape and my country is Estonia`
- `Yes money arrived`

must continue through the same saved session file instead of restarting from general chat context.

Important saved-recipient rule:
- payout details already saved under the sender on UNIGOX count as saved recipients, even if local `contacts.json` is empty
- do not say `I don't have X saved as a contact yet` until both local contacts and saved UNIGOX payout details were checked
- if the user gives a shortened or fuzzy saved name, like `Aleksandr`, and there is one clear saved match such as `Aleksandr Example`, confirm the full saved name and use that saved route instead of falling back to new-recipient collection

## First Run: Setup

There is no sign-in in chat. The skill needs four local settings:
`UNIGOX_API_KEY`, `UNIGOX_WALLET_PRIVATE_KEY`, `UNIGOX_XAI_RPC_URL`, `UNIGOX_SENDER_EMAIL`.
See `docs/authentication.md` and `references/onboarding.md`.

- If settings are missing, the runner replies with the names of the missing ones. Relay that reply.
- **Never ask the user to paste a key into chat, and never accept one.** Point them to `docs/authentication.md`.
- Saving a contact works without settings. Sending does not.

## Flow

The orchestration layer lives in `scripts/transfer-orchestrator.ts`.
The executable turn handler lives in `scripts/run-transfer-turn.ts`.
For the end-to-end map, stage transitions, and unhappy-path handling, see `references/transfer-flow.md`.

For every real send-money turn, use the runner as the source of truth. Do not freestyle recipient resolution, saved-payout matching, payment-method questions, or confirmation wording from general chat context when the orchestrator can answer it.

### 1. Parse Request

Extract from the user message:
- **Who**: recipient name or alias ("my mom", "John", "Svetlana")
- **How much**: amount ("€50", "100 euros", "50")
- **Currency**: asked when not given

### 2. Resolve Contact

Saved-recipient resolution order:
1. local `contacts.json`
2. payout details saved under the sender on UNIGOX

- **Single clear saved-contact match**: confirm the full saved name explicitly before continuing
- **Single clear match with exactly one saved currency and route**: use that stored route as the default
- **Multiple saved-contact matches**: ask a disambiguation question with the full saved names
- **Not found**: ask for full name, payment method and details, and offer to save as a new contact

### 3. Collect Missing Info

Banks, wallets and required fields come live from the Partner API catalogue. Do not hardcode ids or field lists.

1. Detect or confirm the target fiat currency
2. Ask for the payout provider or bank first
3. If that provider has several payout routes, ask for the exact route next (for example username vs SEPA)
4. Collect the route's fields one at a time; each is validated against the rule the API publishes
5. Offer to save the contact

If a saved contact already has details for the chosen currency, they are re-validated against the live field rules before sending.

### 4. Confirm

The runner checks the partner wallet balance and prices the transfer before the final confirmation.
Only execute after explicit user confirmation.

### 5. Execute

```
1. Check settings; if missing, stop with the setup reply
2. Check the sender's KYC status; if not verified, run the KYC steps first
3. Read the partner wallet balance; if no single asset covers the transfer, stop and ask to fund the wallet
4. Save the payout details under the sender
5. Take a live quote; if it costs more than the confirmed estimate, ask again before placing anything
6. Place the order and wait for a provider to accept it
7. Fund the order's escrow with a local signature
8. Follow the order: ask for receipt confirmation only when the provider does not confirm delivery itself
9. If a funded order stops without a payout, sign the refund back to the partner wallet
```

## Contact Management

Contacts persist in `contacts.json` (skill directory). Use `scripts/manage-contacts.ts` for CLI operations.

**Add**: "add mom as contact" asks name, method and details, then saves
**List**: "who can I send money to?" shows all contacts
**Update**: "update mom's revolut tag" updates details
**Remove**: "remove John from contacts" deletes

Schema: see `references/contact-schema.md`.

## Environment

- `UNIGOX_API_KEY`: Partner API key
- `UNIGOX_WALLET_PRIVATE_KEY`: partner wallet key, used only to sign locally
- `UNIGOX_XAI_RPC_URL`: XAI mainnet node, for the balance read
- `UNIGOX_SENDER_EMAIL`: email of the one verified sender
- `UNIGOX_API_URL`: optional; defaults to production

**Loading order:**
1. process environment
2. `.env` file in the skill directory
3. `~/.openclaw/.env`

**Never store a key in contacts.json, SKILL.md, or any tracked file.**

## Rules

- **Always confirm** before executing transfers
- **Never assume** payment details; ask if missing
- **Never ask for or accept keys in chat**
- **Surface balance early** in any send flow, before the order is placed and before the final confirmation prompt
- **If no single asset covers the transfer, stop before placing the order** and say how to fund the partner wallet (My Wallet on unigox.com)
- **Never spend more than was confirmed**: when the live price is higher than the confirmed estimate, ask again
- **KYC before every transfer**: relay the runner's KYC steps; do not tell the user KYC is optional below some amount
- **Receipt confirmation releases the escrow**: only pass an explicit "received" from the user; "not received" keeps the escrow locked
- **Unknown order states are not guessed**: the runner moves them to manual follow-up and keeps funds where they are
- Save new contacts when the user agrees
