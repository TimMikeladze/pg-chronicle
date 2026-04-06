# pg-history

PostgreSQL audit trails with automated S3 archival.

[![npm version](https://img.shields.io/npm/v/pg-history.svg)](https://www.npmjs.com/package/pg-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Examples](#examples)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Server & REST API](#server--rest-api)
- [Deployment](#deployment)
- [Archiver](#archiver)
- [Environment Variables](#environment-variables)
- [Error Handling](#error-handling)
- [Testing](#testing)
- [Limitations](#limitations)

## Quick Start

```typescript
import { Pool } from 'pg'
import { PgHistory } from 'pg-history'

const pool = new Pool({ connectionString: 'postgres://localhost:5432/mydb' })
const history = new PgHistory({ pool, tables: ['users'] })
await history.setup()

// That's it. Every INSERT/UPDATE/DELETE on 'users' is now audited automatically.

// Normal database operations — triggers capture everything
await pool.query(`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')`)
await pool.query(`UPDATE users SET name = 'Alice Smith' WHERE id = 1`)
await pool.query(`UPDATE users SET email = 'alice.smith@example.com' WHERE id = 1`)

// See the full history of changes
const result = await history.getHistory('users', '1')
// [
//   { operation: 'UPDATE', oldData: { name: 'Alice Smith', email: 'alice@example.com' }, ... },
//   { operation: 'UPDATE', oldData: { name: 'Alice', ... }, newData: { name: 'Alice Smith', ... } },
//   { operation: 'INSERT', newData: { id: 1, name: 'Alice', email: 'alice@example.com' } },
// ]

// Search across all audited data (GIN-indexed JSON containment)
const found = await history.search({
  tables: ['users'],
  query: '{"email": "alice@example.com"}',
})

// Revert to a previous state
await history.revert('users', '1', result.data[2].id) // back to original INSERT state

await history.close()
```

3 lines to set up, then query with `getHistory` / `search` / `revert`.

## Installation

```bash
bun add pg-history
```

Peer dependency: `pg`.

Requires PostgreSQL 12+, Node.js 18+ or Bun.

## Examples

Working examples in [`examples/`](./examples). Each creates a temporary database, runs against real PostgreSQL, and cleans up after itself.

```bash
docker compose up -d
bun examples/basic-audit-trail.ts
```

| Example | What it shows |
|---------|---------------|
| [basic-audit-trail.ts](./examples/basic-audit-trail.ts) | Setup, INSERT/UPDATE/DELETE tracking, history retrieval |
| [search-and-revert.ts](./examples/search-and-revert.ts) | JSONB containment search, text search, filtering, revert |
| [multi-table-tracking.ts](./examples/multi-table-tracking.ts) | Multiple related tables, composite primary keys, cross-table search |
| [rest-api-server.ts](./examples/rest-api-server.ts) | Hono REST API server with history endpoints |
| [cron-archival.ts](./examples/cron-archival.ts) | POST /api/archive endpoint, cron secret auth, health status |
| [archival-lifecycle.ts](./examples/archival-lifecycle.ts) | Full S3 archival pipeline: archive, soft delete, hard delete |
| [error-handling.ts](./examples/error-handling.ts) | Typed error classes, catching specific errors |
| [vercel/](./examples/vercel) | Deployable Vercel project: serverless API + cron archival + local test |

## How It Works

pg-history uses PostgreSQL's own trigger system to capture every change. Nothing runs in your application — the database does all the work.

### 1. Setup installs triggers

When you call `history.setup()`, pg-history creates:
- A partitioned `audit_log` table (one partition per tracked table for fast queries)
- An `AFTER` trigger on each tracked table
- GIN indexes on the JSONB columns for fast search

The triggers run inside PostgreSQL. Once installed, **every write is audited regardless of what connects** — your app, a migration script, `psql`, another microservice, or a serverless function. If it touches the table, it gets logged.

### 2. Triggers capture changes in the same transaction

When a row is inserted, updated, or deleted, the trigger fires and writes to `audit_log` within the **same transaction**. If the write fails, the audit entry is rolled back too. If the audit insert fails, the original write is rolled back. This guarantees no operation succeeds without being recorded.

```
BEGIN
  UPDATE users SET name = 'Bob' WHERE id = 1;    -- your write
  INSERT INTO audit_log (...);                     -- trigger fires automatically
COMMIT                                             -- both succeed or both fail
```

### 3. Query and revert through the library

The `PgHistory` class provides methods to read back the audit trail:
- **`getHistory(table, recordId)`** — full change history for one record, cursor-paginated
- **`search({ tables, query, ... })`** — search across tables by JSON fields or text, with date and operation filters
- **`revert(table, recordId, auditEntryId)`** — restore a record to any previous state in a single transaction

### 4. Archival lifecycle (optional)

For tables that accumulate millions of audit records, the archiver moves old data to S3 as compressed Parquet files:

```
Day 0    Record written to audit_log
Day 90   Upload to S3 as Parquet → mark archived_at
Day 90   Soft delete (only if S3 backup confirmed)
Day 97   Hard delete (only after verifying S3 file exists)
```

Advisory locks prevent concurrent archival of the same table. Each step verifies the previous one succeeded before proceeding — no data is deleted without a confirmed backup.

## Architecture

### audit_log Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | `BIGSERIAL` | Audit entry ID |
| `table_name` | `TEXT` | Source table |
| `record_id` | `TEXT` | PK value(s) of affected row |
| `operation` | `TEXT` | `INSERT` / `UPDATE` / `DELETE` |
| `changed_at` | `TIMESTAMPTZ` | Transaction timestamp |
| `old_data` | `JSONB` | Previous row state |
| `new_data` | `JSONB` | New row state |

### Indexes

- GIN on `old_data`, `new_data` for `@>` containment queries
- B-tree on `(table_name, record_id, changed_at DESC)`
- B-tree on `changed_at DESC`

### Primary Key Handling

| PK Type | `record_id` |
|---------|-------------|
| Single column | PK cast to text |
| Composite | Values joined with `\|` |
| None | `md5(row_to_json(...)::text)` |

### Source Files

```
src/
  PgHistory.ts          Setup, getHistory, search, revert, teardown
  PgHistoryArchiver.ts  S3 upload, soft/hard delete
  orchestrator.ts       Multi-table archival coordination
  server.ts             Hono REST API
  schema.ts             Archiver DDL
  parquet.ts            Parquet read/write (hyparquet, Snappy)
  errors.ts             Typed error classes
  types.ts              TypeScript interfaces
  vercel.ts             Vercel serverless entry point
```

## API Reference

### Constructor

```typescript
const history = new PgHistory({
  tables: ['users', 'orders'],
  pool: existingPool,            // or connection: 'postgres://...'
})
```

Passing `connection` creates an internal Pool; `close()` ends it. Passing `pool` borrows yours; `close()` is a no-op.

### `setup(): Promise<void>`

Creates `audit_log` table, partitions, indexes, and triggers. Idempotent — safe to call on every app startup.

**Important:** Must be called before `getHistory()`, `search()`, or `revert()`. These methods throw `SetupRequiredError` if `setup()` hasn't been called.

### `getHistory(tableName, recordId, options?): Promise<PaginatedResult<AuditEntry>>`

Options: `limit` (default 50, max 1000), `cursor`, `order` (`'asc'` | `'desc'`).

### `search(options): Promise<PaginatedResult<AuditEntry>>`

Options: `tables` (required), `query`, `operation`, `dateFrom`, `dateTo`, `limit` (default 100, max 1000), `cursor`.

If `query` looks like JSON (`{...}`), uses `@>` containment (GIN-indexed). Otherwise falls back to `ILIKE` text search with a 5-second statement timeout to prevent runaway queries on large tables.

### `revert(tableName, recordId, auditEntryId): Promise<void>`

Restores a record to the state in the given audit entry. Runs in a single transaction. Requires a primary key.

| Original Op | Revert Action |
|-------------|---------------|
| `INSERT` | Deletes the row |
| `DELETE` | Re-inserts from `old_data` |
| `UPDATE` | Restores `old_data` values |

### `teardown(): Promise<void>`

Drops triggers, functions, and `audit_log`. Idempotent.

### `close(): Promise<void>`

Ends internal Pool if one was created.

### Types

```typescript
interface AuditEntry {
  id: string
  tableName: string
  recordId: string
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  changedAt: Date
  oldData: Record<string, unknown> | null
  newData: Record<string, unknown> | null
}

interface PaginatedResult<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}
```

## Server & REST API

```typescript
import { Pool } from 'pg'
import { createServer } from 'pg-history'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const app = await createServer({
  pool,
  port: 3001,
  enableHistory: true,
  historyConfig: { tables: ['users', 'orders'] },
  enableArchiver: true,
  archiverConfig: { /* see Archiver section */ },
})

Bun.serve({ port: 3001, fetch: app.fetch })
```

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check with archival status |
| `GET` | `/openapi` | No | OpenAPI spec |
| `GET` | `/api/stats` | JWT | Archival stats (requires `enableArchiver`) |
| `GET` | `/api/history/:table/:recordId` | JWT | Record history |
| `POST` | `/api/history/search` | JWT | Search history |
| `POST` | `/api/history/revert` | JWT | Revert a record |
| `POST` | `/api/archive` | Cron secret | Trigger archival on demand |

Set `PG_HISTORY_JWT_SECRET` to enable JWT auth on `/api/*`. Public routes (`/health`, `/openapi`) are unprotected.

The `/api/archive` endpoint is authenticated separately via `CRON_SECRET` or `archiveCronSecret` config (see [Vercel Cron](#vercel-cron)).

### Health Check

The `/health` endpoint returns archival status when the archiver is enabled:

```json
{
  "status": "ok",
  "archival": {
    "status": "completed",
    "lastError": null,
    "attempts": 1,
    "lastCompletedAt": "2026-03-17T..."
  }
}
```

`status` is `"degraded"` if archival has failed.

### Standalone

```bash
PG_HISTORY_DATABASE_URL=postgres://localhost:5432/mydb bun run src/server.ts
```

## Deployment

### Fly.io

A `Dockerfile` and `fly.toml` are included. The server runs as a long-lived process with background archival.

```bash
fly secrets set PG_HISTORY_DATABASE_URL=postgres://...
fly secrets set PG_HISTORY_JWT_SECRET=your-secret
fly secrets set PG_HISTORY_S3_BUCKET=audit-archives
fly secrets set PG_HISTORY_S3_ENDPOINT=https://...
fly secrets set PG_HISTORY_S3_ACCESS_KEY_ID=...
fly secrets set PG_HISTORY_S3_SECRET_ACCESS_KEY=...
fly deploy
```

The `fly.toml` is configured with:
- `min_machines_running = 1` — ensures archival always runs
- `kill_timeout = 30s` — gives in-flight archival time to finish on deploys
- `PORT = 8080` — matches Fly's internal port expectation

Archival runs immediately on startup and then on a periodic interval (default: every hour, configurable via `PG_HISTORY_ARCHIVAL_INTERVAL_MS`).

### Vercel (Serverless)

pg-history works in serverless environments. The audit triggers live in PostgreSQL, so auditing works regardless of runtime.

**Option A: Use the library directly in your API routes**

```typescript
// app/api/history/route.ts
import { Pool } from 'pg'
import { PgHistory } from 'pg-history'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
const history = new PgHistory({ pool, tables: ['users', 'orders'] })
const setupDone = history.setup()

export async function GET(req: Request) {
  await setupDone
  const url = new URL(req.url)
  const table = url.searchParams.get('table')!
  const recordId = url.searchParams.get('recordId')!
  const result = await history.getHistory(table, recordId)
  return Response.json(result)
}
```

**Option B: Deploy the full REST API**

```typescript
// api/[[...route]].ts
export { GET, POST } from 'pg-history/vercel'
```

Set environment variables in Vercel:

```
PG_HISTORY_DATABASE_URL=postgres://...
PG_HISTORY_TABLES=users,orders
PG_HISTORY_JWT_SECRET=your-secret
```

The Vercel entry point automatically enables `serverless: true`, which:
- Skips background archival (use [Vercel Cron](#vercel-cron) instead)
- Skips in-memory rate limiting (handle at API gateway / Vercel Firewall level)
- Uses a small pool size (default 3) to stay within connection limits

#### Vercel Cron

Since there's no persistent process in serverless, archival needs an external trigger. A complete working example is in [`examples/vercel/`](./examples/vercel). The setup is three files:

**`api/[[...route]].ts`** — one-line catch-all route:

```typescript
export { GET, POST } from 'pg-history/vercel'
```

**`vercel.json`** — cron schedule:

```json
{
  "crons": [
    {
      "path": "/api/archive",
      "schedule": "0 */6 * * *"
    }
  ]
}
```

**Environment variables** (set in Vercel dashboard):

```
PG_HISTORY_DATABASE_URL=postgres://...
PG_HISTORY_TABLES=users,orders
PG_HISTORY_JWT_SECRET=your-secret
CRON_SECRET=your-cron-secret
PG_HISTORY_S3_BUCKET=audit-archives
PG_HISTORY_S3_ENDPOINT=https://...
PG_HISTORY_S3_ACCESS_KEY_ID=...
PG_HISTORY_S3_SECRET_ACCESS_KEY=...
```

How it works:
1. Vercel Cron calls `POST /api/archive` every 6 hours
2. Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` — the endpoint verifies it
3. The archiver runs: archive old records to S3 as Parquet, soft delete, hard delete
4. The response includes archival stats; `/health` reflects the archival status

**Vercel plan limits:**
- **Hobby:** Cron minimum interval 24h, function timeout 10s
- **Pro:** Cron minimum interval 1h, function timeout 60s

If archival takes longer than the function timeout, it will be interrupted. The design is retry-safe — unfinished records stay unarchived and get picked up on the next run. Set `PG_HISTORY_BATCH_SIZE` to a lower value (1000-2000) to keep individual runs within timeout limits.

### Serverless Considerations

| Concern | Impact | Mitigation |
|---------|--------|------------|
| Connection pooling | Each invocation may create a pool | Use an external pooler (PgBouncer, Neon, Supabase, RDS Proxy). Set `PG_HISTORY_POOL_MAX` low (2-3). |
| No background process | Archival doesn't run automatically | Use cron triggers (`POST /api/archive`) via Vercel Cron, AWS EventBridge, etc. |
| Cold starts | `setup()` runs ~10 idempotent DDL queries | ~5ms overhead. Cache the setup promise at module level. |
| Rate limiting | In-memory rate limiter resets per invocation | Use platform-level rate limiting (API Gateway, Vercel Firewall, Cloudflare). |

### Other Platforms

The Hono app returned by `createServer()` works with any platform Hono supports:

```typescript
// AWS Lambda
import { handle } from 'hono/aws-lambda'
const app = await createServer({ pool, serverless: true, ... })
export const handler = handle(app)

// Cloudflare Workers
const app = await createServer({ pool, serverless: true, ... })
export default app
```

## Archiver

Three layers: `Orchestrator` (table discovery, advisory locking) -> `PgHistoryArchiver` (S3 upload, delete lifecycle) -> `parquet.ts` (Snappy-compressed Parquet).

### Lifecycle

```
Day 0:   Record created
Day 90:  Retention cutoff -> upload to S3 as Parquet -> mark archived_at
Day 90:  Soft delete (records with confirmed S3 backup)
Day 97:  Hard delete (after verifying S3 file exists)
```

S3 path: `{table}/year={YYYY}/month={MM}/day={DD}/data-{uuid}.parquet`

Advisory locks (`pg_try_advisory_lock`) prevent concurrent processing of the same table.

### Configuration

```typescript
const app = await createServer({
  pool,
  enableArchiver: true,
  archiverConfig: {
    s3: {
      bucket: 'audit-archives',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-west-2',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    retention: {
      default: 90,
      tables: { logs: 7, sessions: 30 },
    },
    gracePeriod: 7,
    batchSize: 10000,
  },
  runOptions: { dryRun: false },
})
```

### Direct Usage

```typescript
import { Orchestrator } from 'pg-history'

const orchestrator = new Orchestrator(
  { bucket: 'my-bucket', region: 'us-west-2' },
  { default: 90, tables: { logs: 7 } },
  7,     // grace period days
  10000, // batch size
)

const stats = await orchestrator.run(pool, { dryRun: true })
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PG_HISTORY_DATABASE_URL` | Standalone server | PostgreSQL connection string |
| `PG_HISTORY_PORT` | No | Server port (also reads `PORT`, default `3001`) |
| `PG_HISTORY_POOL_MAX` | No | Max pool connections (default `5`, use `2-3` for serverless) |
| `PG_HISTORY_JWT_SECRET` | No | JWT auth on `/api/*` |
| `PG_HISTORY_TABLES` | Vercel entry point | Comma-separated table names |
| `PG_HISTORY_S3_ENDPOINT` | Archival | S3 endpoint |
| `PG_HISTORY_S3_ACCESS_KEY_ID` | Archival | S3 access key |
| `PG_HISTORY_S3_SECRET_ACCESS_KEY` | Archival | S3 secret key |
| `PG_HISTORY_S3_REGION` | Archival | S3 region (default `us-east-1`) |
| `PG_HISTORY_S3_BUCKET` | Archival | S3 bucket |
| `PG_HISTORY_ARCHIVAL_INTERVAL_MS` | No | Background archival interval (default `3600000` / 1 hour) |
| `PG_HISTORY_RETENTION_DAYS` | No | Default retention period (default `90`) |
| `PG_HISTORY_GRACE_PERIOD_DAYS` | No | Grace period before hard delete (default `7`) |
| `PG_HISTORY_BATCH_SIZE` | No | Archival batch size (default `10000`) |
| `CRON_SECRET` | Vercel cron | Protects `POST /api/archive` endpoint |

## Error Handling

pg-history exports typed error classes for programmatic error handling:

```typescript
import {
  PgHistoryError,          // Base class for all pg-history errors
  TableNotConfiguredError,  // Table not in configured tables list
  SetupRequiredError,       // setup() not called before query
  AuditEntryNotFoundError,  // Audit entry not found for revert
  ValidationError,          // Input validation failure
  RevertError,              // Revert operation failure
} from 'pg-history'

try {
  await history.getHistory('unknown_table', '1')
} catch (error) {
  if (error instanceof TableNotConfiguredError) {
    // handle specifically
  }
}
```

## Testing

Tests run against real PostgreSQL and MinIO. Each test file gets a fresh database.

```bash
docker compose up -d
cp .env.template .env
bun test
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun test` | Run tests |
| `bun test --watch` | Watch mode |
| `bun test --coverage` | Coverage |
| `bun run dev` | Start server |
| `bun run build` | Build (ESM + CJS) |
| `bun run lint` | Biome check |
| `bun run lint:fix` | Biome auto-fix |
| `bun run tsc` | Type check |
| `bun run check` | Lint + tsc + test |

## Limitations

- **TRUNCATE not audited.** Use `DELETE` if audit trail needed.
- **DDL not audited.** `ALTER TABLE`, `DROP TABLE`, etc.
- **Revert requires a primary key.**
- **PK changes require re-setup.** Call `teardown()` then `setup()`.
- **Column changes are fine.** JSONB adapts automatically.
- **Text search (ILIKE) is slow on large tables.** Use JSON containment queries (`{"key": "value"}`) for indexed search. Text search has a 5-second timeout.

## License

MIT
