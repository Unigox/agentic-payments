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

## Supported platforms

- OpenClaw: supported today through the packaged root [`SKILL.md`](../SKILL.md)
- OpenAI host apps or SDK integrations: supported today through the local [`send-money-tool.json`](./openai/send-money-tool.json) definition
- Anthropic Claude Desktop: supported today through a local MCP server launched by [`send-money-mcp-server.sh`](../scripts/send-money-mcp-server.sh)
- Anthropic Claude Code: supported today through the same local MCP server and tool contract

Everything above is intended to stay local to each tester's machine. This repo does not assume a shared hosted MCP layer.

## Host integration rule

Do not fork transfer logic per provider runtime.
If OpenAI, Anthropic, and OpenClaw need different prompting or transport behavior, keep those differences in the adapter layer and continue calling the same `send_money_turn` contract.
