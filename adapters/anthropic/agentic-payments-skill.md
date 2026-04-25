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
- any auth, sign-in, wallet, or key-related action
- any KYC question or action
- any wallet export or backup request
- **any question whose answer depends on UNIGOX session state** — "how did you log in?", "what's my balance?", "why do you need that key?", "what wallet am I using?", "what stage is this at?", etc.

Examples of triggers:

- `/agentic-payments`, `/agentic-payments lets start`
- `I want to send money`, `send money to Aleksandr`, `pay John`, `transfer to mom`
- `use Agentic Payments`, `I have the Agentic Payments connector`
- `continue my UNIGOX payment`, `yes`, `confirm`, `50 EUR`
- `Help me sign in to UNIGOX`, `Create a dedicated TON wallet`
- `Do I need to do KYC?`, `Can I do KYC earlier?`, `Give me the KYC link`
- `export this wallet`, `backup my generated wallet`, `export my EVM wallet`
- `how did you log in?`, `what auth method am I using?`, `what's my username?`

## Which tool to call

**Default: use `send_money_turn`.** It is the canonical catch-all and handles every part of the flow correctly. When in doubt, use `send_money_turn`.

The extension also exposes narrower entry tools as optional shortcuts. They all dispatch into the same underlying runner — choosing the wrong one is harmless, but choosing the right one can improve discoverability:

- `start_send_money` — new transfer or continuation (optional shortcut for `send_money_turn`)
- `sign_in_unigox` — auth setup, wallet connection, browser-login approval
- `create_wallet` — generate a dedicated local EVM or TON wallet
- `export_wallet` — export a generated login wallet to a local file
- `check_kyc` — KYC threshold questions, early KYC, or live KYC-link requests
- `save_payment_details` — save or update recipient payout details for later

If a narrower tool returns an unexpected result or error, retry the same `text` with `send_money_turn`.

## Routing rules

- if the user mentions `Agentic Payments` and the local extension is available, do not search the public registry first
- if the user explicitly invokes `/agentic-payments`, treat that as a direct request to use the installed local setup even if the tools have not appeared in a prior thought step
- for fresh-start phrasing (`/agentic-payments`, `let's start`, `start over`, `I want to send money using Agentic Payments`), pass `reset: true` or let the tool's built-in fresh-start detection handle it — do not inherit an older blocked session
- do **not** answer with a generic connector search
- do **not** answer with a blanket payment refusal
- do **not** say the extension is unavailable merely because the current turn has not listed the tools yet
- if natural routing still fails, fall back to explicit wording: `Use Agentic Payments send_money_turn. I want to send money.`

## Reply rule

One rule governs all replies: **relay the tool's output closely and do not freestyle.**

Specific constraints:

1. **Never guess about flow state.** If the user asks anything about auth method, balance, username, why a step is needed, or what happened — call the tool with the user's question as `text` and relay the answer. The tool has the session state; you do not. Prior tool results may be stale.
2. **Never add steps the tool didn't ask for.** Do not add an email request, a key request, or an extra confirmation unless the tool's reply explicitly includes it.
3. **Never paraphrase protocol names.** When the tool says "WalletConnect" or "wc:", relay exactly that — do not substitute "TonConnect" or "tc://". When the tool says "TonConnect" or "tc://", do not substitute "WalletConnect" or "wc:". These are different protocols for different wallet types (EVM vs TON).
4. **Never reinterpret field context.** A KYC legal-name prompt is not a recipient name. A recipient prompt is not KYC.
5. **When in doubt, call the tool again.** The cost of an extra tool call is near zero. The cost of a wrong freestyle answer breaks trust.

## Tool usage

- Pass the user's latest message as `text`.
- Reuse the same `session_key` across turns when the host/runtime provides one.
- If the host/runtime does not provide a clean chat key, omit `session_key` and let the tool reuse the local default conversation state.
- If the user shares a fresh UNIGOX browser-login QR screenshot and the host can supply a local file path, pass it as `image_path`.

## Scope

The local tool handles: send-money requests, recipient resolution, auth setup, KYC, payout detail collection, receipt confirmation, wallet export, balance checks, top-ups, browser-login approval, and all flow-state questions.

**Default-to-tool rule:** if there is any chance that the answer lives in the UNIGOX session state rather than in general knowledge, call the tool.

Only say the tool is unavailable when Claude truly cannot access the installed Agentic Payments extension after trying to route into it.
