#!/bin/bash
# cc-bridge approval hook (bash)
# Claude Code PreToolUse hook
# Args: $1=tool_name, $2=tool_input_json

BRIDGE_URL="${CC_BRIDGE_URL:-http://127.0.0.1:7890}"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
TOOL_NAME="$1"
TOOL_INPUT="$2"
CWD="$(pwd)"
TIMESTAMP="$(date +%s)"

# Phase 1: Create approval request
RESPONSE=$(curl -s -f -X POST "${BRIDGE_URL}/api/approval/request" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"toolName\":\"${TOOL_NAME}\",\"toolInput\":\"${TOOL_INPUT}\",\"cwd\":\"${CWD}\",\"timestamp\":\"${TIMESTAMP}\"}" \
  --connect-timeout 5 --max-time 10 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo "[cc-bridge] Approval service unreachable, auto-approve" >&2
  exit 0
fi

APPROVAL_ID=$(echo "$RESPONSE" | jq -r '.approvalId // empty')
if [ -z "$APPROVAL_ID" ]; then
  echo "[cc-bridge] No approval ID obtained, auto-approve" >&2
  exit 0
fi

# Phase 2: Poll approval status
for i in $(seq 1 150); do
  sleep 2
  STATUS_RESPONSE=$(curl -s -f \
    "${BRIDGE_URL}/api/approval/status?id=${APPROVAL_ID}" \
    --connect-timeout 5 --max-time 5 2>/dev/null)

  if [ $? -ne 0 ] || [ -z "$STATUS_RESPONSE" ]; then
    sleep 2
    continue
  fi

  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status // "UNKNOWN"')
  case "$STATUS" in
    APPROVED) exit 0;;
    DENIED)   exit 2;;
    TIMEOUT)  exit 3;;
  esac
done

exit 3  # Timeout