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
- [Production Caveats](#production-caveats)
- [Error Handling](#error-handling)
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

**Skip auditing secrets/PII** by listing the columns to strip per table:

```typescript
new PgHistory({
  pool,
  tables: ['users'],
  excludeColumns: { users: ['password_hash', 'mfa_secret'] },
})
```

**Inject a structured logger** to route library events (`Archival complete`, `Batch failed`, etc.) into your aggregator:

```typescript
import pino from 'pino'
new PgHistory({ pool, tables: ['users'], logger: pino() })
```

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

One partitioned `audit_log` table — partitioned by `LIST (table_name)` so queries against one table don't scan others. You can query it directly if you want, but the typed `getHistory` / `search` API is recommended.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `BIGSERIAL` | Audit entry ID — use as cursor |
| `table_name` | `TEXT` | Source table |
| `record_id` | `TEXT` | PK value(s) of the affected row |
| `operation` | `TEXT` | `INSERT` / `UPDATE` / `DELETE` |
| `changed_at` | `TIMESTAMPTZ` | Transaction timestamp |
| `old_data` | `JSONB` | Previous row state (excluded columns omitted) |
| `new_data` | `JSONB` | New row state (excluded columns omitted) |

When the archiver is enabled, additional columns track lifecycle: `archived_at`, `s3_path`, `soft_deleted_at`. Treat these as internal — `getHistory` and `search` filter on them automatically (soft-deleted rows hidden, archived rows still visible until hard-deleted).

### Primary Key Handling

`record_id` is derived from the source table's PK:

| PK Type | `record_id` |
|---------|-------------|
| Single column | PK value cast to text |
| Composite | Each part capped at 200 chars and joined with `chr(31)` (ASCII unit separator) |
| None | `md5(row_to_json(...)::text)` — but note the value changes on every UPDATE, so `getHistory` cannot correlate INSERT with later UPDATEs. Use tables with a PK if you want full history. |

## API Reference

### `PgHistory`

#### Constructor

```typescript
const history = new PgHistory({
  tables: ['users', 'orders'],
  pool: existingPool,                      // or connection: 'postgres://...'
  excludeColumns: {                         // optional — strip PII per table
    users: ['password_hash', 'ssn'],
  },
  logger: pino(),                           // optional — defaults to consoleLogger
})
```

- `pool` or `connection` — one is required. `connection` creates an internal Pool that `close()` ends; `pool` is borrowed and `close()` doesn't end it.
- `excludeColumns` — per-table column allowlist subtraction. Trigger emits `(to_jsonb(NEW) - 'col1' - 'col2')`. PK columns rejected at setup (would break `revert()`).
- `logger` — anything implementing the `Logger` interface (`debug`/`info`/`warn`/`error`). `silentLogger` available for tests.

#### `setup(): Promise<void>`

Creates `audit_log` table, partitions, indexes, and triggers. Idempotent — safe to call on every app startup. Concurrent calls dedup on a shared promise.

**Required before** `getHistory()`, `search()`, or `revert()`. These methods throw `SetupRequiredError` if setup hasn't completed.

#### `getHistory(tableName, recordId, options?): Promise<PaginatedResult<AuditEntry>>`

Options: `limit` (default 50, max 1000), `cursor` (opaque ID), `order` (`'asc'` | `'desc'`, default `'desc'`).

Excludes soft-deleted entries when the archiver schema is present.

#### `search(options): Promise<SearchPaginatedResult<AuditEntry>>`

Options: `tables` (required), `query`, `operation` (`'INSERT'` / `'UPDATE'` / `'DELETE'`), `dateFrom`, `dateTo`, `limit` (default 100, max 1000), `cursor` (typed `SearchCursor`).

If `query` looks like JSON (`{...}`), uses `@>` containment (GIN-indexed) with a 30s timeout. Otherwise falls back to `ILIKE` text search with a 5s timeout. Both timeouts use `SET LOCAL statement_timeout` so the pooled connection returns clean.

Returned `nextCursor` is branded `SearchCursor` — only pass it back to `search()`, not `getHistory()` (different sort direction).

#### `revert(tableName, recordId, auditEntryId): Promise<void>`

Restores a record to the state in the given audit entry. Runs in a single transaction. Requires a primary key.

| Original Op | Revert Action |
|-------------|---------------|
| `INSERT` | Deletes the row |
| `DELETE` | Re-inserts from `old_data` (unique/FK violations surface as `RevertError`) |
| `UPDATE` | Restores `old_data` values via PK |

Cross-checks audit columns against current schema; rejects revert if columns drifted. `GENERATED ALWAYS` columns are excluded from the INSERT. Setting `suppressAuditTriggers: true` requires `pg_replication` role or superuser.

#### `invalidatePrimaryKeyCache(tableName?): void`

Clears the cached PK lookup for `tableName` (or all tables if omitted). Call after `ALTER TABLE ... ADD/DROP CONSTRAINT` that changes the primary key.

#### `invalidateSoftDeleteColumnCache(): void`

Clears the cached `soft_deleted_at` column existence check. Call after running the archiver schema setup on a database where PgHistory was already configured.

#### `teardown(): Promise<void>`

Drops triggers, functions, and `audit_log`. Idempotent.

#### `close(timeoutMs?): Promise<void>`

Ends internal Pool if one was created. Races `pool.end()` against `timeoutMs` (default 30s) so SIGTERM can't be blocked by hung clients.

### `PgHistoryArchiver`

Low-level archiver — most callers should use `Orchestrator.run()` instead. Direct API for custom schedulers or one-off cleanup jobs.

```typescript
const archiver = new PgHistoryArchiver({
  pool,
  s3: { bucket, endpoint, region, accessKeyId, secretAccessKey },
  retention: { default: 90 },
  gracePeriod: 7,
  batchSize: 10000,
  maxBatchBytes: 256 * 1024 * 1024,   // optional soft memory cap
  staleClaimMinutes: 30,               // optional reaper threshold
  logger,                              // optional
})
await archiver.setup()                 // idempotent — adds claim/archive columns
```

| Method | Purpose |
|--------|---------|
| `processBatch(table, cutoffDate)` | Claim → upload → finalize one day-bounded batch. Returns `{recordCount, fileSize, s3Path, status}`. |
| `softDeleteArchived(table)` | Set `soft_deleted_at` on rows past grace period with confirmed S3 backup. |
| `hardDeletePurged(table)` | Re-verify S3 inside TX, then DELETE rows past second grace period. |
| `reapStaleClaims(minutes?)` | Release claims older than `staleClaimMinutes` (worker-crash recovery). |
| `cleanupOrphanedFiles(table, {maxDeletions=10000})` | Delete S3 files not referenced in `audit_archive_metadata`. |
| `pruneArchive(table, olderThan)` | Paired DELETE of metadata + S3 for archives past compliance retention. |
| `close(timeoutMs?)` | End internal Pool with timeout. |

### `Orchestrator`

```typescript
const orch = new Orchestrator({
  s3, retention, gracePeriod,
  batchSize: 10000,                    // optional, default 10000
  lockConnectionString: 'postgres://...', // optional — bypass pooler
  logger,
})
const stats = await orch.run(pool, { dryRun: false, targetTable: 'users' })
```

`run()` discovers audited tables (or processes `targetTable`), takes a 64-bit advisory lock per table, reaps stale claims, then loops `processBatch → softDelete → hardDelete`. Stats per table aggregated into `OrchestratorStats`.

### `createServer`

```typescript
const { app, dispose } = await createServer({
  pool, port, logger, baseUrl, publicOpenApi, serverless,
  cors: { origin: 'https://...', credentials: true },
  enableHistory: true, historyConfig: { tables: [...] },
  enableArchiver: true, archiverConfig: { /* see Archiver */ },
  archiveCronSecret: '...',            // or CRON_SECRET env
  archivalRetry: { maxAttempts: 4, delays: [5_000, 15_000, 60_000] },
  runOptions: { dryRun: false, targetTable: 'users' },
})
```

`dispose(drainTimeoutMs=15_000)` cancels intervals, drains in-flight requests, aborts pending retry sleeps, and awaits any running archival.

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

// Branded type — search() cursors are NOT interchangeable with getHistory() cursors
type SearchCursor = string & { readonly __brand: unique symbol }

interface OrchestratorStats {
  tables: string[]
  totalRecordsArchived: number
  totalRecordsSoftDeleted: number
  totalRecordsHardDeleted: number
  errors: Array<{ table: string; operation: string; error: string }>
  durationMs: number
}
```

All types exported from `pg-history` root: `ArchiverConfig`, `AuditEntry`, `GetHistoryOptions`, `OrchestratorConfig`, `OrchestratorStats`, `PaginatedResult`, `PgHistoryConfig`, `RetentionConfig`, `RunOptions`, `S3Config`, `SearchCursor`, `SearchOptions`, `SearchPaginatedResult`, `ServerConfig`.

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
| `GET` | `/health` | No | Minimal liveness probe (`{status}` only) |
| `GET` | `/api/health/detailed` | JWT or cron | Archival status + attempts + last completion |
| `GET` | `/openapi` | JWT (unless `publicOpenApi: true`) | OpenAPI spec |
| `GET` | `/api/stats` | JWT or cron | Archival stats (requires `enableArchiver`) |
| `GET` | `/api/history/:table/:recordId` | JWT | Record history |
| `POST` | `/api/history/search` | JWT | Search history |
| `POST` | `/api/history/revert` | JWT | Revert a record |
| `POST` | `/api/archive` | JWT or cron secret | Trigger archival on demand |

**Auth resolution:**
- Set `PG_HISTORY_JWT_SECRET` to enable JWT on `/api/*`. Algorithm via `PG_HISTORY_JWT_ALG` (default `HS256`; supports `HS256/384/512`, `RS256/384/512`, `ES256/384/512`).
- Set `archiveCronSecret` (or `CRON_SECRET` env) to authenticate `/api/archive`, `/api/stats`, and `/api/health/detailed` via timing-safe HMAC. In cron-only deployments (no JWT), these endpoints still require the bearer secret.
- `/health` and `/openapi` (when `publicOpenApi: true`) are public.
- `OPTIONS` preflight bypasses JWT so CORS works.

### Health Check

`GET /health` returns the minimal liveness shape so operational details aren't leaked to anonymous callers:

```json
{ "status": "ok" }
```

`status` flips to `"degraded"` when the archiver has failed.

`GET /api/health/detailed` (auth-gated) exposes operational state:

```json
{
  "status": "ok",
  "archival": {
    "status": "completed",
    "attempts": 0,
    "lastCompletedAt": "2026-03-17T...",
    "lastError": null
  }
}
```

`attempts` resets to `0` on each successful run — it represents retries since last success, not lifetime count. `lastError` is the most recent failure message (null on success).

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

Move old audit rows to S3 as compressed Parquet files. Hands off to `Orchestrator` for scheduling and `PgHistoryArchiver` for the upload + delete lifecycle. Concurrent runs are safe — advisory locks prevent two archivers from processing the same table.

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
  // Optional: cap batch memory by serialized payload size (default 256 MiB).
  // Rows past the cap are released back to the claim pool for the next run.
  // maxBatchBytes: 256 * 1024 * 1024,
  runOptions: { dryRun: false },
  // Optional retry policy for background archival. Defaults shown.
  archivalRetry: {
    maxAttempts: 4,
    delays: [5_000, 15_000, 60_000], // length must be maxAttempts - 1
  },
  // Optional CORS — omit to disable entirely (server-to-server default)
  cors: { origin: 'https://app.example.com', credentials: true },
})
```

### Excluding columns from audit (PII)

`to_jsonb(NEW)` captures the full row. Strip secrets/PII per-table:

```typescript
new PgHistory({
  tables: ['users', 'orders'],
  excludeColumns: {
    users: ['password_hash', 'mfa_secret', 'ssn'],
  },
  pool,
})
```

Trigger generates `(to_jsonb(NEW) - 'password_hash' - 'mfa_secret' - 'ssn')`. PK columns cannot be excluded (would break `revert()`).

### Pruning long-term archives

Metadata + S3 grow linearly forever. Schedule periodic pruning of archives past compliance retention:

```typescript
import { PgHistoryArchiver } from 'pg-history'

const archiver = new PgHistoryArchiver({ pool, ...config })
const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) // 1 year
const deleted = await archiver.pruneArchive('users', cutoff)
```

Removes both the S3 object and its `audit_archive_metadata` row in lockstep.

### Cleaning up orphan S3 files

Run periodically to delete S3 files left behind by crashed archival workers:

```typescript
const orphans = await archiver.cleanupOrphanedFiles('users', { maxDeletions: 10000 })
```

Bounded per-call so a bucket with millions of orphans doesn't tie up one DB connection for hours. Idempotent — resume on next invocation.

### Direct Usage

```typescript
import { Orchestrator } from 'pg-history'

const orchestrator = new Orchestrator({
  s3: { bucket: 'my-bucket', region: 'us-west-2' },
  retention: { default: 90, tables: { logs: 7 } },
  gracePeriod: 7,
  // batchSize: 10000, // optional
})

const stats = await orchestrator.run(pool, { dryRun: true })
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PG_HISTORY_DATABASE_URL` | Standalone server | PostgreSQL connection string |
| `PG_HISTORY_PORT` | No | Server port (also reads `PORT`, default `3001`) |
| `PG_HISTORY_POOL_MAX` | No | Max pool connections (default `5`, use `2-3` for serverless) |
| `PG_HISTORY_JWT_SECRET` | No | JWT auth on `/api/*` |
| `PG_HISTORY_JWT_ALG` | No | JWT algorithm: `HS256/384/512`, `RS256/384/512`, `ES256/384/512` (default `HS256`) |
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

## Production Caveats

Operational notes for running this in earnest. None are bugs — they are knobs and trade-offs you need to know about.

### Connection pooler compatibility

- The main pool can run behind **PgBouncer transaction mode** — every archival query uses `SET LOCAL statement_timeout` inside a short transaction.
- The `Orchestrator` advisory-lock client is a **standalone `pg.Client`**, not borrowed from the pool. Session-level advisory locks require a stable connection — pass `lockConnectionString` in `OrchestratorConfig` to point it directly at PostgreSQL (bypass the pooler) or use a pooler in session mode for that one connection.

### Rate limiting

Built-in `/api/*` rate limiter is **per-process in-memory**. It trusts the first IP in `x-forwarded-for`, which is client-spoofable behind an untrusted proxy. For production: terminate rate limiting at your API gateway (Cloudflare, AWS API Gateway, etc.) and run with `serverless: true` to skip the in-process limiter.

### `audit_archive_metadata` and S3 growth

INSERT-only by design. After hard-delete, audit_log rows are gone but the S3 file + metadata row stay for compliance. Schedule `archiver.pruneArchive(table, olderThan)` weekly/monthly to bound long-term storage. `cleanupOrphanedFiles` only removes S3 files not in metadata — not the metadata itself.

### `hardDeletePurged` lock window

The final-delete transaction re-verifies up to 500 S3 paths per call before issuing `DELETE` (capped to bound lock duration; remaining rows roll into the next call). On a hot path this transaction can hold row locks for a few seconds. Run hard-delete on its own schedule, not in the same loop as `processBatch`, if you have heavy concurrent writes.

### Memory under wide rows

`maxBatchBytes` (default 256 MiB) is a **soft cap based on serialized JSON length**. The estimate is approximate — PG's on-wire JSONB binary differs from JS's serialization. If you audit columns with multi-MB jsonb, set `maxBatchBytes` to 30-50% of available RSS. Excluded columns (`excludeColumns`) reduce the per-row payload at source.

### Trigger ownership (SECURITY DEFINER)

Generated trigger functions run with the privileges of their **owner** — whoever ran `setup()`. If that role is superuser, audit inserts run with superuser privilege. For least-privilege deployments, create a dedicated `pg_history_writer` role with INSERT on `audit_log` and either run `setup()` as that role, or post-setup do `ALTER FUNCTION audit_trigger_func_<table>() OWNER TO pg_history_writer`.

### Metrics & observability

No metrics emitted natively. Wire your monitor of choice via the injected `Logger`:

```typescript
import pino from 'pino'
const logger = pino()
new PgHistory({ pool, tables, logger })
new PgHistoryArchiver({ pool, ...config, logger })
```

Then aggregate by event name (`Archival complete`, `Batch failed`, `Pool idle client error`, etc.).

### Schema-drift on archive replay

`revert()` cross-checks audit columns against current table schema and refuses to write to columns the table no longer has. After heavy schema migrations, run a representative `revert()` in staging to confirm restorability.

### Cold-start cost

`setup()` is idempotent. On a cold-started serverless instance where the schema already exists, it short-circuits after a single catalog probe (~5ms) instead of running every DDL statement. Safe to call on every invocation; no need to gate it yourself.

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

## Limitations

- **TRUNCATE not audited.** Use `DELETE` if audit trail needed.
- **DDL not audited.** `ALTER TABLE`, `DROP TABLE`, etc.
- **Revert requires a primary key.**
- **PK changes require re-setup.** Call `teardown()` then `setup()`.
- **Column changes are fine.** JSONB adapts automatically.
- **Text search (ILIKE) is slow on large tables.** Use JSON containment queries (`{"key": "value"}`) for indexed search. Text search has a 5-second timeout.

## License

MIT
