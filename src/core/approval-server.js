// ApprovalServer — two-phase polling HTTP server for approval control
// See: cc-bridge-v3-final-plan.md Section 3

const http = require('http');
const path = require('path');
const { ApprovalStore } = require('./approval-store');

class ApprovalServer {
  constructor(dataDir, port = 0, notifyCallback = null) {
    this.port = port;
    this.dataDir = dataDir;
    this.server = null;
    this.store = new ApprovalStore(dataDir);
    this.notifyCallback = notifyCallback;
  }

  async start() {
    const timedOutCount = this.store._loadTimedOutCount();
    if (timedOutCount > 0) {
      this.notifyTimedOutRequests(timedOutCount);
    }

    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');

        if (req.method === 'POST' && url.pathname === '/api/approval/request') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            try {
              const params = JSON.parse(body);
              const id = this.store.create(params);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ approvalId: id, status: 'PENDING' }));
              this.onApprovalNeeded?.(id, params);
            } catch (e) {
              res.writeHead(400);
              res.end(e.message);
            }
          });

        } else if (req.method === 'GET' && url.pathname === '/api/approval/status') {
          const id = url.searchParams.get('id');
          const item = this.store.get(id);
          if (!item) {
            res.writeHead(404);
            res.end('NOT FOUND');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ approvalId: id, status: item.status }));
          }

        } else if (req.method === 'POST' && url.pathname === '/api/approval/respond') {
          const id = url.searchParams.get('id');
          const action = url.searchParams.get('action');
          const newStatus = action === 'approve' ? 'APPROVED' : 'DENIED';
          this.store.resolve(id, newStatus);
          res.writeHead(200);
          res.end('OK');

        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
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