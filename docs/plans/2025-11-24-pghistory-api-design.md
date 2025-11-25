# PgHistory REST API Design

**Date:** 2025-11-24
**Status:** Approved

## Overview

Build a RESTful API over the PgHistory class to expose audit log querying, reverting, and user context management capabilities.

## Requirements

- **Full API coverage:** Expose all PgHistory methods (getHistory, search, revert, setUser, clearUser)
- **Authentication:** JWT auth for all endpoints using existing PG_HISTORY_JWT_SECRET
- **Initialization:** Configure via ServerConfig, similar to archiverConfig pattern
- **Error handling:** Structured JSON error responses

## Architecture

### RESTful Endpoints

**Audit History:**
- `GET /api/history/:table/:recordId` - Get history for a specific record
  - Query params: `limit`, `cursor`, `order`
  - Returns: Paginated audit entries

**Search:**
- `POST /api/history/search` - Search across audit logs
  - Body: `{ tables, query?, operation?, dateFrom?, dateTo?, changedBy?, limit?, cursor? }`
  - Returns: Paginated audit entries

**Revert:**
- `POST /api/history/revert` - Revert a record to a previous state
  - Body: `{ tableName, recordId, auditEntryId }`
  - Returns: Success confirmation

**User Context:**
- `POST /api/context/user` - Set user context for audit tracking
  - Body: `{ userId, metadata? }`
  - Returns: Success confirmation
- `DELETE /api/context/user` - Clear user context
  - Returns: Success confirmation

### Configuration

Extend ServerConfig with optional historyConfig:

```typescript
interface HistoryConfig {
  tables: string[]
}

interface ServerConfig {
  pool: Pool
  port?: number
  enableArchiver?: boolean
  archiverConfig?: ArchiverConfig
  runOptions?: RunOptions
  historyConfig?: HistoryConfig  // NEW
}
```

### Initialization

In `createServer()`:
1. Check if `config.historyConfig` exists
2. Create PgHistory instance: `new PgHistory({ tables: config.historyConfig.tables, pool: config.pool })`
3. Store in Hono context variables
4. Register API routes conditionally (only if historyConfig present)

### Error Handling

Structured JSON error responses:

```typescript
{
  error: {
    code: string,      // e.g., "VALIDATION_ERROR", "NOT_FOUND", "DATABASE_ERROR"
    message: string,   // Human-readable error message
    details?: any      // Optional additional context
  }
}
```

HTTP status codes:
- 400: Validation errors
- 404: Record/entry not found
- 500: Database/server errors

## Implementation Notes

- All endpoints require JWT authentication via existing middleware
- Reuse existing pool from ServerConfig (no separate connection)
- No automatic setup() call - assume triggers already configured
- Follow existing patterns from archiverConfig and /api/stats endpoint
