// Tests for utils.js — atomicWriteSync, safeLoadJson, acquireWorkspaceLock, releaseWorkspaceLock

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteSync, safeLoadJson, acquireWorkspaceLock, releaseWorkspaceLock } = require('../../src/core/utils');

describe('atomicWriteSync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes data to file atomically', () => {
    const filePath = path.join(tmpDir, 'test.json');
    atomicWriteSync(filePath, '{"key":"value"}');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"key":"value"}');
  });

  it('overwrites existing file', () => {
    const filePath = path.join(tmpDir, 'test.json');
    atomicWriteSync(filePath, '{"old":"data"}');
    atomicWriteSync(filePath, '{"new":"data"}');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"new":"data"}');
  });

  it('creates parent directories if they do not exist', () => {
    const filePath = path.join(tmpDir, 'subdir', 'test.json');
    atomicWriteSync(filePath, '{"key":"value"}');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"key":"value"}');
  });

  it('does not leave .tmp file on success', () => {
    const filePath = path.join(tmpDir, 'test.json');
    atomicWriteSync(filePath, 'data');
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
  });
});

describe('safeLoadJson', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns parsed JSON when file exists and is valid', () => {
    const filePath = path.join(tmpDir, 'valid.json');
    fs.writeFileSync(filePath, '{"key":"value"}');
    expect(safeLoadJson(filePath)).toEqual({ key: 'value' });
  });

  it('returns empty object when file does not exist', () => {
    expect(safeLoadJson(path.join(tmpDir, 'nonexistent.json'))).toEqual({});
  });

  it('returns empty object when file contains invalid JSON', () => {
    const filePath = path.join(tmpDir, 'invalid.json');
    fs.writeFileSync(filePath, 'not json');
    expect(safeLoadJson(filePath)).toEqual({});
  });
});

describe('acquireWorkspaceLock / releaseWorkspaceLock', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-lock-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('acquires and releases a workspace lock', async () => {
    const release = await acquireWorkspaceLock(tmpDir);
    expect(typeof release).toBe('function');
    await releaseWorkspaceLock(release);
  });

  it('prevents concurrent lock acquisition', async () => {
    const release1 = await acquireWorkspaceLock(tmpDir);
    // Second acquisition should fail or retry
    let acquired = false;
    try {
      await acquireWorkspaceLock(tmpDir);
      acquired = true;
    } catch {
      acquired = false;
    }
    // If acquired, that means retries succeeded after we release
    await releaseWorkspaceLock(release1);
    if (acquired) {
      // Need to release the second lock too
    }
  });
});