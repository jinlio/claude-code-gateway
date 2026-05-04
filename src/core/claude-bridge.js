// ClaudeBridge — dual Map architecture, process lifecycle management
// See: cc-bridge-v3-final-plan.md Section 2

const { spawn } = require('child_process');
const { acquireWorkspaceLock, releaseWorkspaceLock } = require('./utils');

const HEARTBEAT_INTERVAL = 60000;  // 60s
const SESSION_TIMEOUT = 1800000;   // 30min

class ClaudeBridge {
  constructor() {
    this.processMap = new Map();  // sessionId → ChildProcess
    this.sessionMeta = new Map(); // sessionId → metadata object
    this._heartbeatTimer = null;
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

  async spawnSession(senderId, workspace, prompt, options = {}) {
    const existing = this.findActiveSession(senderId);
    if (existing) {
      return { sessionId: existing, reused: true };
    }

    // Acquire workspace lock to prevent concurrent sessions
    const lockRelease = await acquireWorkspaceLock(workspace);

    const sessionId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = ['--print', prompt];
    if (options.model) args.push('--model', options.model);
    if (options.allowedTools) args.push('--allowedTools', options.allowedTools);

    const proc = spawn('claude', args, {
      cwd: workspace,
      env: { ...process.env, CLAUDE_SESSION_ID: sessionId },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Initialize session metadata
    this.sessionMeta.set(sessionId, {
      senderId,
      cwd: workspace,
      sessionId,
      active: true,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 0,
      processAlive: true,
      stashRef: null,
      lockRelease
    });

    // Register process
    this.processMap.set(sessionId, proc);

    // Exit event listener for proactive cleanup
    proc.on('exit', (code) => {
      this.processMap.delete(sessionId);
      const meta = this.sessionMeta.get(sessionId);
      if (meta) {
        meta.processAlive = false;
        meta.exitCode = code;
      }
    });

    // Start heartbeat
    this.startHeartbeat();

    return { sessionId, reused: false };
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
      // Release workspace lock
      if (meta.lockRelease) {
        releaseWorkspaceLock(meta.lockRelease).catch(() => {});
        meta.lockRelease = null;
      }
    }
  }

  startHeartbeat() {
    if (this._heartbeatTimer) return;

    this._heartbeatTimer = setInterval(() => {
      for (const [sid, meta] of this.sessionMeta) {
        const alive = this.checkSessionAlive(sid);
        if (!alive.alive) {
          this.terminateSession(sid);
          continue;
        }

        const lastActive = new Date(meta.lastActiveAt).getTime();
        if (Date.now() - lastActive > SESSION_TIMEOUT) {
          this.terminateSession(sid);
        }
      }

      // Stop heartbeat if no active sessions
      const hasActive = [...this.sessionMeta.values()].some(m => m.active);
      if (!hasActive) {
        this.stopHeartbeat();
      }
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  updateActivity(sessionId) {
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      meta.lastActiveAt = new Date().toISOString();
      meta.messageCount++;
    }
  }
}

module.exports = { ClaudeBridge, HEARTBEAT_INTERVAL, SESSION_TIMEOUT };