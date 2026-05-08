// cc-bridge approval hook (Node.js, cross-platform)
// Claude Code PreToolUse hook
// Reads tool info from environment variables set by Claude Code
// Fail-closed: denies operations when approval service is unreachable

const BRIDGE_URL = process.env.CC_BRIDGE_URL || 'http://127.0.0.1:7890';
const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'unknown';
const TOOL_NAME = process.env.CLAUDE_TOOL_NAME || process.argv[2] || 'unknown';
const TOOL_INPUT = process.env.CLAUDE_TOOL_INPUT || process.argv[3] || '{}';
const CWD = process.cwd();

async function requestApproval() {
  // Phase 1: Create approval request
  let res;
  try {
    res = await fetch(`${BRIDGE_URL}/api/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        toolName: TOOL_NAME,
        toolInput: TOOL_INPUT,
        cwd: CWD,
        timestamp: Date.now()
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    // Fail-closed: deny when service is unreachable
    process.exit(2);
  }

  const data = await res.json();

  // Auto-approved by rules — exit immediately
  if (data.status === 'APPROVED' && data.autoApproved) {
    process.exit(0);
  }

  if (!data.approvalId) {
    // No approval ID — deny (fail-closed)
    process.exit(2);
  }

  // Phase 2: Poll approval status
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const statusRes = await fetch(
        `${BRIDGE_URL}/api/approval/status?id=${data.approvalId}`,
        { signal: AbortSignal.timeout(5000) }
      );
      const statusData = await statusRes.json();

      switch (statusData.status) {
        case 'APPROVED': process.exit(0);
        case 'DENIED':   process.exit(2);
        case 'TIMEOUT':  process.exit(3);
      }
    } catch {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
  }

  process.exit(3); // Timeout
}

requestApproval();
