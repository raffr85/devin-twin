#!/bin/sh
# dlb lifecycle-hook bridge: POST event stdin to the local bridge, print reply.
# usage: dlb-hook.sh <EventName> [curl max-time seconds]
# Hooks hit the localhost-only hook port (default 8788), never the MCP port.
EVENT="$1"
MAXTIME="${2:-3}"
STATE_DIR="${DLB_STATE_DIR:-$HOME/.local/share/devin-local-bridge}"
TOKEN_FILE="$STATE_DIR/hook_token"
[ -f "$TOKEN_FILE" ] || exit 0
PORT="$DLB_HOOK_PORT"
if [ -z "$PORT" ]; then
  PORT=$(sed -n 's/^hook_port *= *\([0-9][0-9]*\).*/\1/p' "$STATE_DIR/config.toml" 2>/dev/null)
fi
PORT="${PORT:-8788}"
DATA=$(cat)
RESP=$(curl -s --max-time "$MAXTIME" \
  -X POST "http://127.0.0.1:${PORT}/hook?event=$EVENT" \
  -H "content-type: application/json" \
  -H "X-DLB-Hook-Token: $(cat "$TOKEN_FILE")" \
  -H "X-DLB-Cwd: ${DEVIN_PROJECT_DIR:-$PWD}" \
  --data-binary "$DATA" 2>/dev/null)
[ -n "$RESP" ] && printf '%s' "$RESP"
exit 0
