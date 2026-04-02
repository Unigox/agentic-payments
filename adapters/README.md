# Adapter Layer

`agentic-payments` stays one project.

- Core business logic: `scripts/transfer-orchestrator.ts`
- Canonical session-aware runner: `scripts/run-transfer-turn.ts`
- Canonical portable tool contract: `scripts/send-money-tool.ts`
- Codex local plugin adapter: `.codex-plugin/plugin.json` + `skills/send-money/SKILL.md`
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

- Codex desktop / CLI: supported today through a local plugin install that points `~/.codex/plugins/agentic-payments` at the repo root
- OpenClaw: supported today through the packaged root [`SKILL.md`](../SKILL.md)
- OpenAI host apps or SDK integrations: supported today through the local [`send-money-tool.json`](./openai/send-money-tool.json) definition
- Anthropic Claude Desktop: supported today through a local MCP server launched by [`send-money-mcp-server.sh`](../scripts/send-money-mcp-server.sh)
- Anthropic Claude Code: supported today through the same local MCP server and tool contract

Everything above is intended to stay local to each tester's machine. This repo does not assume a shared hosted MCP layer.

## Host integration rule

Do not fork transfer logic per provider runtime.
If Codex, OpenAI, Anthropic, and OpenClaw need different prompting or transport behavior, keep those differences in the adapter layer and continue calling the same `send_money_turn` contract.

## Release rule

GitHub is the canonical source for all supported adapter surfaces.

Before pushing adapter-related work:
- implement business logic in the shared engine or canonical runner first
- keep adapter changes limited to transport, invocation, or rendering behavior
- run `npm test --prefix scripts`
- verify these files still agree on the same contract:
  - `scripts/send-money-tool.ts`
  - `adapters/openai/send-money-tool.json`
  - `scripts/send-money-mcp.ts`
  - `scripts/send-money-mcp-server.ts`
  - root `SKILL.md`

Anthropic distribution rule:
- keep Anthropic local-first
- prefer a drag-and-drop Claude Desktop `.mcpb` bundle built from this repo over asking end users to wire MCP manually
- do not introduce a separate Anthropic-only flow engine

Current Anthropic bundle path:
- `adapters/anthropic/installed.mcpb`

Rebuild command:
- `npm run build:anthropic-bundle --prefix scripts`

Codex distribution rule:
- keep Codex local-first too
- prefer the local plugin wrapper install through `scripts/install-codex-plugin.sh`
- the plugin wrapper should stay thin and point back to the canonical repo-root `SKILL.md`
- do not copy the flow engine into a separate Codex-only implementation
