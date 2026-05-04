// Utils — atomic file write, safe JSON load, file lock helpers
// See: cc-bridge-v3-final-plan.md Section 2.3

const fs = require('fs');
const lockfile = require('proper-lockfile');

function atomicWriteSync(filePath, data) {
  const dir = fs.existsSync(filePath) ? undefined : (() => {
    fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
    return undefined;
  })();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Windows: renameSync fails if target exists, unlink first
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EXDEV') {
      fs.unlinkSync(filePath);
      fs.renameSync(tmp, filePath);
    } else {
      throw e;
    }
  }
}

function safeLoadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // File corrupt or missing
  }
  return {};
}

async function acquireWorkspaceLock(workspace) {
  return await lockfile.lock(workspace, {
    retries: { retries: 5, minTimeout: 100 }
  });
}

async function releaseWorkspaceLock(release) {
  await release();
}

module.exports = { atomicWriteSync, safeLoadJson, acquireWorkspaceLock, releaseWorkspaceLock };