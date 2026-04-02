# Adapter Layer

`agentic-payments` stays one project.

- Core business logic: `scripts/transfer-orchestrator.ts`
- Canonical session-aware runner: `scripts/run-transfer-turn.ts`
- Canonical portable tool contract: `scripts/send-money-tool.ts`
- OpenClaw adapter: root `SKILL.md`
- OpenAI tool definition: `adapters/openai/send-money-tool.json`
- Anthropic tool definition: `adapters/anthropic/send-money-tool.json`

## Shared contract

All adapters should call the same logical tool:

- `name`: `send_money_turn`
- input:
  - `text`: latest user turn
  - `session_key`: stable per-user or per-chat key reused across turns
  - `reset`: optional hard reset

The result still comes from the same runner/state machine:

- `reply`
- `options`
- `status`
- `session`
- `events`

## Rendering rule

The core engine only returns structured options.
Each adapter decides how to render them:

- OpenClaw / Telegram: buttons or quick replies when possible
- OpenAI / Anthropic: tool result plus host-side UI, buttons, or follow-up prompt formatting

## Host integration rule

Do not fork transfer logic per provider runtime.
If OpenAI, Anthropic, and OpenClaw need different prompting or transport behavior, keep those differences in the adapter layer and continue calling the same `send_money_turn` contract.
