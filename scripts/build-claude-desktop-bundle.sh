#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUNDLE_BUILD_DIR="${ROOT_DIR}/adapters/anthropic/.mcpb-build"
SCRIPTS_BUILD_DIR="${BUNDLE_BUILD_DIR}/scripts"
OUTPUT_FILE="${ROOT_DIR}/adapters/anthropic/installed.mcpb"
MANIFEST_SOURCE="${ROOT_DIR}/adapters/anthropic/manifest.json"

if [[ ! -f "${MANIFEST_SOURCE}" ]]; then
  echo "Missing Anthropic MCPB manifest at ${MANIFEST_SOURCE}" >&2
  exit 1
fi

if [[ ! -f "${SCRIPT_DIR}/package.json" ]]; then
  echo "Missing scripts/package.json in ${SCRIPT_DIR}" >&2
  exit 1
fi

npm install --prefix "${SCRIPT_DIR}" --no-fund --no-audit >&2

rm -rf "${BUNDLE_BUILD_DIR}"
mkdir -p "${SCRIPTS_BUILD_DIR}" \
  "${BUNDLE_BUILD_DIR}/workflows/sessions" \
  "${BUNDLE_BUILD_DIR}/workflows/tonconnect"

cp "${SCRIPT_DIR}/package.json" "${SCRIPTS_BUILD_DIR}/package.json"
cp "${SCRIPT_DIR}/package-lock.json" "${SCRIPTS_BUILD_DIR}/package-lock.json"

"${SCRIPT_DIR}/node_modules/.bin/tsc" \
  -p "${SCRIPT_DIR}/tsconfig.bundle.json" \
  --outDir "${SCRIPTS_BUILD_DIR}"

npm ci --prefix "${SCRIPTS_BUILD_DIR}" --omit=dev --no-fund --no-audit >&2

cp "${MANIFEST_SOURCE}" "${BUNDLE_BUILD_DIR}/manifest.json"
cp "${ROOT_DIR}/contacts.json" "${BUNDLE_BUILD_DIR}/contacts.json"
cp "${ROOT_DIR}/settings.json" "${BUNDLE_BUILD_DIR}/settings.json"
cp "${ROOT_DIR}/README.md" "${BUNDLE_BUILD_DIR}/README.md"

npx -y @anthropic-ai/mcpb validate "${BUNDLE_BUILD_DIR}/manifest.json" >&2
npx -y @anthropic-ai/mcpb pack "${BUNDLE_BUILD_DIR}" "${OUTPUT_FILE}" >&2
npx -y @anthropic-ai/mcpb info "${OUTPUT_FILE}" >&2

echo "${OUTPUT_FILE}"
