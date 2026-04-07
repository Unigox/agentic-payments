#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_SOURCE="${ROOT_DIR}/adapters/anthropic/agentic-payments-skill.md"
SKILL_BUILD_DIR="${ROOT_DIR}/adapters/anthropic/.skill-build"
SKILL_FOLDER_NAME="agentic-payments"
SKILL_OUTPUT="${ROOT_DIR}/adapters/anthropic/agentic-payments-skill.zip"

if [[ ! -f "${SKILL_SOURCE}" ]]; then
  echo "Missing Claude skill source at ${SKILL_SOURCE}" >&2
  exit 1
fi

rm -rf "${SKILL_BUILD_DIR}"
mkdir -p "${SKILL_BUILD_DIR}/${SKILL_FOLDER_NAME}"
cp "${SKILL_SOURCE}" "${SKILL_BUILD_DIR}/${SKILL_FOLDER_NAME}/Skill.md"

rm -f "${SKILL_OUTPUT}"
(
  cd "${SKILL_BUILD_DIR}"
  zip -rq "${SKILL_OUTPUT}" "${SKILL_FOLDER_NAME}"
)

rm -rf "${SKILL_BUILD_DIR}"

echo "${SKILL_OUTPUT}"
