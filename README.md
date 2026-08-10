# pg-history

PostgreSQL audit trails with automated S3 archival.

[![npm version](https://img.shields.io/npm/v/pg-history.svg)](https://www.npmjs.com/package/pg-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FTimMikeladze%2Fpg-history%2Ftree%2Fmain%2Fdashboard&project-name=pg-history-dashboard&repository-name=pg-history-dashboard&env=PG_HISTORY_DATABASE_URL%2CPG_HISTORY_TABLES%2CPG_HISTORY_JWT_SECRET%2CPG_HISTORY_DASHBOARD_PASSWORD%2CPG_HISTORY_JWT_ALG%2CPG_HISTORY_POOL_MAX%2CPG_HISTORY_STATEMENT_TIMEOUT_MS%2CPG_HISTORY_DASHBOARD_ACTOR%2CPG_HISTORY_RETENTION_DAYS%2CPG_HISTORY_GRACE_PERIOD_DAYS%2CPG_HISTORY_BATCH_SIZE&envDefaults=%7B%22PG_HISTORY_JWT_ALG%22%3A%22HS256%22%2C%22PG_HISTORY_POOL_MAX%22%3A%223%22%2C%22PG_HISTORY_STATEMENT_TIMEOUT_MS%22%3A%2230000%22%2C%22PG_HISTORY_DASHBOARD_ACTOR%22%3A%22dashboard%22%2C%22PG_HISTORY_RETENTION_DAYS%22%3A%2290%22%2C%22PG_HISTORY_GRACE_PERIOD_DAYS%22%3A%227%22%2C%22PG_HISTORY_BATCH_SIZE%22%3A%2210000%22%7D&envDescription=Only+the+first+four+need+a+value%3A+a+Postgres+connection+string%2C+the+tables+to+audit%2C+a+JWT+signing+secret%2C+and+a+password+for+the+dashboard+UI+%28it+can+read+and+revert+every+audited+record%29.+The+rest+arrive+prefilled+with+the+library+defaults.&envLink=https%3A%2F%2Fgithub.com%2FTimMikeladze%2Fpg-history%23environment-variables)

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Examples](#examples)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Server & REST API](#server--rest-api)
- [Dashboard](#dashboard)
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

// Revert to a previous state — reverting an UPDATE entry restores its `oldData`
await history.revert('users', '1', result.data[1].id) // whole row back to that entry's oldData
// (reverting the INSERT entry would DELETE the row instead — see the revert table below)

await history.close()   // ends only a pool pg-history created itself
await pool.end()        // your pool stays yours to close
```

**Skip auditing secrets/PII** by listing the columns to strip per table (an update that touches only an excluded column still records an entry — with identical `oldData` and `newData` — so the trail shows *that* a secret changed and when, never what it changed to):

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

### Deploy in one click

Nothing above needs a server — the triggers live in PostgreSQL. This deploys the parts that do: the REST API, the dashboard and cron archival, as one Vercel project. Full details in [Deployment](#deployment).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FTimMikeladze%2Fpg-history%2Ftree%2Fmain%2Fdashboard&project-name=pg-history-dashboard&repository-name=pg-history-dashboard&env=PG_HISTORY_DATABASE_URL%2CPG_HISTORY_TABLES%2CPG_HISTORY_JWT_SECRET%2CPG_HISTORY_DASHBOARD_PASSWORD%2CPG_HISTORY_JWT_ALG%2CPG_HISTORY_POOL_MAX%2CPG_HISTORY_STATEMENT_TIMEOUT_MS%2CPG_HISTORY_DASHBOARD_ACTOR%2CPG_HISTORY_RETENTION_DAYS%2CPG_HISTORY_GRACE_PERIOD_DAYS%2CPG_HISTORY_BATCH_SIZE&envDefaults=%7B%22PG_HISTORY_JWT_ALG%22%3A%22HS256%22%2C%22PG_HISTORY_POOL_MAX%22%3A%223%22%2C%22PG_HISTORY_STATEMENT_TIMEOUT_MS%22%3A%2230000%22%2C%22PG_HISTORY_DASHBOARD_ACTOR%22%3A%22dashboard%22%2C%22PG_HISTORY_RETENTION_DAYS%22%3A%2290%22%2C%22PG_HISTORY_GRACE_PERIOD_DAYS%22%3A%227%22%2C%22PG_HISTORY_BATCH_SIZE%22%3A%2210000%22%7D&envDescription=Only+the+first+four+need+a+value%3A+a+Postgres+connection+string%2C+the+tables+to+audit%2C+a+JWT+signing+secret%2C+and+a+password+for+the+dashboard+UI+%28it+can+read+and+revert+every+audited+record%29.+The+rest+arrive+prefilled+with+the+library+defaults.&envLink=https%3A%2F%2Fgithub.com%2FTimMikeladze%2Fpg-history%23environment-variables)

The button clones [`dashboard/`](./dashboard) — the UI *and* the REST API it is built on, mounted at `/api`. Eleven environment variables come up in the clone form and seven are already filled in; only `PG_HISTORY_DATABASE_URL`, `PG_HISTORY_TABLES`, `PG_HISTORY_JWT_SECRET` and `PG_HISTORY_DASHBOARD_PASSWORD` need you.

## Installation

```bash
bun add pg-history
```

`pg`, `hono`, and the S3/Parquet libraries ship as regular dependencies — nothing else to install.

Requires PostgreSQL 12+, Node.js 18+ or Bun. The optional `appendOnly` guard needs PostgreSQL 14+.

## Examples

Working examples in [`examples/`](./examples). Each creates a temporary database, runs against real PostgreSQL, and cleans up after itself.

```bash
docker compose up -d
bun examples/basic-audit-trail.ts
```

Examples assert their own output, so they exit non-zero if the behavior they document ever changes. `bun test` runs all of them (see [`test/examples.test.ts`](./test/examples.test.ts)); the archival examples are skipped when MinIO isn't reachable.

| Example | What it shows |
|---------|---------------|
| [basic-audit-trail.ts](./examples/basic-audit-trail.ts) | Setup, INSERT/UPDATE/DELETE tracking, history retrieval |
| [search-and-revert.ts](./examples/search-and-revert.ts) | JSONB containment search, text search, filtering, revert |
| [multi-table-tracking.ts](./examples/multi-table-tracking.ts) | Multiple related tables, composite primary keys, cross-table search |
| [rest-api-server.ts](./examples/rest-api-server.ts) | Hono REST API server with history endpoints |
| [cron-archival.ts](./examples/cron-archival.ts) | POST /api/archive endpoint, cron secret auth, health status |
| [archival-lifecycle.ts](./examples/archival-lifecycle.ts) | Full S3 archival pipeline: archive, soft delete, hard delete |
| [error-handling.ts](./examples/error-handling.ts) | Typed error classes, catching specific errors |
| [next/](./examples/next) | Files to copy into a Next.js app: catch-all route handler, `vercel.json` cron, plus `test-locally.ts` that exercises the serverless setup against Docker |

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

For tables that accumulate millions of audit records, the archiver moves old data to S3 as compressed Parquet files, then deletes it in stages. No row is deleted without a verified backup. See [Archiver](#archiver).

## Architecture

### audit_log Schema

One partitioned `audit_log` table — partitioned by `LIST (table_name)` so queries against one table don't scan others. You can query it directly if you want, but the typed `getHistory` / `search` API is recommended.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `BIGSERIAL` | Audit entry ID — use as cursor |
| `table_name` | `TEXT` | Source table |
| `record_id` | `TEXT` | PK value(s) of the affected row |
| `operation` | `TEXT` | `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` |
| `changed_at` | `TIMESTAMPTZ` | Transaction timestamp |
| `old_data` | `JSONB` | Previous row state (excluded columns omitted) |
| `new_data` | `JSONB` | New row state (excluded columns omitted) |
| `db_user` | `TEXT` | DB role that made the change (`current_user`) |
| `app_actor` | `TEXT` | Application actor (from the `pg_history.actor` session setting), or `NULL` |
| `client_addr` | `INET` | Client network address (`inet_client_addr()`), or `NULL` |

**Capturing the application user:** every audit row records `db_user` and `client_addr` automatically. To also record *your* end-user, set a session-local variable before the write and the trigger stores it in `app_actor`:

```sql
SET LOCAL pg_history.actor = 'user-42';   -- same transaction as the DML
```

When the archiver is enabled, additional columns track lifecycle: `archived_at`, `s3_path`, `soft_deleted_at`, `claim_id`, `claimed_at`. Treat these as internal — `getHistory` and `search` filter on them automatically (soft-deleted rows hidden, archived rows still visible until hard-deleted).

### Primary Key Handling

`record_id` is derived from the source table's PK:

| PK Type | `record_id` |
|---------|-------------|
| Single column | PK value cast to text |
| Composite | Each part joined with `chr(31)` (ASCII unit separator), full value — not truncated, so distinct keys can't collide. Build the same string client-side to look it up: `` `${customerId}\x1f${tag}` `` (see [multi-table-tracking.ts](./examples/multi-table-tracking.ts)) |
| None | `md5(row_to_json(...)::text)` — the value changes on every UPDATE, so `getHistory` cannot correlate INSERT with later UPDATEs. A warning is logged at setup; pass `requirePrimaryKey: true` to reject PK-less tables outright. Use tables with a PK for full history. |

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
  maxConcurrentSearches: 4,                 // optional — cap concurrent search() (default 4, 0 = off)
  appendOnly: false,                        // optional — install append-only guard trigger
  requirePrimaryKey: false,                 // optional — reject tables without a PK
})
```

- `pool` or `connection` — one is required. `connection` creates an internal Pool that `close()` ends; `pool` is borrowed and `close()` doesn't end it.
- `excludeColumns` — per-table column allowlist subtraction. Trigger emits `(to_jsonb(NEW) - 'col1' - 'col2')`. PK columns rejected at setup (would break `revert()`).
- `logger` — anything implementing the `Logger` interface (`debug`/`info`/`warn`/`error`). `silentLogger` available for tests.
- `maxConcurrentSearches` — bounds concurrent `search()` queries so unindexed `ILIKE` scans can't exhaust the pool. Excess searches reject with `SearchConcurrencyLimitError` (HTTP 429 via the server). Default 4; set `0` to disable.
- `appendOnly` — when `true`, `setup()` installs a `BEFORE UPDATE OR DELETE` guard trigger on `audit_log` that blocks mutations unless the session set `pg_history.maintenance = 'on'` (the archiver does this automatically). Makes the trail append-only for the application. Tamper-*resistance*, not cryptographic tamper-evidence — see [Production Caveats](#trigger-ownership-security-definer). Requires PostgreSQL 14+. Default `false`.
- `requirePrimaryKey` — when `true`, `setup()` throws for a table with no primary key instead of logging a warning. Default `false`.

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

#### `revert(tableName, recordId, auditEntryId, options?): Promise<void>`

Restores a record to the state in the given audit entry. Runs in a single transaction. Requires a primary key.

| Original Op | Revert Action |
|-------------|---------------|
| `INSERT` | Deletes the row |
| `DELETE` | Re-inserts from `old_data` (unique/FK violations surface as `RevertError`) |
| `UPDATE` | Restores `old_data` values via PK |

Cross-checks audit columns against current schema; rejects revert if columns drifted. `GENERATED ALWAYS` columns are excluded from the INSERT.

**Reverts are audited by default** (`suppressAuditTriggers: false`) — the revert's own write fires the audit trigger, so the trail records that the data was changed back (no silent repudiation) and no special DB privilege is needed. Pass `{ suppressAuditTriggers: true }` to skip re-auditing (avoids "revert of revert" chains); that path uses `session_replication_role = 'replica'` and requires the `pg_replication` role or superuser. Over the REST API, send `"suppressAuditTriggers": true` in the request body.

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
  maxBatchBytes: 64 * 1024 * 1024,    // optional soft memory cap (default 64 MiB)
  staleClaimMinutes: 30,               // optional reaper threshold
  logger,                              // optional
})
await archiver.setup()                 // idempotent — adds claim/archive columns
```

| Method | Purpose |
|--------|---------|
| `processBatch(table, cutoffDate)` | Claim → upload → finalize one day-bounded batch. Returns `{recordCount, fileSize, s3Path, status}`. |
| `softDeleteArchived(table)` | Set `soft_deleted_at` on rows past grace period with confirmed S3 backup. |
| `hardDeletePurged(table)` | Verify S3 existence + checksum, then DELETE rows past second grace period inside a locked TX (no network I/O under lock). |
| `reapStaleClaims(minutes?)` | Release claims older than `staleClaimMinutes` (worker-crash recovery). |
| `listArchives(table, {from?, to?, limit?})` | The archive index: `{s3Path, archiveDate, recordCount, fileSize, checksumSha256, archivedAt}` per file, newest first. |
| `readArchive(s3Path, {verifyChecksum?})` | Fetch and decode one archived Parquet file back into audit rows. Verifies the recorded SHA-256 by default. |
| `cleanupOrphanedFiles(table, {maxDeletions=10000, minAgeMinutes?})` | Delete S3 files not referenced in `audit_archive_metadata`. |
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
  // Auth — see "Server & REST API"
  allowUnauthenticated: false,          // required opt-in to serve history without a JWT
  trustProxy: false,                    // trust x-forwarded-for for rate limiting (proxy only)
  authorize: async ({ actor, table, recordId, action }) => {
    // return false or throw to deny with 403
    return true
  },
})
```

`dispose(drainTimeoutMs=15_000)` cancels intervals, drains in-flight requests, aborts pending retry sleeps, and awaits any running archival.

Auth is fail-closed and `authorize` is what gives you per-tenant scoping — see [Auth resolution](#endpoints).

### Types

```typescript
interface AuditEntry {
  id: string
  tableName: string
  recordId: string
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
  changedAt: Date
  oldData: Record<string, unknown> | null
  newData: Record<string, unknown> | null
  dbUser: string | null      // DB role that made the change
  appActor: string | null    // pg_history.actor session value, if set
  clientAddr: string | null  // client IP, or null for local connections
}

interface PaginatedResult<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

// Branded type — search() cursors are NOT interchangeable with getHistory() cursors
declare const _searchCursorBrand: unique symbol
type SearchCursor = string & { readonly [_searchCursorBrand]: true }

interface OrchestratorStats {
  tables: string[]
  totalRecordsArchived: number
  totalRecordsSoftDeleted: number
  totalRecordsHardDeleted: number
  errors: Array<{ table: string; operation: string; error: string }>
  durationMs: number
}
```

All types exported from `pg-history` root: `ArchiverConfig`, `AuditEntry`, `AuthorizeContext`, `AuthorizeFn`, `GetHistoryOptions`, `OrchestratorConfig`, `OrchestratorStats`, `PaginatedResult`, `PgHistoryConfig`, `RetentionConfig`, `RunOptions`, `S3Config`, `SearchCursor`, `SearchOptions`, `SearchPaginatedResult`, `ServerConfig`.

## Server & REST API

A ready-made Hono server exposing the audit trail over HTTP, with JWT or cron-secret auth on every endpoint that reads data.

```typescript
import { Pool } from 'pg'
import { createServer } from 'pg-history'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const { app } = await createServer({
  pool,
  port: 3001,
  enableHistory: true,
  historyConfig: { tables: ['users', 'orders'] },
  enableArchiver: true,
  archiverConfig: { /* see Archiver section */ },
  allowUnauthenticated: !process.env.PG_HISTORY_JWT_SECRET,  // dev only
})

Bun.serve({ port: 3001, fetch: app.fetch })
```

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Minimal liveness probe (`{status}` only) |
| `GET` | `/api/health/detailed` | JWT or cron | Archival status + attempts + last completion (requires `enableArchiver`) |
| `GET` | `/openapi` | JWT (unless `publicOpenApi: true`); not registered unless one of JWT / `publicOpenApi` / `allowUnauthenticated` is configured | OpenAPI spec |
| `GET` | `/api/stats` | JWT or cron | Archival stats (requires `enableArchiver`) |
| `GET` | `/api/history/:table/:recordId` | JWT | Record history (requires `enableHistory`) |
| `POST` | `/api/history/search` | JWT | Search history (requires `enableHistory`) |
| `POST` | `/api/history/revert` | JWT | Revert a record (requires `enableHistory`) |
| `POST` | `/api/archive` | JWT or cron | Trigger archival on demand (requires `enableArchiver`) |

**Auth resolution:**
- **Fail-closed:** with `enableHistory: true` and no `PG_HISTORY_JWT_SECRET`, `createServer` throws at startup unless `allowUnauthenticated: true` is passed.
- Set `PG_HISTORY_JWT_SECRET` to enable JWT on `/api/*`. Algorithm via `PG_HISTORY_JWT_ALG` (default `HS256`; supports `HS256/384/512`, `RS256/384/512`, `ES256/384/512`). Pin the token to this API with `jwt: { issuer, audience }` (or `PG_HISTORY_JWT_ISSUER` / `PG_HISTORY_JWT_AUDIENCE`) — signature checking alone accepts any token signed with the same key, including one minted by another service that shares the secret.
- **Authorization** is separate from authentication: supply an `authorize` hook to scope access per tenant/record (returning `false` → `403`). Without it, any valid token can reach any configured table's history. On `pg-history/next`, pass it through `createHandlers`.
- Set `archiveCronSecret` (or `CRON_SECRET` env) to authenticate the three archiver endpoints via timing-safe HMAC. It is an **alternative** credential, not an additional one: on `/api/archive`, `/api/stats` and `/api/health/detailed` a request is accepted if it presents either a valid JWT or the exact cron secret. (A request carries one `Authorization` header — demanding both made the route uncallable whenever both were configured.)
- Archiver endpoints also need `enableArchiver: true` with a valid `archiverConfig`; without that, or without any auth at all, they are never registered.
- `/health` is always public. `/openapi` is public with `publicOpenApi: true`, JWT-gated when a JWT secret is set, registered unauthenticated under `allowUnauthenticated: true`, and unregistered otherwise — so a cron-only deployment doesn't leak the API shape.
- `OPTIONS` preflight bypasses JWT so CORS works.

### Request & Response Shapes

`GET /api/history/:table/:recordId` takes `?limit=&cursor=&order=`. The two POST bodies:

```jsonc
// POST /api/history/search — tables required, everything else optional
{ "tables": ["users"], "query": "{\"email\":\"a@b.com\"}", "operation": "UPDATE",
  "dateFrom": "2026-01-01T00:00:00Z", "dateTo": "2026-02-01T00:00:00Z",
  "limit": 100, "cursor": "12345" }

// POST /api/history/revert — auditEntryId is a numeric audit_log id
{ "table": "users", "recordId": "1", "auditEntryId": "42",
  "suppressAuditTriggers": false }
```

Reads return the `PaginatedResult` shape (`{data, nextCursor, hasMore}`); revert returns `{success: true}`. Failures return `{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }` — codes are `VALIDATION_ERROR` / `INVALID_TABLE` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `REVERT_ERROR` (422), `RATE_LIMITED` (429), and `DATABASE_ERROR` / `ARCHIVAL_ERROR` / `NOT_CONFIGURED` (500). Bodies over 1 MB are rejected.

### Health Check

`GET /health` runs a bounded `SELECT 1` DB probe (2s timeout) and returns the minimal shape so operational details aren't leaked to anonymous callers:

```json
{ "status": "ok" }
```

`status` flips to `"degraded"` when the archiver has failed. If the database is unreachable, `/health` returns HTTP `503` with `{ "status": "error" }` — so platform health checks (Kubernetes, a load balancer) fail over instead of routing traffic to an instance whose queries all 500.

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

`src/main.ts` is the entrypoint (also published as the `pg-history` bin). It reads config from the environment and binds the port with `Bun.serve` — `src/server.ts` only exports `createServer` and does nothing when executed directly.

```bash
PG_HISTORY_DATABASE_URL=postgres://localhost:5432/mydb \
PG_HISTORY_TABLES=users,orders \
PG_HISTORY_JWT_SECRET=your-secret \
bun run src/main.ts
```

`PG_HISTORY_TABLES` is what enables the history API — without it the process starts but serves only `/health`. Without `PG_HISTORY_JWT_SECRET`, startup fails closed unless `PG_HISTORY_ALLOW_UNAUTHENTICATED=true`.

## Dashboard

A ready-to-deploy Next.js UI for browsing, searching and reverting the audit trail. It lives in [`dashboard/`](./dashboard) and is a single deployment: the same app mounts the real pg-history REST API at `/api` and renders the screens on top of it, so nothing else has to be running.

```bash
cd dashboard
cp .env.example .env.local   # PG_HISTORY_DATABASE_URL, PG_HISTORY_TABLES, PG_HISTORY_JWT_SECRET
bun install
bun run dev                  # builds the root package, then starts Next on :3000
```

It reads the same environment variables the server does — `PG_HISTORY_TABLES` is what enables the history screens, and setting `PG_HISTORY_S3_BUCKET` turns on the archival panels. See [`dashboard/README.md`](./dashboard/README.md) for the full walkthrough.

### Screens

| Route | What it does |
|-------|--------------|
| `/` | Health, archival backlog, recent activity across all tables, jump-to-record |
| `/search` | JSONB containment or ILIKE search with operation / date-range / table filters, cursor pagination, per-entry diff |
| `/tables` | Every audited table with its last change, actor and archival backlog |
| `/tables/[table]` | One table: operation mix, recent changes, jump-to-record |
| `/history/[table]/[recordId]` | One record's full timeline, oldest/newest ordering, per-entry revert |
| `/archival` | Archival status and on-demand runs |
| `/openapi` | The API reference, rendered from the OpenAPI document |
| `/api/*` | The pg-history REST API itself — for cron, scripts and other services |
| `/login` | The password gate |

### Access control

**The UI is password-gated.** Set `PG_HISTORY_DASHBOARD_PASSWORD`; visitors exchange it for a signed, httpOnly session cookie (12 hours by default — `PG_HISTORY_DASHBOARD_SESSION_TTL_HOURS`). In production the middleware **refuses to serve the UI** until a password is set, because a page load is enough to read and revert every audited record. Development runs open. If an access proxy or SSO already authenticates every request, acknowledge that with `PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS=true` instead of leaving it accidental.

Failed logins are throttled — escalating delay for everyone, plus a 15-minute lockout for clients the platform can identify (an unidentifiable client is never locked out, or an attacker could lock *you* out by failing five times). Rotating the password invalidates every session, and it is the only revocation there is: one shared password means no individual sessions to revoke, so treat the cookie as a 12-hour bearer token.

`/api/*` is deliberately outside the cookie gate: it is the real REST API with its own JWT (and cron secret), and schedulers call it.

**It never issues a token to the browser.** Server components and server actions mint a 60-second HS256 JWT with `jose` and invoke the very same route handlers mounted at `/api`, in-process with a synthetic `Request`. No network hop, no CORS, one connection pool, and identical auth, validation and error semantics to any external caller. The JWT `sub` carries `PG_HISTORY_DASHBOARD_ACTOR`, which pg-history logs on every revert — set it to something identifiable per deployment.

**Authentication is not authorization.** Past the gate, the dashboard's self-minted token has blanket access to every record of every configured table. For per-tenant scoping, mount the API with an `authorize` hook via `createHandlers` (see [Next.js](#nextjs-serverless)) — the shared password says *someone* is allowed in, not *which rows* they may touch.

One behaviour worth knowing: archived history disappears from reads. Both `getHistory` and `search` filter out soft-deleted rows, so once the archiver has run, that history lives in S3 — reachable through `listArchives` / `readArchive`, not through these screens.

## Deployment

Click the button below to get the dashboard and the REST API as one Vercel project, wire the `pg-history/next` route handler into an app you already have, or run the container anywhere.

### One click: the dashboard on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FTimMikeladze%2Fpg-history%2Ftree%2Fmain%2Fdashboard&project-name=pg-history-dashboard&repository-name=pg-history-dashboard&env=PG_HISTORY_DATABASE_URL%2CPG_HISTORY_TABLES%2CPG_HISTORY_JWT_SECRET%2CPG_HISTORY_DASHBOARD_PASSWORD%2CPG_HISTORY_JWT_ALG%2CPG_HISTORY_POOL_MAX%2CPG_HISTORY_STATEMENT_TIMEOUT_MS%2CPG_HISTORY_DASHBOARD_ACTOR%2CPG_HISTORY_RETENTION_DAYS%2CPG_HISTORY_GRACE_PERIOD_DAYS%2CPG_HISTORY_BATCH_SIZE&envDefaults=%7B%22PG_HISTORY_JWT_ALG%22%3A%22HS256%22%2C%22PG_HISTORY_POOL_MAX%22%3A%223%22%2C%22PG_HISTORY_STATEMENT_TIMEOUT_MS%22%3A%2230000%22%2C%22PG_HISTORY_DASHBOARD_ACTOR%22%3A%22dashboard%22%2C%22PG_HISTORY_RETENTION_DAYS%22%3A%2290%22%2C%22PG_HISTORY_GRACE_PERIOD_DAYS%22%3A%227%22%2C%22PG_HISTORY_BATCH_SIZE%22%3A%2210000%22%7D&envDescription=Only+the+first+four+need+a+value%3A+a+Postgres+connection+string%2C+the+tables+to+audit%2C+a+JWT+signing+secret%2C+and+a+password+for+the+dashboard+UI+%28it+can+read+and+revert+every+audited+record%29.+The+rest+arrive+prefilled+with+the+library+defaults.&envLink=https%3A%2F%2Fgithub.com%2FTimMikeladze%2Fpg-history%23environment-variables)

The button clones [`dashboard/`](./dashboard) on its own — the [Dashboard](#dashboard) UI and the REST API it runs on, in one project, with `dashboard/vercel.json` registering the archival cron. The clone consumes `pg-history` from npm, so nothing else in this repo has to build for it to deploy — Vercel's Root Directory cannot reach a parent directory, which is what makes the published package the dependency here.

**What you fill in.** Four variables:

| Variable | Value |
|----------|-------|
| `PG_HISTORY_DATABASE_URL` | Postgres connection string. Point it at a pooled endpoint (Neon, Supabase, PgBouncer) — every invocation opens its own pool |
| `PG_HISTORY_TABLES` | Comma-separated tables to audit, e.g. `users,orders`. They must already exist: the app installs triggers on them at first request |
| `PG_HISTORY_JWT_SECRET` | Long random string. The dashboard signs its own short-lived tokens with it and it never reaches the browser |
| `PG_HISTORY_DASHBOARD_PASSWORD` | Long random string. The password for the UI itself — without it the deployed dashboard refuses to serve pages, because reaching one means being able to read and revert every audited record |

**What arrives prefilled**, straight from the library's defaults, so the form is a click-through: `PG_HISTORY_JWT_ALG=HS256`, `PG_HISTORY_POOL_MAX=3`, `PG_HISTORY_STATEMENT_TIMEOUT_MS=30000`, `PG_HISTORY_DASHBOARD_ACTOR=dashboard`, `PG_HISTORY_RETENTION_DAYS=90`, `PG_HISTORY_GRACE_PERIOD_DAYS=7`, `PG_HISTORY_BATCH_SIZE=10000`. Defaults are only ever passed for non-secret values — the clone URL ends up in browser history, which is why the three above are the ones left blank.

**After the first deploy**, add the archiver's own variables in the project settings — `PG_HISTORY_S3_BUCKET` (this is the switch: without it there is no `/api/archive` and no archival UI), the S3 credentials, and `CRON_SECRET`. Until `CRON_SECRET` is set the nightly cron gets a `401`; until the bucket is set it gets a `404`. Both are inert, not broken — see [Cron Archival](#cron-archival-vercel-cron).

Past the password gate the dashboard has blanket access to every audited row by design — the password is a lock on the door, not per-user authorization. Put it behind SSO or a network boundary too before pointing it at production, and supply an `authorize` hook for per-tenant scoping — see [Access control](#access-control).

### Next.js (Serverless)

Auditing itself is runtime-independent — the triggers live in PostgreSQL. The `pg-history/next` entry point is a Next.js App Router route handler and runs anywhere Next.js runs; only the *cron scheduling* below is Vercel-specific.

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
// app/api/[[...route]]/route.ts
export { GET, POST, OPTIONS } from 'pg-history/next'
```

Set environment variables on your host — all three are required:

```
PG_HISTORY_DATABASE_URL=postgres://...
PG_HISTORY_TABLES=users,orders
PG_HISTORY_JWT_SECRET=your-secret
```

The JWT secret is not optional here: this entry point always enables the history API, destructive `revert` included, so without a secret it refuses to start and every request returns `500 INIT_ERROR`. `PG_HISTORY_ALLOW_UNAUTHENTICATED` is deliberately not wired up on this path.

Export `OPTIONS` too if anything calls the API cross-origin — without it Next answers preflight with `405` and the browser blocks the real request, whatever `cors` says.

**Anything that isn't an environment variable** — above all the `authorize` hook, which is the only per-tenant isolation there is — goes through `createHandlers`:

```typescript
// app/api/[[...route]]/route.ts
import { createHandlers } from 'pg-history/next'

export const { GET, POST, OPTIONS } = createHandlers({
  // Without this, any valid token reaches every record of every audited table.
  authorize: async ({ actor, table, recordId, action }) => {
    if (action === 'revert') return actor === 'admin'
    return tenantOwns(actor, table, recordId)
  },
  cors: { origin: 'https://app.example.com', credentials: true },
})

export const dynamic = 'force-dynamic'
```

Everything not overridden still comes from the environment, and the handlers keep their own lazily-initialised app and pool. Pass `pool` to supply your own — pg-history will not close a pool it did not create.

The `pg-history/next` entry point automatically enables `serverless: true`, which:
- Skips background archival (use [cron archival](#cron-archival-vercel-cron) instead)
- Skips in-memory rate limiting (handle at API gateway / firewall level)
- Uses a small pool size (default 3) to stay within connection limits

#### Cron Archival (Vercel Cron)

Serverless has no persistent process, so archival needs an external trigger. Add `vercel.json` next to the Option B route handler above, plus the S3 and `CRON_SECRET` variables from [Environment Variables](#environment-variables). Working example: [`examples/next/`](./examples/next). The one-click dashboard already ships this file.

```json
{
  "crons": [
    {
      "path": "/api/archive",
      "schedule": "0 0 * * *"
    }
  ]
}
```

Daily is the one schedule every plan accepts — Hobby rejects anything more frequent at build time. On Pro, drop to `0 */6 * * *` or hourly.

Vercel Cron calls `POST /api/archive` on schedule with `Authorization: Bearer <CRON_SECRET>` injected automatically; the endpoint verifies it, then runs archive → soft delete → hard delete and returns stats.

The response distinguishes three outcomes, so a scheduler's history reflects what actually happened:

| Outcome | Status | Body |
|---------|--------|------|
| The run succeeded | `200` | `{ success: true, ran: true, archival }` |
| A run was already in flight; this trigger did nothing | `200` | `{ success: true, ran: false, message, archival }` |
| Every attempt failed | `500` | `{ success: false, ran: true, error: { code: "ARCHIVAL_FAILED" }, archival }` |

A failed run answers `500` deliberately — a broken archiver reporting `200` puts a green tick in the cron history while the audit log grows unchecked. The cron secret is accepted *instead of* a JWT on the operational routes (`/api/archive`, `/api/stats`, `/api/health/detailed`), so a deployment can have both credentials and let each caller present its own.

Two things to know: `POST /api/archive` only exists when `PG_HISTORY_S3_BUCKET` is set (that's what enables the archiver in `pg-history/next`), and the catch-all serves `/api/**` only — the public `GET /health` probe is unreachable here, so use `/api/health/detailed` or add your own `app/health/route.ts`.

**Vercel plan limits:**
- **Hobby:** Cron minimum interval 24h, function timeout 10s
- **Pro:** Cron minimum interval 1h, function timeout 60s

If archival takes longer than the function timeout, it will be interrupted. The design is retry-safe — unfinished records stay unarchived and get picked up on the next run. Set `PG_HISTORY_BATCH_SIZE` to a lower value (1000-2000) to keep individual runs within timeout limits.

**Not on Vercel?** `vercel.json` and `CRON_SECRET` injection are the only Vercel-specific pieces. Anywhere else, keep the same route handler and call `POST /api/archive` from your own scheduler (GitHub Actions, AWS EventBridge, Cloud Scheduler, a system crontab), sending `Authorization: Bearer <CRON_SECRET>` yourself.

### Serverless Considerations

| Concern | Impact | Mitigation |
|---------|--------|------------|
| Connection pooling | Each invocation may create a pool | Use an external pooler (PgBouncer, Neon, Supabase, RDS Proxy). Set `PG_HISTORY_POOL_MAX` low (2-3). |
| Cold starts | `setup()` runs on every cold instance | Already cheap: when the schema exists it short-circuits after one catalog probe (~5ms). Cache the promise at module level and call it freely. |
| Rate limiting | In-memory rate limiter resets per invocation | Use platform-level rate limiting (API Gateway, Vercel Firewall, Cloudflare). |

### Long-lived server (Docker)

Anywhere that runs a container, the repo's `Dockerfile` builds the standalone server described in [Server & REST API](#server--rest-api) — same REST API, but with a background archival loop instead of cron. It runs immediately on startup and then on an interval (`PG_HISTORY_ARCHIVAL_INTERVAL_MS`, default hourly), so give the container a 30s termination grace period and keep at least one instance alive or archival never runs. Configuration is the same environment variables, passed as secrets.

### Other Platforms

The Hono app returned by `createServer()` works with any platform Hono supports:

```typescript
// AWS Lambda
import { handle } from 'hono/aws-lambda'
const { app } = await createServer({ pool, serverless: true, ... })
export const handler = handle(app)

// Cloudflare Workers
const { app } = await createServer({ pool, serverless: true, ... })
export default app
```

## Archiver

Move old audit rows to S3 as compressed Parquet files. Hands off to `Orchestrator` for scheduling and `PgHistoryArchiver` for the upload + delete lifecycle. Concurrent runs are safe — advisory locks prevent two archivers from processing the same table.

### Lifecycle

```
Day 0:   Record created
Day 90:  Retention cutoff -> upload to S3 as Parquet -> mark archived_at
Day 97:  Soft delete (archived_at + gracePeriod, records with confirmed S3 backup)
Day 104: Hard delete (soft_deleted_at + gracePeriod, after re-verifying S3 file exists + SHA-256 checksum)
```

`gracePeriod` is applied twice — once between archive and soft delete, once between soft delete and hard delete. With `gracePeriod: 0` all three stages collapse onto the retention cutoff.

S3 path: `{table}/year={YYYY}/month={MM}/day={DD}/data-{uuid}.parquet`

### What lands in the Parquet file

Ten columns, SNAPPY-compressed: `id` (INT64), `table_name`, `record_id`, `operation`, `changed_at` (TIMESTAMP), `old_data`, `new_data`, `db_user`, `app_actor`, `client_addr`. The JSONB payloads are written as exact JSON **text**, so integers past 2^53 survive the round trip. The attribution columns are archived with the rest: once a row is hard-deleted the Parquet file is the only remaining record of the change, and it has to be able to say who made it.

### Reading an archive back

Archived rows are filtered out of `getHistory()` and `search()` (they are on their way out of Postgres), so the archive is where that history lives. Both halves are on the archiver:

```typescript
const archives = await archiver.listArchives('users', { limit: 20 })
// → [{ s3Path, archiveDate, recordCount, fileSize, checksumSha256, archivedAt }, ...]

const rows = await archiver.readArchive(archives[0].s3Path)
// → [{ id, table_name, record_id, operation, changed_at, old_data, new_data,
//      db_user, app_actor, client_addr }, ...]
```

`readArchive` verifies the object against the SHA-256 recorded at upload time and throws on a mismatch, so a silently corrupted or replaced archive cannot be read back as if it were genuine. Pass `{ verifyChecksum: false }` to read an object that has no metadata row. For files already on local disk, `readParquet` / `writeParquet` are exported too.

### Configuration

```typescript
const { app } = await createServer({
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
    gracePeriod: 7,   // days between archive→soft-delete and soft→hard-delete.
                      // 0 = no grace (purge once the S3 backup is confirmed).
    batchSize: 10000,
    maxBatchBytes: 64 * 1024 * 1024, // soft memory cap per batch; peak RSS ≈ 3×
    staleClaimMinutes: 30,           // when an unfinalized claim is reclaimable
    lockConnectionString: process.env.DATABASE_URL, // advisory-lock client
  },
  runOptions: {
    dryRun: false,
    // Opt-in maintenance, run after each table's archival. Both touch S3, so
    // schedule them on a slower cadence than archival itself.
    cleanupOrphans: true,
    pruneArchivesOlderThanDays: 365,
  },
  // Optional retry policy for background archival. Defaults shown.
  archivalRetry: {
    maxAttempts: 4,
    delays: [5_000, 15_000, 60_000], // needs at least maxAttempts - 1 entries
  },
  // Optional CORS — omit to disable entirely (server-to-server default)
  cors: { origin: 'https://app.example.com', credentials: true },
})
```

The archiver's `logger` is the server's. Everything else — including `maxBatchBytes`, `staleClaimMinutes` and `lockConnectionString` — is forwarded to the `PgHistoryArchiver` the server builds, so you no longer have to construct one by hand to change them.

### Pruning long-term archives

Metadata + S3 grow linearly forever. Set `runOptions.pruneArchivesOlderThanDays` to trim archives past compliance retention as part of the run, or drive it yourself:

```typescript
import { PgHistoryArchiver } from 'pg-history'

const archiver = new PgHistoryArchiver({ pool, ...config })
const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) // 1 year
const deleted = await archiver.pruneArchive('users', cutoff)
```

Removes both the S3 object and its `audit_archive_metadata` row in lockstep.

### Cleaning up orphan S3 files

Files uploaded by a run that died before finalizing are referenced by no metadata row. Set `runOptions.cleanupOrphans` to sweep them as part of the run, or call it directly:

```typescript
const orphans = await archiver.cleanupOrphanedFiles('users', { maxDeletions: 10000 })
```

Bounded per-call so a bucket with millions of orphans doesn't tie up one DB connection for hours. Idempotent — resume on next invocation. Objects younger than `staleClaimMinutes` are never deleted, so a batch still mid-upload is safe; override that window with `minAgeMinutes` when reconciling a bucket nothing is archiving into.

To run archival on your own schedule instead of the server's, drive [`Orchestrator`](#orchestrator) directly.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PG_HISTORY_DATABASE_URL` | Standalone server | PostgreSQL connection string |
| `PG_HISTORY_PORT` | No | Server port (also reads `PORT`, default `3001`) |
| `PG_HISTORY_POOL_MAX` | No | Max pool connections (default `5`, use `2-3` for serverless) |
| `PG_HISTORY_STATEMENT_TIMEOUT_MS` | No | Pool-wide `statement_timeout` (default `30000`; `0` disables). Raise for a one-time archiver index build on a large existing log |
| `PG_HISTORY_JWT_SECRET` | `pg-history/next` entry point | JWT auth on `/api/*`. The standalone server can skip it only with `PG_HISTORY_ALLOW_UNAUTHENTICATED=true`; `pg-history/next` has no such escape hatch |
| `PG_HISTORY_JWT_ALG` | No | JWT algorithm: `HS256/384/512`, `RS256/384/512`, `ES256/384/512` (default `HS256`) |
| `PG_HISTORY_JWT_ISSUER` | No | Required `iss` claim. Unset means the claim is not checked — any token signed with the same key is accepted, including one minted by another service |
| `PG_HISTORY_JWT_AUDIENCE` | No | Acceptable `aud` claim(s), comma-separated |
| `PG_HISTORY_ALLOW_UNAUTHENTICATED` | No | Set `true` to let the standalone server start history endpoints without a JWT (local/trusted only). Read by the standalone server only — `pg-history/next` ignores it |
| `PG_HISTORY_TABLES` | `pg-history/next` entry point | Comma-separated table names. Also what enables the history API on the standalone server — omit it and only `/health` is served |
| `PG_HISTORY_S3_BUCKET` | Archival | S3 bucket. Setting it is what enables the archiver on both entry points |
| `PG_HISTORY_S3_ENDPOINT` | No | Custom S3 endpoint (MinIO, R2, localstack). Omit for AWS; setting it also switches on path-style addressing |
| `PG_HISTORY_S3_ACCESS_KEY_ID` | No | Explicit access key. Omit both key vars to use the default AWS credential chain (IAM role, instance profile, env) |
| `PG_HISTORY_S3_SECRET_ACCESS_KEY` | No | Explicit secret key |
| `PG_HISTORY_S3_REGION` | No | S3 region (default `us-east-1`) |
| `PG_HISTORY_ARCHIVAL_INTERVAL_MS` | No | Background archival interval (default `3600000` / 1 hour) |
| `PG_HISTORY_RETENTION_DAYS` | No | Default retention period (default `90`) |
| `PG_HISTORY_GRACE_PERIOD_DAYS` | No | Grace period before hard delete (default `7`; `0` = no grace, purge once the S3 backup is confirmed) |
| `PG_HISTORY_BATCH_SIZE` | No | Archival batch size (default `10000`) |
| `PG_HISTORY_MAX_BATCH_BYTES` | No | Soft memory cap per batch in bytes (default `67108864` / 64 MiB). `pg-history/next` only; the standalone server takes it from `archiverConfig` |
| `PG_HISTORY_STALE_CLAIM_MINUTES` | No | When an unfinalized claim is reclaimable, and the orphan-sweep safety window (default `30`) |
| `CRON_SECRET` | Cron archival (Vercel Cron) | Authenticates `POST /api/archive`, `/api/stats` and `/api/health/detailed`. Accepted **instead of** a JWT on those routes, so setting both is fine |
| `PG_HISTORY_SILENT_LOGS` | No | Set `1` to drop all output from the default `consoleLogger` (used by the test suite). No effect on an injected `logger` |

## Production Caveats

Knobs and trade-offs, not bugs.

### Connection pooler compatibility

- The main pool can run behind **PgBouncer transaction mode** — every archival query uses `SET LOCAL statement_timeout` inside a short transaction.
- The `Orchestrator` advisory-lock client is a **standalone `pg.Client`**, not borrowed from the pool. Session-level advisory locks require a stable connection — pass `lockConnectionString` in `OrchestratorConfig` to point it directly at PostgreSQL (bypass the pooler) or use a pooler in session mode for that one connection.

### Rate limiting

Built-in `/api/*` rate limiter is **per-process in-memory**, 100 requests/minute per client. It picks the bucket key in this order:

1. `clientIdentifier(ctx)` — your own function, given the raw `Request` and the runtime `env`. Use it to bucket by API-key id or a header your edge guarantees.
2. `x-forwarded-for` / `x-real-ip`, **only** under `trustProxy: true`. These are client-spoofable, and a per-request-spoofed header would hand every request a fresh bucket.
3. The transport peer address (Bun and `@hono/node-server` expose it). Unspoofable, so an untrusted-proxy deployment still gets per-client buckets.
4. A single global 1000/minute bucket — last resort, on runtimes exposing no peer address. One noisy client can consume it and 429 everyone else, so configure `clientIdentifier` or `trustProxy` rather than relying on it.

`serverless: true` skips the in-process limiter entirely — the mode-independent DoS backstop is the `search()` concurrency cap (`maxConcurrentSearches`). For production, also terminate rate limiting at your API gateway (Cloudflare, AWS API Gateway, Vercel Firewall).

### `audit_archive_metadata` and S3 growth

INSERT-only by design. After hard-delete, audit_log rows are gone but the S3 file + metadata row stay for compliance. Schedule `archiver.pruneArchive(table, olderThan)` weekly/monthly to bound long-term storage. `cleanupOrphanedFiles` only removes S3 files not in metadata — not the metadata itself.

### `hardDeletePurged` lock window

S3 existence + checksum verification happens **before** the delete transaction; the locked `FOR UPDATE` transaction then does a pure re-check + `DELETE` with **no network I/O**, so row locks are held only for the DB round-trip, not S3 latency. (A small window where an external actor deletes the S3 object between verify and delete is accepted — `cleanupOrphanedFiles` and the next run reconcile it.) Still, run hard-delete on its own schedule, not in the same loop as `processBatch`, if you have heavy concurrent writes.

### Memory under wide rows

`maxBatchBytes` (default 64 MiB) is a **soft cap based on serialized JSON length**. Peak process memory is roughly this ×3 (decoded rows + Parquet buffer + upload buffer), so the 64 MiB default stays safe on a 512 MB VM. If you audit columns with multi-MB jsonb, keep `maxBatchBytes` well under 30-50% of available RSS. Excluded columns (`excludeColumns`) reduce the per-row payload at source.

### Trigger ownership (SECURITY DEFINER)

Generated trigger functions run with the privileges of their **owner** — whoever ran `setup()`. If that role is superuser, audit inserts run with superuser privilege. For least-privilege deployments, create a dedicated `pg_history_writer` role with INSERT on `audit_log` and either run `setup()` as that role, or post-setup do `ALTER FUNCTION audit_trigger_func_<table>() OWNER TO pg_history_writer`.

### Tamper-resistance / append-only

`appendOnly: true` installs a guard trigger that blocks `UPDATE`/`DELETE` on `audit_log` outside the pg-history maintenance context (PostgreSQL 14+). That stops accidental and casual tampering, but the context is just a session GUC: **any role that can reach the database can run `SET pg_history.maintenance = 'on'` and walk straight past the guard.** It is tamper-*resistance* against mistakes and careless code, not evidence against a motivated actor — do not describe it to an auditor as WORM. For genuine WORM guarantees, layer on: `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log` from the application role (run the archiver under a separate privileged role), enforce S3 Object Lock on the archive bucket, and add a per-row hash chain if you need cryptographic evidence.

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

## Error Handling

Typed error classes, all extending `PgHistoryError`:

```typescript
import {
  PgHistoryError,               // Base class for all pg-history errors
  TableNotConfiguredError,       // Table not in configured tables list
  SetupRequiredError,            // setup() not called before query
  AuditEntryNotFoundError,       // Audit entry not found for revert
  ValidationError,               // Input validation failure
  RevertError,                   // Revert operation failure
  AuthorizationError,            // authorize() hook denied the request (HTTP 403)
  SearchConcurrencyLimitError,   // too many concurrent search() calls (HTTP 429)
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

- **TRUNCATE is audited** as a single marker entry (`operation: 'TRUNCATE'`, `record_id: '(truncate)'`), searchable like any other operation. It has no per-row before/after images, so it cannot be reverted — restore from a backup or from the Parquet archive.
- **DDL not audited.** `ALTER TABLE`, `DROP TABLE`, etc.
- **Revert requires a primary key.**
- **PK changes require re-setup.** Call `teardown()` then `setup()`.
- **Column changes are fine.** JSONB adapts automatically.
- **Text search (ILIKE) is slow on large tables.** Use JSON containment queries (`{"key": "value"}`) for indexed search. Text search has a 5-second timeout, and concurrent searches are capped (`maxConcurrentSearches`).
- **Append-only enforcement is opt-in** (`appendOnly: true`, PostgreSQL 14+) and is tamper-resistance, not cryptographic tamper-evidence: any role that can reach the database can set the bypass GUC — see [Production Caveats](#tamper-resistance--append-only).
- **Archived history leaves the read API.** Once the archiver soft-deletes a row, `getHistory` and `search` no longer return it; read it back with `listArchives` / `readArchive`.

## License

MIT
