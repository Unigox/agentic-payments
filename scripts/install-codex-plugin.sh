#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
LOCAL_PLUGIN_HOME="${HOME}/plugins"
PLUGIN_DEST="${LOCAL_PLUGIN_HOME}/agentic-payments"
MARKETPLACE_PATH="${HOME}/.agents/plugins/marketplace.json"
LOCAL_CACHE_DEST="${CODEX_HOME}/plugins/cache/local/agentic-payments"
LEGACY_CODEX_PLUGIN_DEST="${CODEX_HOME}/plugins/agentic-payments"
LEGACY_SKILL_DEST="${CODEX_HOME}/skills/agentic-payments"
CONFIG_PATH="${CODEX_HOME}/config.toml"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

mkdir -p "${LOCAL_PLUGIN_HOME}"

if [[ -L "${PLUGIN_DEST}" ]]; then
  CURRENT_TARGET="$(readlink "${PLUGIN_DEST}")"
  if [[ "${CURRENT_TARGET}" != "${ROOT_DIR}" ]]; then
    rm -f "${PLUGIN_DEST}"
  fi
elif [[ -e "${PLUGIN_DEST}" ]]; then
  if [[ "${FORCE}" -ne 1 ]]; then
    printf 'Refusing to overwrite existing plugin path: %s\n' "${PLUGIN_DEST}" >&2
    printf 'Re-run with --force if you want this repo to replace it.\n' >&2
    exit 1
  fi
  rm -rf "${PLUGIN_DEST}"
fi

ln -sfn "${ROOT_DIR}" "${PLUGIN_DEST}"

python3 - "${MARKETPLACE_PATH}" <<'PY'
from pathlib import Path
import json
import sys

marketplace_path = Path(sys.argv[1])
marketplace_path.parent.mkdir(parents=True, exist_ok=True)

entry = {
    "name": "agentic-payments",
    "source": {
        "source": "local",
        "path": "./plugins/agentic-payments",
    },
    "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    },
    "category": "Productivity",
}

if marketplace_path.exists():
    data = json.loads(marketplace_path.read_text())
else:
    data = {
        "name": "local",
        "interface": {
            "displayName": "Local Plugins",
        },
        "plugins": [],
    }

data.setdefault("name", "local")
data.setdefault("interface", {})
data["interface"].setdefault("displayName", "Local Plugins")
plugins = data.setdefault("plugins", [])

updated = False
for index, existing in enumerate(plugins):
    if existing.get("name") == entry["name"]:
        plugins[index] = entry
        updated = True
        break

if not updated:
    plugins.append(entry)

marketplace_path.write_text(json.dumps(data, indent=2) + "\n")
PY

if [[ -L "${LEGACY_SKILL_DEST}" ]]; then
  LEGACY_TARGET="$(readlink "${LEGACY_SKILL_DEST}")"
  if [[ "${LEGACY_TARGET}" == "${ROOT_DIR}" ]]; then
    rm -f "${LEGACY_SKILL_DEST}"
    printf 'Removed legacy raw skill install: %s\n' "${LEGACY_SKILL_DEST}"
  fi
fi

if [[ -L "${LEGACY_CODEX_PLUGIN_DEST}" ]]; then
  LEGACY_CODEX_TARGET="$(readlink "${LEGACY_CODEX_PLUGIN_DEST}")"
  if [[ "${LEGACY_CODEX_TARGET}" == "${ROOT_DIR}" ]]; then
    rm -f "${LEGACY_CODEX_PLUGIN_DEST}"
    printf 'Removed legacy Codex plugin shortcut: %s\n' "${LEGACY_CODEX_PLUGIN_DEST}"
  fi
fi

python3 - "${CONFIG_PATH}" <<'PY'
from pathlib import Path
import re
import sys

config_path = Path(sys.argv[1])
config_path.parent.mkdir(parents=True, exist_ok=True)
if config_path.exists():
    text = config_path.read_text()
else:
    text = ""

section = '[plugins."agentic-payments@local"]'
replacement = section + "\nenabled = true\n"

pattern = re.compile(r'(?ms)^\[plugins\."agentic-payments@local"\]\n(?:.*\n)*?(?=^\[|\Z)')
if pattern.search(text):
    text = pattern.sub(replacement + "\n", text).rstrip() + "\n"
else:
    if text and not text.endswith("\n"):
        text += "\n"
    if text:
        text += "\n"
    text += replacement

config_path.write_text(text)
PY

if [[ -d "${LOCAL_CACHE_DEST}" ]]; then
  rm -rf "${LOCAL_CACHE_DEST}"
  printf 'Cleared stale Codex plugin cache: %s\n' "${LOCAL_CACHE_DEST}"
fi

printf 'Installed Codex plugin: %s -> %s\n' "${PLUGIN_DEST}" "${ROOT_DIR}"
printf 'Updated local marketplace: %s\n' "${MARKETPLACE_PATH}"
printf 'Enabled plugin key: agentic-payments@local\n'
printf 'Restart Codex to rebuild the local plugin cache if it is already open.\n'
