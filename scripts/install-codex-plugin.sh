#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PLUGIN_DEST="${CODEX_HOME}/plugins/agentic-payments"
LEGACY_SKILL_DEST="${CODEX_HOME}/skills/agentic-payments"
CONFIG_PATH="${CODEX_HOME}/config.toml"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

mkdir -p "${CODEX_HOME}/plugins"

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

if [[ -L "${LEGACY_SKILL_DEST}" ]]; then
  LEGACY_TARGET="$(readlink "${LEGACY_SKILL_DEST}")"
  if [[ "${LEGACY_TARGET}" == "${ROOT_DIR}" ]]; then
    rm -f "${LEGACY_SKILL_DEST}"
    printf 'Removed legacy raw skill install: %s\n' "${LEGACY_SKILL_DEST}"
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

printf 'Installed Codex plugin: %s -> %s\n' "${PLUGIN_DEST}" "${ROOT_DIR}"
printf 'Enabled plugin key: agentic-payments@local\n'
printf 'Restart Codex to pick up the new plugin if it is already open.\n'
