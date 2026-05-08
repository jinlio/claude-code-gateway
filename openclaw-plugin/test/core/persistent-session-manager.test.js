// Tests for persistent-session-manager.js — compound-key isolation, activate/deactivate, atomic persistence

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PersistentSessionManager } = require('../../src/core/persistent-session-manager');

describe('PersistentSessionManager', () => {
  let tmpDir;
  let manager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-session-'));
    manager = new PersistentSessionManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getKey', () => {
    it('creates compound key from senderId and workspace', () => {
      expect(manager.getKey('user1', '/workspace')).toBe('user1::/workspace');
    });

    it('different workspaces produce different keys', () => {
      expect(manager.getKey('user1', '/ws1')).not.toBe(manager.getKey('user1', '/ws2'));
    });
  });

  describe('activate', () => {
    it('creates a new session with active status', () => {
      const session = manager.activate('user1', '/workspace', 's1');
      expect(session.active).toBe(true);
      expect(session.senderId).toBe('user1');
      expect(session.workspace).toBe('/workspace');
      expect(session.sessionId).toBe('s1');
    });

    it('persists session data to file', () => {
      manager.activate('user1', '/workspace', 's1');
      const filePath = path.join(tmpDir, 'persistent-sessions.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(data['user1::/workspace']).toBeDefined();
    });

    it('sets startedAt and lastActiveAt timestamps', () => {
      const session = manager.activate('user1', '/workspace', 's1');
      expect(session.startedAt).toBeDefined();
      expect(session.lastActiveAt).toBeDefined();
    });
  });

  describe('getActive', () => {
    it('returns the active session for a sender', () => {
      manager.activate('user1', '/workspace', 's1');
      const session = manager.getActive('user1');
      expect(session).toBeDefined();
      expect(session.sessionId).toBe('s1');
    });

    it('returns null when no active session exists', () => {
      expect(manager.getActive('unknown')).toBeNull();
    });

    it('returns null after session is deactivated', () => {
      manager.activate('user1', '/workspace', 's1');
      manager.deactivate('user1');
      expect(manager.getActive('user1')).toBeNull();
    });
  });

  describe('deactivate', () => {
    it('marks session as inactive with stoppedAt timestamp', () => {
      manager.activate('user1', '/workspace', 's1');
      manager.deactivate('user1');

      const filePath = path.join(tmpDir, 'persistent-sessions.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const session = data['user1::/workspace'];
      expect(session.active).toBe(false);
      expect(session.stoppedAt).toBeDefined();
    });

    it('does nothing when no active session exists', () => {
      manager.deactivate('unknown');
      // No crash, no file created
    });
  });
});