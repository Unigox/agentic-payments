# Adapter Layer

`agentic-payments` stays one project.

- Core business logic: `scripts/transfer-orchestrator.ts`
- Payments backend port and its Partner API implementation: `scripts/transfer-execution.ts`, `scripts/partner-execution-client.ts`, `scripts/partner-api-client.ts`
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
  - `session_key`: optional stable per-user or per-chat key reused across turns when the host can provide one
  - `reset`: optional hard reset

If a host surface cannot provide a clean chat identifier, the shared contract should still stay callable and fall back to the local default conversation state instead of forcing the user to type a session key manually.

The result still comes from the same runner/state machine:

- `reply`
- `options`
- `done`
- `session`
- `events`

## Rendering rule

The core engine only returns structured options.
Each adapter decides how to render them:

- OpenClaw / Telegram: buttons or quick replies when possible
- OpenAI / Anthropic: tool result plus host-side UI, buttons, or follow-up prompt formatting

## Supported platforms

- Codex desktop / CLI: supported today through a local plugin install that points `~/plugins/agentic-payments` at the repo root and registers it in `~/.agents/plugins/marketplace.json`
- OpenClaw: supported today through the packaged root [`SKILL.md`](../SKILL.md)
- OpenAI host apps or SDK integrations: supported today through the local [`send-money-tool.json`](./openai/send-money-tool.json) definition
- Anthropic Claude Desktop: supported today through a local MCP server launched by [`send-money-mcp-server.sh`](../scripts/send-money-mcp-server.sh)
- Anthropic Claude Code: supported today through the same local MCP server and tool contract

Everything above is intended to stay local to each tester's machine. This repo does not assume a shared hosted MCP layer.

Credentials rule:
- no adapter collects keys in chat; every adapter reads the same settings through `scripts/partner-api-config.ts`
- Claude Desktop takes them as extension settings (`user_config` in `adapters/anthropic/manifest.json`); the other adapters read `.env`

Anthropic-specific tool split:
- `send_money_turn` remains the canonical catch-all tool contract
- Claude Desktop additionally exposes thin entry tools for `start_send_money`, `check_kyc`, and `save_payment_details`
- those Anthropic entry tools must stay as wrappers around the same shared runner, not separate payment engines

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
- keep the Anthropic tool and extension descriptions explicit enough that Claude routes natural send-money requests into `send_money_turn` instead of generic connector search or a blanket financial-safety refusal when the local tool is available

Current Anthropic bundle path:
- `adapters/anthropic/installed.mcpb`
- paired companion Claude Skill package for routing:
  - `adapters/anthropic/agentic-payments-skill.zip`
- skill source:
  - `adapters/anthropic/agentic-payments-skill.md`

Rebuild command:
- `npm run build:anthropic-bundle --prefix scripts`

Anthropic packaging rule:
- Claude Desktop extensions and Claude Skills are separate install surfaces
- the `.mcpb` bundle should be shipped together with an upload-ready Skill ZIP so end users can install both from the same repo release
- keep the Skill ZIP aligned with the same repo commit as the `.mcpb`

Claude trigger rule:
- the local Anthropic descriptions should explicitly teach Claude that `Agentic Payments`, `UNIGOX`, `connector`, `extension`, and `plugin` mentions can all map to the same local `send_money_turn` tool
- the routing copy should prefer local-tool invocation over public registry search when the extension is installed
- the README should always include action-first example prompts such as `I want to send money using Agentic Payments` and `I have the Agentic Payments connector and I want to send money`
- the README and companion Claude skill should also document `/agentic-payments` as a direct skill-style trigger for Claude, and that explicit skill invocation should not be treated as proof the extension is unavailable before local-tool routing has had a chance to load
- when Claude does not provide a real per-chat `session_key`, explicit fresh-start prompts like `/agentic-payments lets start` should reset the default local session instead of inheriting an older blocked flow
- the README and companion Claude skill should also preserve an explicit fallback prompt that names `send_money_turn` directly, so the direct invocation path remains documented if natural routing fails
- KYC turns such as `Do I need to do KYC?`, `I want to do KYC`, and `Give me the KYC link` should route back into `send_money_turn` instead of being answered from generic model knowledge
- no description may suggest that a key can be pasted into chat

Codex distribution rule:
- keep Codex local-first too
- prefer the local plugin wrapper install through `scripts/install-codex-plugin.sh`
- the plugin wrapper should stay thin and point back to the canonical repo-root `SKILL.md`
- do not copy the flow engine into a separate Codex-only implementation
- the installer should install `~/.codex/plugins/cache/local/agentic-payments/local` as a repo-backed path, because Codex loads enabled local plugins from that installed cache location rather than directly from the marketplace source path
- the installer should also clear `~/.codex/.tmp/plugins` and `~/.codex/.tmp/plugins.sha` so a restart cannot reuse an old plugin-sync marketplace snapshot that omits the local plugin
