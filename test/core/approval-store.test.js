// Tests for approval-store.js — atomic persistence, create/get/resolve, findByShortId, timeout marking

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ApprovalStore } = require('../../src/core/approval-store');

describe('ApprovalStore', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-store-'));
    store = new ApprovalStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a new approval request with PENDING status', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"ls"}', cwd: '/ws' });
      expect(id).toMatch(/^[0-9a-f-]+$/);
      const item = store.get(id);
      expect(item.status).toBe('PENDING');
      expect(item.toolName).toBe('Bash');
      expect(item.sessionId).toBe('s1');
    });

    it('persists data to file after create', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      const filePath = path.join(tmpDir, 'approval-requests.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(data.length).toBe(1);
    });

    it('uses atomic write (no .tmp file remains)', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      expect(fs.existsSync(path.join(tmpDir, 'approval-requests.json.tmp'))).toBe(false);
    });
  });

  describe('get', () => {
    it('returns the approval item by id', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      const item = store.get(id);
      expect(item).toBeDefined();
      expect(item.id).toBe(id);
    });

    it('returns undefined for unknown id', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });
  });

  describe('findByShortId', () => {
    it('finds an approval by the first chars of its id', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      const shortId = id.slice(0, 8);
      const item = store.findByShortId(shortId);
      expect(item).toBeDefined();
      expect(item.id).toBe(id);
    });

    it('returns null when no matching shortId', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      expect(store.findByShortId('zzzzzzzz')).toBeNull();
    });
  });

  describe('resolve', () => {
    it('resolves an approval to APPROVED', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      const item = store.resolve(id, 'APPROVED');
      expect(item.status).toBe('APPROVED');
      expect(item.resolvedAt).toBeDefined();
    });

    it('resolves an approval to DENIED', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      const item = store.resolve(id, 'DENIED');
      expect(item.status).toBe('DENIED');
    });

    it('persists resolved status to file', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.resolve(id, 'APPROVED');
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'approval-requests.json'), 'utf8'));
      expect(data[0].status).toBe('APPROVED');
    });

    it('returns undefined for resolving unknown id', () => {
      expect(store.resolve('nonexistent', 'APPROVED')).toBeUndefined();
    });
  });

  describe('markAllPendingAsTimeout', () => {
    it('marks all PENDING requests as TIMEOUT', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.create({ sessionId: 's2', toolName: 'Write', toolInput: '{}', cwd: '/ws' });
      const id = store.create({ sessionId: 's3', toolName: 'Edit', toolInput: '{}', cwd: '/ws' });
      store.resolve(id, 'APPROVED');

      store.markAllPendingAsTimeout();
      const items = [...store.requests.values()];
      const pending = items.filter(i => i.status === 'PENDING');
      expect(pending.length).toBe(0);
    });

    it('does not modify already resolved items', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.resolve(id, 'APPROVED');
      store.markAllPendingAsTimeout();
      expect(store.get(id).status).toBe('APPROVED');
    });
  });

  describe('_load (restart behavior)', () => {
    it('marks PENDING items as TIMEOUT on reload', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      // Simulate restart: create new store instance loading from same dir
      const store2 = new ApprovalStore(tmpDir);
      store2._load();
      expect(store2.get(id).status).toBe('TIMEOUT');
    });

    it('_loadTimedOutCount returns count of timed-out items', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.create({ sessionId: 's2', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });

      const store2 = new ApprovalStore(tmpDir);
      const count = store2._loadTimedOutCount();
      expect(count).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('removes resolved items older than 1 hour', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.resolve(id, 'APPROVED');

      // Manually age the resolvedAt
      const item = store.get(id);
      item.resolvedAt = new Date(Date.now() - 3700000).toISOString();

      store.cleanup();
      expect(store.get(id)).toBeUndefined();
    });

    it('keeps recent resolved items', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.resolve(id, 'APPROVED');
      store.cleanup();
      expect(store.get(id)).toBeDefined();
    });

    it('keeps PENDING items regardless of age', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      // Age the createdAt
      const item = store.get(id);
      item.createdAt = new Date(Date.now() - 3700000).toISOString();
      store.cleanup();
      expect(store.get(id)).toBeDefined();
    });
  });

  describe('findBySessionId', () => {
    it('returns all approval items for a given sessionId', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"ls"}', cwd: '/ws' });
      store.create({ sessionId: 's1', toolName: 'Write', toolInput: '{"file_path":"/ws/a.js"}', cwd: '/ws' });
      store.create({ sessionId: 's2', toolName: 'Bash', toolInput: '{}', cwd: '/ws2' });

      const items = store.findBySessionId('s1');
      expect(items.length).toBe(2);
      expect(items.every(i => i.sessionId === 's1')).toBe(true);
    });

    it('returns empty array when no items match sessionId', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      expect(store.findBySessionId('s2')).toEqual([]);
    });
  });

  describe('listPending', () => {
    it('returns only PENDING approval items', () => {
      const id1 = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      const id2 = store.create({ sessionId: 's2', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      const id3 = store.create({ sessionId: 's3', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.resolve(id3, 'APPROVED');

      const pending = store.listPending();
      expect(pending.length).toBe(2);
      expect(pending.every(i => i.status === 'PENDING')).toBe(true);
    });

    it('returns empty array when no PENDING items exist', () => {
      const id = store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.resolve(id, 'DENIED');
      expect(store.listPending()).toEqual([]);
    });

    it('returns empty array when store is empty', () => {
      expect(store.listPending()).toEqual([]);
    });
  });

  describe('flush', () => {
    it('explicit flush persists current state', () => {
      store.create({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' });
      store.flush();
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'approval-requests.json'), 'utf8'));
      expect(data.length).toBe(1);
    });
  });
});