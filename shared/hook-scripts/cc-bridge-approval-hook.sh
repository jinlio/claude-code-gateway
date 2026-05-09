#!/bin/bash
# cc-bridge approval hook (bash)
# Claude Code PreToolUse hook
# Reads tool info from environment variables set by Claude Code

BRIDGE_URL="${CC_BRIDGE_URL:-http://127.0.0.1:7890}"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
TOOL_NAME="${CLAUDE_TOOL_NAME:-$1}"
TOOL_INPUT="${CLAUDE_TOOL_INPUT:-$2}"
CWD="$(pwd)"
TIMESTAMP="$(date +%s)"

# Phase 1: Create approval request
# Use jq for safe JSON construction (prevents injection)
if command -v jq &>/dev/null; then
  BODY=$(jq -n --arg sid "$SESSION_ID" --arg tn "$TOOL_NAME" \
    --arg ti "$TOOL_INPUT" --arg cwd "$CWD" --arg ts "$TIMESTAMP" \
    '{sessionId:$sid, toolName:$tn, toolInput:$ti, cwd:$cwd, timestamp:$ts}')
else
  # Fallback: manual JSON construction with comprehensive escaping
  _esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g' -e 's/\n/\\n/g' -e 's/\f/\\f/g' -e 's/\b/\\b/g' -e 's/\$/\\$/g' -e 's/`/\\`/g'; }
  E_SID=$(_esc "$SESSION_ID")
  E_TN=$(_esc "$TOOL_NAME")
  E_TI=$(_esc "$TOOL_INPUT")
  E_CWD=$(_esc "$CWD")
  E_TS=$(_esc "$TIMESTAMP")
  BODY="{\"sessionId\":\"${E_SID}\",\"toolName\":\"${E_TN}\",\"toolInput\":\"${E_TI}\",\"cwd\":\"${E_CWD}\",\"timestamp\":\"${E_TS}\"}"
fi

RESPONSE=$(curl -s -f -X POST "${BRIDGE_URL}/api/approval/request" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  --connect-timeout 5 --max-time 10 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo "[cc-bridge] Approval service unreachable, denying" >&2
  exit 2
fi

# Check for auto-approved response (rule-based pre-check)
STATUS=$(echo "$RESPONSE" | jq -r '.status // "UNKNOWN"' 2>/dev/null)
AUTO_APPROVED=$(echo "$RESPONSE" | jq -r '.autoApproved // false' 2>/dev/null)
if [ "$STATUS" = "APPROVED" ] && [ "$AUTO_APPROVED" = "true" ]; then
  exit 0
fi

APPROVAL_ID=$(echo "$RESPONSE" | jq -r '.approvalId // empty' 2>/dev/null)
if [ -z "$APPROVAL_ID" ]; then
  echo "[cc-bridge] No approval ID obtained, denying" >&2
  exit 2
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

  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status // "UNKNOWN"' 2>/dev/null)
  case "$STATUS" in
    APPROVED) exit 0;;
    DENIED)   exit 2;;
    TIMEOUT)  exit 3;;
  esac
done

exit 3  # Timeout
