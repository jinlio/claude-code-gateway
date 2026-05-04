// Utils — atomic file write, safe JSON load, file lock helpers
// See: cc-bridge-v3-final-plan.md Section 2.3

const fs = require('fs');

function atomicWriteSync(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
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

module.exports = { atomicWriteSync, safeLoadJson };