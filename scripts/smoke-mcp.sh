#!/usr/bin/env bash
# Smoke-test a running MCP endpoint: initialize (legacy era) → tools/list.
# Usage: scripts/smoke-mcp.sh [url] [bearer-token]
set -euo pipefail

URL="${1:-http://127.0.0.1:3000/api/mcp}"
TOKEN="${2:-${MCP_AUTH_TOKEN:-}}"

AUTH=()
if [[ -n "$TOKEN" ]]; then AUTH=(-H "Authorization: Bearer $TOKEN"); fi

call() {
  curl -fsS -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    "${AUTH[@]}" \
    -d "$1"
}

echo "→ initialize"
call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | sed -n 's/^data: //p'
echo "→ tools/list"
call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | sed -n 's/^data: //p'
echo "OK"
