#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
DEST="${CODEX_HOME}/skills/agentic-payments"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

mkdir -p "${CODEX_HOME}/skills"

if [[ -L "${DEST}" ]]; then
  CURRENT_TARGET="$(readlink "${DEST}")"
  if [[ "${CURRENT_TARGET}" == "${ROOT_DIR}" ]]; then
    printf 'Codex skill already installed: %s -> %s\n' "${DEST}" "${ROOT_DIR}"
    printf 'Restart Codex to pick up new skills if it is already open.\n'
    exit 0
  fi
  rm -f "${DEST}"
elif [[ -e "${DEST}" ]]; then
  if [[ "${FORCE}" -ne 1 ]]; then
    printf 'Refusing to overwrite existing path: %s\n' "${DEST}" >&2
    printf 'Re-run with --force if you want this repo to replace it.\n' >&2
    exit 1
  fi
  rm -rf "${DEST}"
fi

ln -s "${ROOT_DIR}" "${DEST}"

printf 'Installed Codex skill: %s -> %s\n' "${DEST}" "${ROOT_DIR}"
printf 'Restart Codex to pick up the new skill if it is already open.\n'
