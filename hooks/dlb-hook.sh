#!/bin/sh
# dlb lifecycle-hook bridge: POST event stdin to the local bridge, print reply.
# usage: dlb-hook.sh <EventName> [curl max-time seconds]
EVENT="$1"
MAXTIME="${2:-3}"
TOKEN_FILE="$HOME/.local/share/devin-local-bridge/hook_token"
[ -f "$TOKEN_FILE" ] || exit 0
DATA=$(cat)
RESP=$(curl -s --max-time "$MAXTIME" \
  -X POST "http://127.0.0.1:${DLB_PORT:-8787}/hook?event=$EVENT" \
  -H "content-type: application/json" \
  -H "X-DLB-Hook-Token: $(cat "$TOKEN_FILE")" \
  -H "X-DLB-Cwd: ${DEVIN_PROJECT_DIR:-$PWD}" \
  --data-binary "$DATA" 2>/dev/null)
[ -n "$RESP" ] && printf '%s' "$RESP"
exit 0
