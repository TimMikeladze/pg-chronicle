# pg-history

PostgreSQL audit trails with automated S3 archival.

[![npm version](https://img.shields.io/npm/v/pg-history.svg)](https://www.npmjs.com/package/pg-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Server & REST API](#server--rest-api)
- [Archiver](#archiver)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Limitations](#limitations)

## Quick Start

```typescript
import { Pool } from 'pg'
import { PgHistory } from 'pg-history'

const pool = new Pool({ connectionString: 'postgres://localhost:5432/mydb' })
const history = new PgHistory({ pool, tables: ['users', 'orders'] })

await history.setup()

// Triggers now capture all INSERT/UPDATE/DELETE on tracked tables.

const result = await history.getHistory('users', '1')
await history.revert('users', '1', result.data[1].id)
```

## Installation

```bash
bun add pg-history
```

Peer dependency: `pg`.

Requires PostgreSQL 12+, Node.js 18+ or Bun.

## Architecture

`AFTER` triggers on tracked tables write to a partitioned `audit_log` table within the same transaction.

```
Your Table -> AFTER trigger -> audit_log (partitioned by table_name)
```

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
| `changed_by` | `TEXT` | User ID if set via `setUser()` |
| `metadata` | `JSONB` | Custom metadata |

### Indexes

- GIN on `old_data`, `new_data` for `@>` containment queries
- B-tree on `(table_name, record_id, changed_at DESC)`
- B-tree on `changed_at DESC`
- B-tree on `changed_by`

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
  types.ts              TypeScript interfaces
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

Creates `audit_log` table, partitions, indexes, and triggers. Idempotent.

### `setUser(client: PoolClient, userId: string, metadata?: Record<string, unknown>): Promise<void>`

Sets audit context on a client via `set_config(..., true)`. Scoped to the current transaction.

```typescript
const client = await pool.connect()
await client.query('BEGIN')
await history.setUser(client, 'user-123', { ip: '10.0.0.1' })
await client.query('UPDATE users SET name = $1 WHERE id = $2', ['Bob', 1])
await client.query('COMMIT')
client.release()
```

### `clearUser(client: PoolClient): Promise<void>`

Clears audit context on the client.

### `withUser<T>(userId, metadata, fn): Promise<T>`

Acquires a client, begins a transaction, sets user context, runs `fn`, commits or rolls back.

```typescript
await history.withUser('user-123', { ip: '10.0.0.1' }, async (client) => {
  await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['shipped', 42])
})
```

### `getHistory(tableName, recordId, options?): Promise<PaginatedResult<AuditEntry>>`

Options: `limit` (default 50, max 1000), `cursor`, `order` (`'asc'` | `'desc'`).

### `search(options): Promise<PaginatedResult<AuditEntry>>`

Options: `tables` (required), `query`, `operation`, `dateFrom`, `dateTo`, `changedBy`, `limit` (default 100, max 1000), `cursor`.

If `query` looks like JSON (`{...}`), uses `@>` containment (GIN-indexed). Otherwise uses `ILIKE`.

### `revert(tableName, recordId, auditEntryId, userContext?): Promise<void>`

Restores a record to the state in the given audit entry. Runs in a single transaction. Requires a primary key.

| Original Op | Revert Action |
|-------------|---------------|
| `INSERT` | Deletes the row |
| `DELETE` | Re-inserts from `old_data` |
| `UPDATE` | Restores `old_data` values |

The revert is itself audited with `metadata.revertedFrom`.

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
  changedBy: string | null
  metadata: Record<string, unknown> | null
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
| `GET` | `/health` | No | `{ status: "ok" }` |
| `GET` | `/openapi` | No | OpenAPI spec |
| `GET` | `/api/stats` | JWT | Archival stats (requires `enableArchiver`) |
| `GET` | `/api/history/:table/:recordId` | JWT | Record history |
| `POST` | `/api/history/search` | JWT | Search history |
| `POST` | `/api/history/revert` | JWT | Revert a record |

Set `PG_HISTORY_JWT_SECRET` to enable JWT auth on `/api/*`. Public routes (`/health`, `/openapi`) are unprotected.

### Standalone

```bash
PG_HISTORY_DATABASE_URL=postgres://localhost:5432/mydb bun run src/server.ts
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
| `PG_HISTORY_PORT` | No | Server port (default `3001`) |
| `PG_HISTORY_JWT_SECRET` | No | JWT auth on `/api/*` |
| `PG_HISTORY_S3_ENDPOINT` | Archival | S3 endpoint |
| `PG_HISTORY_S3_ACCESS_KEY_ID` | Archival | S3 access key |
| `PG_HISTORY_S3_SECRET_ACCESS_KEY` | Archival | S3 secret key |
| `PG_HISTORY_S3_REGION` | Archival | S3 region (default `us-east-1`) |
| `PG_HISTORY_S3_BUCKET` | Archival | S3 bucket |

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

### Test Files

```
test/
  PgHistory.test.ts              Setup/lifecycle
  setup.test.ts                  Idempotency
  teardown.test.ts               Cleanup
  triggers.test.ts               INSERT/UPDATE/DELETE
  get-history.test.ts            Pagination
  search.test.ts                 Filtering
  revert.test.ts                 Revert ops
  user-tracking.test.ts          setUser/withUser
  validation.test.ts             Input validation
  input-validation.test.ts       SQL injection
  security.test.ts               Security
  server-api.test.ts             REST API
  read-only-integration.test.ts  Integration
  archiver/
    PgHistoryArchiver.test.ts    S3 batches
    orchestrator.test.ts         Discovery
    orchestrator-integration.test.ts  Full archival
    schema.test.ts               DDL
    parquet.test.ts              Read/write
    soft-delete.test.ts          Soft delete
    hard-delete.test.ts          Hard delete
    stats.test.ts                Stats
```

## Limitations

- **TRUNCATE not audited.** Use `DELETE` if audit trail needed.
- **DDL not audited.** `ALTER TABLE`, `DROP TABLE`, etc.
- **Revert requires a primary key.**
- **PK changes require re-setup.** Call `teardown()` then `setup()`.
- **Column changes are fine.** JSONB adapts automatically.

## License

MIT
