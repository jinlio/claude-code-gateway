// ApprovalStore — atomic JSON persistence for approval requests
// See: cc-bridge-v3-final-plan.md Section 3.5

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ApprovalStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'approval-requests.json');
    this.requests = new Map();
    this._timedOutOnLoad = 0;
  }

  _load() {
    this._timedOutOnLoad = 0;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const items = JSON.parse(raw);
        for (const item of items) {
          if (item.status === 'PENDING') {
            item.status = 'TIMEOUT';
            this._timedOutOnLoad++;
          }
          this.requests.set(item.id, item);
        }
      }
    } catch {
      // File corrupt or missing, start fresh
    }
  }

  _loadTimedOutCount() {
    this._load();
    return this._timedOutOnLoad;
  }

  _flush() {
    const tmp = this.filePath + '.tmp';
    const data = JSON.stringify([...this.requests.values()], null, 2);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath);
  }

  create(params) {
    const id = crypto.randomUUID();
    this.requests.set(id, {
      id,
      sessionId: params.sessionId,
      toolName: params.toolName,
      toolInput: params.toolInput,
      cwd: params.cwd,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    });
    this._flush();
    return id;
  }

  get(id) {
    return this.requests.get(id);
  }

  findByShortId(shortId) {
    for (const [id, item] of this.requests) {
      if (id.startsWith(shortId)) return item;
    }
    return null;
  }

  resolve(id, status) {
    const item = this.requests.get(id);
    if (item) {
      item.status = status;
      item.resolvedAt = new Date().toISOString();
      this._flush();
    }
    return item;
  }

  markAllPendingAsTimeout() {
    for (const item of this.requests.values()) {
      if (item.status === 'PENDING') {
        item.status = 'TIMEOUT';
      }
    }
  }

  flush() {
    this._flush();
  }

  cleanup() {
    const cutoff = Date.now() - 3600000;
    for (const [id, item] of this.requests) {
      if (item.status !== 'PENDING' &&
          new Date(item.resolvedAt || item.createdAt).getTime() < cutoff) {
        this.requests.delete(id);
      }
    }
    this._flush();
  }
}

module.exports = { ApprovalStore };