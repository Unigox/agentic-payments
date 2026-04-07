# Installing on Codex

## Prerequisites

- Codex desktop or CLI installed
- This repo cloned locally

## Install

```bash
cd agentic-payments
bash scripts/install-codex-plugin.sh
```

This creates:
- `~/plugins/agentic-payments` symlink pointing at the repo
- `~/.agents/plugins/marketplace.json` entry for the plugin
- `~/.codex/plugins/cache/local/agentic-payments/local` linked to the repo

It also clears Codex's plugin sync cache so a restart picks up the new plugin.

## Restart

Restart Codex so it reloads the installed plugin.

## Verify

After restart, the plugin should appear in your Codex plugin list. Try:

```
send money using Agentic Payments
```

## Plugin Disappeared?

If the plugin vanishes after a Codex restart (even though `~/plugins/agentic-payments` still exists), rerun:

```bash
bash scripts/install-codex-plugin.sh
```

This re-links the install path and clears the stale sync snapshot.

## Legacy Skill Install

If you only want the raw skill without the plugin wrapper:

```bash
bash scripts/install-codex-skill.sh
```

## Next Steps

- [Configure authentication](authentication.md)
