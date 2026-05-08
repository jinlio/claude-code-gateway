# CC Gateway Approval HTTP API Specification

Both the OpenClaw (Node.js) and Hermes-Agent (Python) approval servers must implement this identical HTTP API. Hook scripts depend on this contract to function correctly.

## Base URL

- Bind to `127.0.0.1` (localhost only)
- Port configurable; `0` means OS-assigned (auto)
- Base URL: `http://127.0.0.1:{port}`

## Endpoints

### 1. POST /api/approval/request

Create an approval request or get an auto-approve decision.

**Request:**
```json
{
  "sessionId": "cc-1709123456-a1b2c3",
  "toolName": "Bash",
  "toolInput": "{\"command\":\"rm -rf /tmp\"}",
  "cwd": "/path/to/workspace",
  "timestamp": 1709123456789
}
```

**Response — Auto-approved (rule-based):**
```json
{
  "approvalId": null,
  "status": "APPROVED",
  "autoApproved": true,
  "sensitive": false
}
```

**Response — Pending (requires human approval):**
```json
{
  "approvalId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "PENDING"
}
```

**Response — Error:**
- HTTP 400: Invalid request body or missing required fields
- Body: plain text error message

**Behavior:**
1. Parse request body as JSON
2. If `approvalRules` is configured, match `toolName` against rules with context extracted from `toolInput` (parse as JSON, extract `command` and `file_path`)
3. In `strict` mode, override any `auto_approve` rule result for Write/Edit tools to `require_approval`
4. If rule result is `auto_approve` (and not overridden): return APPROVED response immediately
5. Otherwise: create a PENDING approval request, persist to store, invoke `onApprovalNeeded` callback, return PENDING response with approvalId

### 2. GET /api/approval/status?id={uuid}

Poll the status of an approval request.

**Request:**
- Query parameter: `id` — full UUID or short ID (first 8+ characters)

**Response — Found:**
```json
{
  "approvalId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "PENDING"
}
```

Possible status values: `PENDING`, `APPROVED`, `DENIED`, `TIMEOUT`

**Response — Not found:**
- HTTP 404
- Body: `NOT FOUND`

### 3. POST /api/approval/respond?id={uuid}&action={approve|deny}

Resolve an approval request (approve or deny).

**Request:**
- Query parameters: `id` (full UUID), `action` (`approve` or `deny`)
- Header: `Authorization: Bearer {sharedSecret}` (required if `sharedSecret` is configured)

**Response — Success:**
- HTTP 200
- Body: `OK`

**Response — Forbidden (wrong or missing secret):**
- HTTP 403
- Body: `Forbidden`

**Behavior:**
1. If `sharedSecret` is configured, validate `Authorization` header equals `Bearer {sharedSecret}`
2. Map `action=approve` to status `APPROVED`, `action=deny` to status `DENIED`
3. Resolve the approval request in the store
4. Persist updated status

## Fail-Closed Semantics

Hook scripts follow these exit codes:

| Exit Code | Meaning |
|-----------|---------|
| 0 | Approved (tool execution allowed) |
| 2 | Denied or service unreachable (tool execution blocked) |
| 3 | Timeout (5 minutes exceeded) |

**Critical**: If the approval server is unreachable, hook scripts MUST exit with code 2 (deny), NOT allow the operation. This is fail-closed design.

## Two-Phase Polling Protocol

Hook scripts use a two-phase polling approach to avoid long-lived HTTP connections:

1. **Phase 1 — Request**: POST `/api/approval/request` with tool info. If auto-approved, exit 0 immediately.
2. **Phase 2 — Poll**: GET `/api/approval/status` every 2 seconds, up to 150 times (5 minutes total timeout).

If 150 polls complete without APPROVED/DENIED/TIMEOUT status, exit with code 3 (timeout).

## Approval Modes

| Mode | Behavior |
|------|----------|
| `efficient` | Write/Edit tools auto-approved (rule-based); only Bash requires approval |
| `strict` | ALL tools require approval, even if rules say auto_approve (Write/Edit override) |

Mode can be switched at runtime via `/cc_mode` command.

## Data Persistence

Approval requests are persisted to `approval-requests.json` using atomic write (write to `.tmp` file, then rename). On server restart, all PENDING requests from the previous session are marked as TIMEOUT.

## Cleanup

Approved/denied/timeout requests older than 1 hour are cleaned up periodically to prevent unbounded growth.