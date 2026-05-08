# CC Gateway Session Data Schema

Both OpenClaw and Hermes plugins must use this identical data format for session persistence.

## File: persistent-sessions.json

Location: `{dataDir}/persistent-sessions.json`

```json
{
  "user123::/path/to/workspace": {
    "senderId": "user123",
    "workspace": "/path/to/workspace",
    "sessionId": "cc-1709123456-a1b2c3",
    "active": true,
    "startedAt": "2026-05-08T10:00:00.000Z",
    "lastActiveAt": "2026-05-08T10:30:00.000Z",
    "messageCount": 5,
    "processAlive": true,
    "stoppedAt": null
  }
}
```

## Compound Key Format

Key: `{senderId}::{workspace}`

- `senderId`: User identifier from the messaging platform
- `workspace`: Absolute path to the working directory
- Both plugins must use this exact key format for interoperability

## Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `senderId` | string | User identifier (from platform event) |
| `workspace` | string | Absolute path to working directory |
| `sessionId` | string | Session ID in format `cc-{timestamp}-{random6}` |
| `active` | boolean | Whether the session is currently active |
| `startedAt` | string | ISO 8601 timestamp when session started |
| `lastActiveAt` | string | ISO 8601 timestamp of last activity |
| `messageCount` | number | Number of messages exchanged in session |
| `processAlive` | boolean | Whether the Claude Code process is still running |
| `stoppedAt` | string/null | ISO 8601 timestamp when session was stopped (null if active) |

## Atomic Write Convention

Both implementations must use atomic write for persistence:

1. Write data to a `.tmp` file (e.g., `persistent-sessions.json.tmp`)
2. Rename `.tmp` to the target file (atomic on POSIX; best-effort on Windows using delete+rename fallback)
3. Never write directly to the target file (risk of corruption on crash)

## Cross-Platform Mapping

| OpenClaw Field | Hermes Field | Mapping |
|----------------|-------------|---------|
| `event.senderId` | `session_source.user_id` | Both map to `senderId` in JSON |
| `ctx.channelId` | `session_source.platform` | Not stored in this file (kept in session routes) |