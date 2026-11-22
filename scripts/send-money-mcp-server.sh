#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

missing_dependency() {
  local package_path="$1"
  [[ ! -f "${SCRIPT_DIR}/node_modules/${package_path}/package.json" ]]
}

if [[ ! -f "${SCRIPT_DIR}/package.json" ]]; then
  echo "send-money MCP bootstrap failed: scripts/package.json is missing." >&2
  exit 1
fi

if missing_dependency "@modelcontextprotocol/sdk" || missing_dependency "zod" || missing_dependency "ethers"; then
  npm install --prefix "${SCRIPT_DIR}" --no-fund --no-audit >&2
fi

exec node --experimental-strip-types "${SCRIPT_DIR}/send-money-mcp-server.ts" "$@"
