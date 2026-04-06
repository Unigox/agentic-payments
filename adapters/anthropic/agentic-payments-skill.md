---
name: agentic-payments
description: Use when the user wants to send money with UNIGOX or Agentic Payments, or mentions the local Agentic Payments connector/extension/plugin by name. If the local Agentic Payments extension is installed and its local tools are available, route into the best matching tool immediately instead of falling back to generic connector search or a blanket payment refusal.
---

# Agentic Payments Skill

Use this skill when the user wants to send money with UNIGOX or Agentic Payments, or when they are trying to use the local Agentic Payments connector/extension/plugin.

## Routing rule

If the local `Agentic Payments` extension is installed and its local tools are available:

- prefer the narrowest matching tool first:
  - `start_send_money` for new transfer requests and normal send-money continuation
  - `sign_in_unigox` for auth setup, wallet connection, TonConnect login approval, and signing-key setup
  - `create_wallet` for dedicated EVM or TON wallet creation
  - `export_wallet` for exporting a generated EVM or TON login wallet into a local file
  - `check_kyc` for KYC threshold questions, early KYC questions, or live KYC-link requests
  - `save_payment_details` for saving or updating recipient payout details for later
  - `send_money_turn` as the canonical catch-all when more than one area is involved
- call the matching tool immediately for natural requests like:
  - `I want to send money`
  - `I want to send money using Agentic Payments`
  - `use Agentic Payments`
  - `I have the Agentic Payments connector`
  - `I have the Agentic Payments extension`
  - `send money to Aleksandr`
  - `continue my UNIGOX payment`
  - `Do I need to do KYC?`
  - `Can I do KYC earlier?`
  - `Create a dedicated TON wallet`
  - `export this wallet`
  - `backup my generated wallet`
  - `Help me sign in to UNIGOX`
- if the user mentions `Agentic Payments` and a local connector/extension/plugin is available, do not search the public registry first
- do **not** answer with a generic connector search
- do **not** answer with a blanket payment refusal
- if natural routing still fails, fall back to the documented direct invocation wording: `Use Agentic Payments send_money_turn. I want to send money.`

The local tool runs a guided, user-confirmed UNIGOX flow on-device. It does not blindly execute a transfer without the user walking through recipient, auth, quote, KYC, and confirmation steps.

## Reply rule

After calling `send_money_turn`:

- relay the tool's returned reply closely and do not invent an alternative auth step
- do not add an email request unless the tool reply explicitly asks for email OTP
- if the user chooses `Create a dedicated EVM wallet` or `Create a dedicated TON wallet`, do not ask for email unless the tool itself explicitly says email is required
- if the user asks whether the recipient or payment details are already saved, call the tool again and relay its answer; do not claim the system requires manual IBAN entry every time unless the tool explicitly says no saved details were found
- if the user asks to export a generated wallet, relay the file path from the tool closely and do not paste the wallet secret back into chat as plain text yourself
- do not reinterpret a legal-name KYC prompt as if it were the recipient's name, and do not reinterpret a recipient prompt as if it were KYC
- if the user says `I wanna do KYC`, `give me the KYC link`, `Do I need to do KYC?`, `Can I do KYC earlier?`, or similar, call the tool again and relay the runner's KYC answer directly instead of free-styling whether the next step is legal name, country, whether KYC starts after 100 USD total volume, or whether the link should be repeated
- prefer the tool's exact flow wording over your own paraphrase when the tool is guiding authentication or wallet setup

## Tool usage

- Pass the user's latest message as `text`.
- Reuse the same `session_key` across turns when the host/runtime provides one.
- If the host/runtime does not provide a clean chat key, omit `session_key` and let the tool reuse the local default conversation state.
- If the user shares a fresh UNIGOX TonConnect QR screenshot and the host can supply a local file path, pass it as `image_path`.

## Scope

Use `send_money_turn` for:

- new send-money requests
- recipient lookup and saved recipient continuation
- auth setup
- KYC continuation
- payout detail collection
- receipt confirmation
- any follow-up turn in the same UNIGOX payment flow

If the local tool is unavailable, say that clearly and then fall back to a plain explanation.
