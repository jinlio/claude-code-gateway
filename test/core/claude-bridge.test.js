// Tests for claude-bridge.js — dual Map, spawnSession, exit listener, heartbeat, timeout

const { ClaudeBridge, DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_SESSION_TIMEOUT } = require('../../src/core/claude-bridge');
const { spawn } = require('child_process');

// Mock child_process.spawn
jest.mock('child_process');
jest.mock('../../src/core/utils', () => ({
  acquireWorkspaceLock: jest.fn().mockResolvedValue(jest.fn()),
  releaseWorkspaceLock: jest.fn().mockResolvedValue(undefined)
}));

describe('ClaudeBridge', () => {
  let bridge;
  let mockProc;

  beforeEach(() => {
    bridge = new ClaudeBridge();
    mockProc = {
      exitCode: null,
      kill: jest.fn(),
      on: jest.fn(),
      stdin: { write: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() }
    };
    spawn.mockReturnValue(mockProc);
    jest.useFakeTimers();
  });

  afterEach(() => {
    bridge.stopHeartbeat();
    jest.useRealTimers();
  });

  describe('findActiveSession', () => {
    it('returns sessionId when an active session exists for the sender', () => {
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true });
      bridge.sessionMeta.set('s2', { senderId: 'user2', active: true });
      expect(bridge.findActiveSession('user1')).toBe('s1');
    });

    it('returns null when no active session exists', () => {
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: false });
      expect(bridge.findActiveSession('user1')).toBeNull();
    });

    it('returns null when sender has no session at all', () => {
      expect(bridge.findActiveSession('unknown')).toBeNull();
    });

    it('returns first active session if multiple exist for sender', () => {
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true });
      bridge.sessionMeta.set('s2', { senderId: 'user1', active: true });
      expect(bridge.findActiveSession('user1')).toBe('s1');
    });
  });

  describe('checkSessionAlive', () => {
    it('returns alive:false and cleans up when process not found', () => {
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true });
      const result = bridge.checkSessionAlive('s1');
      expect(result).toEqual({ alive: false });
      expect(bridge.sessionMeta.has('s1')).toBe(false);
    });

    it('returns alive:true when process is running (exitCode null)', () => {
      bridge.processMap.set('s1', mockProc);
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true });
      expect(bridge.checkSessionAlive('s1')).toEqual({ alive: true });
    });

    it('returns alive:false and cleans up when process has exited', () => {
      const exitedProc = { ...mockProc, exitCode: 0 };
      bridge.processMap.set('s1', exitedProc);
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true });
      expect(bridge.checkSessionAlive('s1')).toEqual({ alive: false });
      expect(bridge.processMap.has('s1')).toBe(false);
      expect(bridge.sessionMeta.has('s1')).toBe(false);
    });
  });

  describe('spawnSession', () => {
    it('creates a new session when no active session exists', async () => {
      const result = await bridge.spawnSession('user1', '/workspace', 'hello');
      expect(result.reused).toBe(false);
      expect(result.sessionId).toMatch(/^cc-/);
      expect(bridge.processMap.has(result.sessionId)).toBe(true);
      expect(bridge.sessionMeta.has(result.sessionId)).toBe(true);
    });

    it('returns existing session when one is already active', async () => {
      bridge.sessionMeta.set('existing', { senderId: 'user1', active: true });
      const result = await bridge.spawnSession('user1', '/workspace', 'hello');
      expect(result.reused).toBe(true);
      expect(result.sessionId).toBe('existing');
    });

    it('registers exit event listener on spawned process', async () => {
      await bridge.spawnSession('user1', '/workspace', 'hello');
      expect(mockProc.on).toHaveBeenCalledWith('exit', expect.any(Function));
    });

    it('sets metadata fields correctly', async () => {
      const result = await bridge.spawnSession('user1', '/workspace', 'hello');
      const meta = bridge.sessionMeta.get(result.sessionId);
      expect(meta.senderId).toBe('user1');
      expect(meta.cwd).toBe('/workspace');
      expect(meta.active).toBe(true);
      expect(meta.messageCount).toBe(0);
    });

    it('passes model option to claude spawn args', async () => {
      await bridge.spawnSession('user1', '/workspace', 'hello', { model: 'opus' });
      expect(spawn).toHaveBeenCalledWith('claude', expect.arrayContaining(['--model', 'opus']), expect.any(Object));
    });

    it('passes allowedTools option to claude spawn args', async () => {
      await bridge.spawnSession('user1', '/workspace', 'hello', { allowedTools: 'Edit,Write,Bash' });
      expect(spawn).toHaveBeenCalledWith('claude', expect.arrayContaining(['--allowedTools', 'Edit,Write,Bash']), expect.any(Object));
    });
  });

  describe('terminateSession', () => {
    it('kills the process and marks session as inactive', () => {
      bridge.processMap.set('s1', mockProc);
      bridge.sessionMeta.set('s1', {
        senderId: 'user1', active: true, lockRelease: jest.fn()
      });
      bridge.terminateSession('s1');
      expect(mockProc.kill).toHaveBeenCalled();
      expect(bridge.processMap.has('s1')).toBe(false);
      expect(bridge.sessionMeta.get('s1').active).toBe(false);
    });

    it('does not kill process if already exited', () => {
      const exitedProc = { ...mockProc, exitCode: 1 };
      bridge.processMap.set('s1', exitedProc);
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true });
      bridge.terminateSession('s1');
      expect(exitedProc.kill).not.toHaveBeenCalled();
    });

    it('handles missing process gracefully', () => {
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true });
      bridge.terminateSession('s1');
      expect(bridge.sessionMeta.get('s1').active).toBe(false);
    });

    it('releases workspace lock on terminate', () => {
      const mockRelease = jest.fn().mockResolvedValue(undefined);
      bridge.processMap.set('s1', mockProc);
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: true, lockRelease: mockRelease });
      bridge.terminateSession('s1');
      // releaseWorkspaceLock is called with lockRelease
      const { releaseWorkspaceLock } = require('../../src/core/utils');
      expect(releaseWorkspaceLock).toHaveBeenCalledWith(mockRelease);
    });
  });

  describe('heartbeat', () => {
    it('starts heartbeat timer on spawnSession', async () => {
      await bridge.spawnSession('user1', '/workspace', 'hello');
      expect(bridge._heartbeatTimer).not.toBeNull();
    });

    it('stops heartbeat when no active sessions remain', () => {
      bridge.sessionMeta.set('s1', { senderId: 'user1', active: false });
      bridge.startHeartbeat();
      jest.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL);
      expect(bridge._heartbeatTimer).toBeNull();
    });

    it('terminates timed-out sessions', () => {
      bridge.processMap.set('s1', mockProc);
      bridge.sessionMeta.set('s1', {
        senderId: 'user1', active: true,
        lastActiveAt: new Date(Date.now() - DEFAULT_SESSION_TIMEOUT - 1000).toISOString(),
        lockRelease: jest.fn()
      });
      bridge.startHeartbeat();
      jest.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL);
      expect(bridge.sessionMeta.get('s1').active).toBe(false);
    });

    it('terminates dead-process sessions', () => {
      // Process missing from processMap but meta still exists
      bridge.sessionMeta.set('s1', {
        senderId: 'user1', active: true,
        lastActiveAt: new Date().toISOString(),
        lockRelease: jest.fn()
      });
      bridge.startHeartbeat();
      jest.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL);
      expect(bridge.sessionMeta.has('s1')).toBe(false);
    });
  });

  describe('updateActivity', () => {
    it('updates lastActiveAt and increments messageCount', () => {
      bridge.sessionMeta.set('s1', {
        senderId: 'user1', messageCount: 5, lastActiveAt: '2026-01-01T00:00:00Z'
      });
      bridge.updateActivity('s1');
      const meta = bridge.sessionMeta.get('s1');
      expect(meta.messageCount).toBe(6);
      expect(meta.lastActiveAt).not.toBe('2026-01-01T00:00:00Z');
    });

    it('does nothing for unknown sessionId', () => {
      bridge.updateActivity('nonexistent');
      expect(bridge.sessionMeta.has('nonexistent')).toBe(false);
    });
  });

  describe('exit event handler', () => {
    it('cleans up processMap and updates meta on exit', async () => {
      await bridge.spawnSession('user1', '/workspace', 'hello');
      const sessionId = bridge.findActiveSession('user1');

      // Simulate exit callback
      const exitHandler = mockProc.on.mock.calls.find(c => c[0] === 'exit')[1];
      exitHandler(0);

      expect(bridge.processMap.has(sessionId)).toBe(false);
      expect(bridge.sessionMeta.get(sessionId).processAlive).toBe(false);
      expect(bridge.sessionMeta.get(sessionId).exitCode).toBe(0);
    });
  });
});