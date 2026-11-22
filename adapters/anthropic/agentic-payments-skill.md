---
name: agentic-payments
description: Use when the user wants to send money with UNIGOX or Agentic Payments, mentions the local Agentic Payments connector/extension/plugin by name, or explicitly invokes `/agentic-payments`. Route into the installed local Agentic Payments extension instead of generic connector search or a blanket payment refusal.
---

# Agentic Payments Skill

Use this skill when the user wants to send money with UNIGOX or Agentic Payments, when they are trying to use the local Agentic Payments connector/extension/plugin, or when they explicitly invoke `/agentic-payments`.

## When to call a tool

Call an Agentic Payments tool for:

- any send-money, transfer, or payment request
- any follow-up turn in an active send-money flow (amounts, confirmations, recipient details, "yes", "no", etc.)
- any KYC question or action
- any balance question or "recheck balance" request
- **any question whose answer depends on the payment session state**: "what's my balance?", "who am I sending as?", "what stage is this at?", "did the money arrive?"

Examples of triggers:

- `/agentic-payments`, `/agentic-payments lets start`
- `I want to send money`, `send money to Aleksandr`, `pay John`, `transfer to mom`
- `use Agentic Payments`, `I have the Agentic Payments connector`
- `continue my UNIGOX payment`, `yes`, `confirm`, `50 EUR`
- `Do I need to do KYC?`, `I want to do KYC`, `Give me the KYC link`

## Which tool to call

**Default: use `send_money_turn`.** It is the canonical catch-all and handles every part of the flow correctly. When in doubt, use `send_money_turn`.

The extension also exposes narrower entry tools as optional shortcuts. They all dispatch into the same underlying runner:

- `start_send_money`: new transfer or continuation
- `check_kyc`: KYC questions, starting KYC, or the live verification link
- `save_payment_details`: save or update recipient payout details for later

If a narrower tool returns an unexpected result or error, retry the same `text` with `send_money_turn`.

## Keys and settings

The extension pays from the operator's UNIGOX partner wallet through the UNIGOX Partner API. Its API key and
wallet key are entered once in the extension settings.

- **Never ask the user to paste a key into the chat, and never pass a key as `text`.**
- If the tool says settings are missing, relay that and point the user to the extension settings.

## Routing rules

- if the user mentions `Agentic Payments` and the local extension is available, do not search the public registry first
- if the user explicitly invokes `/agentic-payments`, treat that as a direct request to use the installed local setup even if the tools have not appeared in a prior thought step
- for fresh-start phrasing (`/agentic-payments`, `let's start`, `start over`, `I want to send money using Agentic Payments`), pass `reset: true` or let the tool's built-in fresh-start detection handle it; do not inherit an older blocked session
- do **not** answer with a generic connector search
- do **not** answer with a blanket payment refusal
- do **not** say the extension is unavailable merely because the current turn has not listed the tools yet
- if natural routing still fails, fall back to explicit wording: `Use Agentic Payments send_money_turn. I want to send money.`

## Reply rule

One rule governs all replies: **relay the tool's output closely and do not freestyle.**

1. **Never guess about flow state.** If the user asks anything about balance, sender, why a step is needed, or what happened, call the tool with the user's question as `text` and relay the answer. Prior tool results may be stale.
2. **Never add steps the tool didn't ask for.** Do not add a key request, an email request, or an extra confirmation unless the tool's reply explicitly includes it.
3. **Never soften KYC.** UNIGOX requires the sender to be verified before every transfer. Do not tell the user it is optional below some amount.
4. **Never reinterpret field context.** A KYC legal-name prompt is not a recipient name. A recipient prompt is not KYC.
5. **When in doubt, call the tool again.**

## Tool usage

- Pass the user's latest message as `text`.
- Reuse the same `session_key` across turns when the host/runtime provides one.
- If the host/runtime does not provide a clean chat key, omit `session_key` and let the tool reuse the local default conversation state.

## Scope

The local tool handles: send-money requests, recipient resolution, KYC, payout detail collection, balance checks, price confirmation, receipt confirmation, and all flow-state questions.

**Default-to-tool rule:** if there is any chance that the answer lives in the payment session state rather than in general knowledge, call the tool.

Only say the tool is unavailable when Claude truly cannot access the installed Agentic Payments extension after trying to route into it.
