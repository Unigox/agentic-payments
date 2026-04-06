---
name: agentic-payments
description: Use when the user wants to send money with UNIGOX or Agentic Payments. If the local Agentic Payments extension is installed and the send_money_turn tool is available, call it immediately for natural requests like "I want to send money" instead of falling back to generic connector search or a blanket payment refusal.
---

# Agentic Payments Skill

Use this skill when the user wants to send money with UNIGOX or Agentic Payments.

## Routing rule

If the local `Agentic Payments` extension is installed and the `send_money_turn` tool is available:

- call `send_money_turn` immediately for natural requests like:
  - `I want to send money`
  - `I want to send money using Agentic Payments`
  - `send money to Aleksandr`
  - `continue my UNIGOX payment`
- do **not** answer with a generic connector search
- do **not** answer with a blanket payment refusal

The local tool runs a guided, user-confirmed UNIGOX flow on-device. It does not blindly execute a transfer without the user walking through recipient, auth, quote, KYC, and confirmation steps.

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
