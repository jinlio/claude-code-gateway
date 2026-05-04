// ClaudeBridge — dual Map architecture, process lifecycle management
// See: cc-bridge-v3-final-plan.md Section 2

class ClaudeBridge {
  constructor() {
    this.processMap = new Map();  // sessionId → ChildProcess
    this.sessionMeta = new Map(); // sessionId → { cwd, startedAt, senderId, stashRef, messageCount, lastActiveAt, active }
  }

  findActiveSession(senderId) {
    for (const [sid, meta] of this.sessionMeta) {
      if (meta.senderId === senderId && meta.active) return sid;
    }
    return null;
  }

  checkSessionAlive(sessionId) {
    const proc = this.processMap.get(sessionId);
    if (!proc) {
      this.sessionMeta.delete(sessionId);
      return { alive: false };
    }
    if (proc.exitCode !== null) {
      this.processMap.delete(sessionId);
      this.sessionMeta.delete(sessionId);
      return { alive: false };
    }
    return { alive: true };
  }

  terminateSession(sessionId) {
    const proc = this.processMap.get(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (proc && proc.exitCode === null) {
      proc.kill();
    }
    this.processMap.delete(sessionId);
    if (meta) {
      meta.active = false;
    }
  }
}

module.exports = { ClaudeBridge };