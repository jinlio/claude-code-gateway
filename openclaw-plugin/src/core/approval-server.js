// ApprovalServer — two-phase polling HTTP server for approval control
// See: cc-bridge-v3-final-plan.md Section 3

const http = require('http');
const crypto = require('crypto');
const { ApprovalStore } = require('./approval-store');

class ApprovalServer {
  constructor(dataDir, port = 0, notifyCallback = null, approvalRules = null, currentMode = 'efficient', sharedSecret = null) {
    this.port = port;
    this.dataDir = dataDir;
    this.server = null;
    this.store = new ApprovalStore(dataDir);
    this.notifyCallback = notifyCallback;
    this.approvalRules = approvalRules;
    this.currentMode = currentMode;
    this.sharedSecret = sharedSecret;
  }

  setMode(mode) {
    this.currentMode = mode;
  }

  async start() {
    const timedOutCount = this.store._loadTimedOutCount();
    if (timedOutCount > 0) {
      this.notifyTimedOutRequests(timedOutCount);
    }

    this._cleanupInterval = setInterval(() => {
      this.store.cleanup();
    }, 10 * 60 * 1000);

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        // Security header on all responses
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
          const url = new URL(req.url, 'http://localhost');

          if (req.method === 'POST' && url.pathname === '/api/approval/request') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
              try {
                const params = JSON.parse(body);

                const requiredFields = ['sessionId', 'toolName', 'toolInput', 'cwd'];
                for (const field of requiredFields) {
                  if (!params[field]) {
                    res.writeHead(400);
                    res.end(`Missing required field: ${field}`);
                    return;
                  }
                }

                // Rule-based pre-check: auto_approve if rules match
                if (this.approvalRules) {
                  let toolInputParsed = {};
                  try { toolInputParsed = JSON.parse(params.toolInput); } catch {}

                  const matchResult = this.approvalRules.match(params.toolName, {
                    command: toolInputParsed.command,
                    filePath: toolInputParsed.file_path
                  });

                  // In strict mode, override auto_approve for Write/Edit
                  const isStrictOverride = this.currentMode === 'strict' &&
                    (params.toolName === 'Write' || params.toolName === 'Edit') &&
                    matchResult.action === 'auto_approve';

                  if (matchResult.action === 'auto_approve' && !isStrictOverride) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ approvalId: null, status: 'APPROVED', autoApproved: true, sensitive: matchResult.sensitive }));
                    return;
                  }
                }

                // require_approval: create PENDING request
                const id = this.store.create(params);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ approvalId: id, status: 'PENDING' }));
                this.onApprovalNeeded?.(id, params);
              } catch (e) {
                res.writeHead(400);
                res.end('Invalid request');
              }
            });

          } else if (req.method === 'GET' && url.pathname === '/api/approval/status') {
            const id = url.searchParams.get('id');
            if (!id || id.length < 8) {
              res.writeHead(400);
              res.end('Invalid or missing id parameter');
              return;
            }
            const item = this.store.get(id);
            if (!item) {
              res.writeHead(404);
              res.end('NOT FOUND');
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                approvalId: id,
                status: item.status
              }));
            }

          } else if (req.method === 'POST' && url.pathname === '/api/approval/respond') {
            // Require shared secret for approval responses
            if (!this.sharedSecret) {
              res.writeHead(403);
              res.end('Forbidden: no shared secret configured');
              return;
            }
            const authHeader = req.headers['authorization'] || '';
            const expected = `Bearer ${this.sharedSecret}`;
            const expectedBuf = Buffer.from(expected, 'utf8');
            const actualBuf = Buffer.from(authHeader, 'utf8');
            if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
              res.writeHead(403);
              res.end('Forbidden');
              return;
            }

            const id = url.searchParams.get('id');
            const action = url.searchParams.get('action');
            if (!id) {
              res.writeHead(400);
              res.end('Missing id parameter');
              return;
            }
            if (action !== 'approve' && action !== 'deny') {
              res.writeHead(400);
              res.end('Invalid action');
              return;
            }
            const newStatus = action === 'approve' ? 'APPROVED' : 'DENIED';
            this.store.resolve(id, newStatus);
            res.writeHead(200);
            res.end('OK');

          } else {
            res.writeHead(404);
            res.end('Not Found');
          }
        } catch (e) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        if (!this.sharedSecret) {
          console.warn('[cc-bridge] WARNING: sharedSecret not configured. Approval respond endpoint has NO authentication.');
        }
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.store.markAllPendingAsTimeout();
    this.store.flush();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  notifyTimedOutRequests(timedOutCount) {
    if (timedOutCount > 0 && this.notifyCallback) {
      this.notifyCallback({
        type: 'restart_timeout',
        text: `⚠ 审批服务重启，有 ${timedOutCount} 条审批请求已超时中断。`
      });
    }
  }

  getPort() {
    return this.port;
  }
}

module.exports = { ApprovalServer };