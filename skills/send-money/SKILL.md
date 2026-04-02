---
name: send-money
description: Plugin wrapper for the canonical Agentic Payments send-money skill. Use when the user wants to send money through UNIGOX, manage payout recipients, sign in with EVM, TON, or email OTP, or continue an existing payment flow.
---

# Send Money

This plugin skill is only a thin Codex wrapper.

The canonical instructions live at:

- `../../SKILL.md`

Before acting, open and follow that repo-root skill file.

Rules:
- Treat `../../SKILL.md` as the single source of truth for behavior.
- Do not duplicate or fork payment logic here.
- Keep using the same repo-backed scripts, references, and runner contract.
- If this wrapper and the repo-root skill ever disagree, the repo-root skill wins and this wrapper should be kept minimal.
