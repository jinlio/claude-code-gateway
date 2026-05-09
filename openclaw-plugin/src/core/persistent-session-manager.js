// PersistentSessionManager — compound-key session isolation
// See: cc-bridge-v3-final-plan.md Section 8

const fs = require('fs');
const path = require('path');
const { atomicWriteSync, safeLoadJson } = require('./utils');

class PersistentSessionManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsPath = path.join(dataDir, 'persistent-sessions.json');
  }

  getKey(senderId, workspace) {
    return `${senderId}::${workspace}`;
  }

  activate(senderId, workspace, sessionId) {
    const sessions = safeLoadJson(this.sessionsPath);
    const key = this.getKey(senderId, workspace);

    sessions[key] = {
      senderId,
      workspace,
      sessionId,
      active: true,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      stoppedAt: null,
      messageCount: 0,
      processAlive: true
    };

    atomicWriteSync(this.sessionsPath, JSON.stringify(sessions, null, 2));
    return sessions[key];
  }

  getActive(senderId) {
    const sessions = safeLoadJson(this.sessionsPath);
    for (const [key, session] of Object.entries(sessions)) {
      if (session.senderId === senderId && session.active) {
        return session;
      }
    }
    return null;
  }

  deactivate(senderId) {
    const sessions = safeLoadJson(this.sessionsPath);
    const active = this.getActive(senderId);
    if (active) {
      const key = this.getKey(senderId, active.workspace);
      sessions[key].active = false;
      sessions[key].stoppedAt = new Date().toISOString();
      atomicWriteSync(this.sessionsPath, JSON.stringify(sessions, null, 2));
    }
  }
}

module.exports = { PersistentSessionManager };