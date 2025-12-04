# Multi-Database Support Design

**Date:** 2025-12-03
**Status:** Approved
**Architecture:** Database Manager Registry

## Overview

Add support for monitoring multiple PostgreSQL databases from a single pg-history server instance. Each database can have independent configuration for tables, retention policies, and setup behavior.

## Requirements

### Functional Requirements
- Monitor multiple PostgreSQL databases from one server
- Auto-setup on startup (configurable per database)
- Manual setup/teardown via API endpoints (per database)
- Per-database retention policies with global defaults
- Shared S3 bucket with database name prefixes
- Per-database history API access (explicit database in URL)

### Non-Functional Requirements
- Retry with exponential backoff for transient failures
- Configurable failure mode (continue vs stop server)
- Backward compatibility with single-database mode
- Comprehensive test coverage including existing test updates

## Architecture

### Approach: Database Manager Registry

Use a `DatabaseManager` class that maintains a registry of PgHistory instances (one per database). Clean separation, easy to add/remove databases, clear resource ownership.

**Rejected alternatives:**
- Extended PgHistory Class: Would make PgHistory too heavy, complex internal routing
- Router + Isolated Instances: Too many files to change, over-engineered for this use case

## Design

### 1. Configuration Structure

```typescript
interface DatabaseConfig {
  name: string                    // Unique identifier
  pool: Pool                      // Dedicated connection pool
  tables: string[]                // Tables to track
  autoSetup?: boolean            // Auto-setup on startup (default: false)
  retention?: RetentionConfig    // Override global retention
}

interface ServerConfig {
  databases: DatabaseConfig[]     // Array of database configs
  s3: S3Config                   // Shared S3 bucket
  globalRetention: RetentionConfig  // Default retention policy
  gracePeriod: number
  port?: number
  failureMode?: 'continue' | 'stop'  // default: 'continue'
}
```

**S3 Path Structure:**
`s3://bucket/{databaseName}/{tableName}/{date}.parquet`

**Backward Compatibility:**
Single-database mode works by passing a one-element `databases` array.

### 2. DatabaseManager Class

```typescript
class DatabaseManager {
  private instances: Map<string, PgHistory>
  private pools: Map<string, Pool>
  private configs: Map<string, DatabaseConfig>
  private statuses: Map<string, DatabaseStatus>
  private retryConfig = { maxAttempts: 3, backoffMs: 1000 }
  private failureMode: 'continue' | 'stop'
  private globalRetention: RetentionConfig

  constructor(
    databases: DatabaseConfig[],
    globalRetention: RetentionConfig,
    failureMode: 'continue' | 'stop' = 'continue'
  )

  async setupDatabase(name: string): Promise<SetupResult>
  async teardownDatabase(name: string): Promise<void>
  async setupAll(): Promise<Map<string, SetupResult>>

  getInstance(name: string): PgHistory | undefined
  listDatabases(): string[]
  getStatus(name: string): DatabaseStatus
  getAllStatuses(): Map<string, DatabaseStatus>
}

type DatabaseStatus =
  | { state: 'ready', setupAt: Date }
  | { state: 'failed', error: string, lastAttempt: Date }
  | { state: 'retrying', attempt: number, nextRetryAt: Date }
  | { state: 'not_initialized' }

interface SetupResult {
  status: 'success' | 'failed'
  database: string
  error?: Error
}
```

**Responsibilities:**
- Create and manage PgHistory instances (one per database)
- Handle setup/teardown with retry logic
- Track status per database
- Expose instances for API route handlers

### 3. Setup/Teardown Flow

**Setup Flow:**

```typescript
async setupDatabase(name: string): Promise<SetupResult> {
  const config = this.configs.get(name)
  if (!config) throw new Error(`Database ${name} not configured`)

  let lastError: Error

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      this.statuses.set(name, {
        state: 'retrying',
        attempt,
        nextRetryAt: new Date(Date.now() + this.calculateBackoff(attempt))
      })

      const pgHistory = new PgHistory({
        pool: config.pool,
        tables: config.tables
      })
      await pgHistory.setup()

      this.instances.set(name, pgHistory)
      this.statuses.set(name, { state: 'ready', setupAt: new Date() })

      return { status: 'success', database: name }
    } catch (error) {
      lastError = error
      if (attempt < 3) {
        const backoffMs = this.calculateBackoff(attempt)
        await this.sleep(backoffMs)
      }
    }
  }

  // After 3 failures
  this.statuses.set(name, {
    state: 'failed',
    error: lastError.message,
    lastAttempt: new Date()
  })

  if (this.failureMode === 'stop') {
    throw new Error(`Setup failed for ${name}: ${lastError.message}`)
  }

  return { status: 'failed', database: name, error: lastError }
}

private calculateBackoff(attempt: number): number {
  return 1000 * Math.pow(2, attempt - 1)  // 1s, 2s, 4s
}
```

**Retry Timing:** 1s, 2s, 4s (total ~7 seconds per database)

**Teardown Flow:**

```typescript
async teardownDatabase(name: string): Promise<void> {
  const pgHistory = this.instances.get(name)
  if (!pgHistory) {
    throw new Error(`Database ${name} not initialized`)
  }

  await pgHistory.teardown()
  this.instances.delete(name)
  this.statuses.set(name, { state: 'not_initialized' })
}
```

No retries for teardown - if it fails, it fails.

**Auto-setup on Startup:**

```typescript
// In createServer()
const databaseManager = new DatabaseManager(
  config.databases,
  config.globalRetention,
  config.failureMode
)

// Auto-setup databases that have autoSetup: true
const results = await databaseManager.setupAll()

// Log results
for (const [name, result] of results) {
  if (result.status === 'success') {
    console.log(`Database ${name} setup successful`)
  } else {
    console.error(`Database ${name} setup failed:`, result.error)
  }
}
```

**Failure Mode Behavior:**
- `failureMode: 'continue'` - Log errors, mark database unavailable, server starts
- `failureMode: 'stop'` - Throw error and exit if ANY database fails after retries

### 4. API Endpoints

**New Management Endpoints:**

```typescript
// Setup specific database
POST /api/setup/:database
Response: {
  status: 'success' | 'failed',
  message: string,
  database: string
}

// Teardown specific database
POST /api/teardown/:database
Response: {
  status: 'success',
  message: string,
  database: string
}

// List all databases and their status
GET /api/databases
Response: {
  databases: [
    {
      name: 'db1',
      status: 'ready',
      tables: ['users', 'orders'],
      setupAt: '2025-12-03T10:00:00Z'
    },
    {
      name: 'db2',
      status: 'failed',
      error: 'connection timeout',
      lastAttempt: '2025-12-03T10:01:00Z'
    }
  ]
}
```

**Updated History Endpoints:**

```typescript
// Was: GET /api/history/:table/:recordId
// Now: GET /api/history/:database/:table/:recordId
GET /api/history/:database/:table/:recordId?limit=50&cursor=abc&order=desc

// Was: POST /api/history/search (body: { tables: [...] })
// Now: POST /api/history/search (body: { database: string, tables: [...] })
POST /api/history/search
Body: {
  database: string,      // NEW: required field
  tables: string[],
  query?: string,
  operation?: 'INSERT' | 'UPDATE' | 'DELETE',
  dateFrom?: string,
  dateTo?: string,
  changedBy?: string,
  limit?: number,
  cursor?: string
}
```

**Route Handler Example:**

```typescript
app.get('/api/history/:database/:table/:recordId', async (c) => {
  const dbName = c.req.param('database')
  const pgHistory = databaseManager.getInstance(dbName)

  if (!pgHistory) {
    return c.json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: `Database '${dbName}' is not available`,
        details: databaseManager.getStatus(dbName)
      }
    }, 503)
  }

  const table = c.req.param('table')
  const recordId = c.req.param('recordId')

  // ... rest of handler (unchanged from single-DB version)
})
```

### 5. Archival Orchestration

The existing `Orchestrator` class works with a single Pool. For multi-database, run it once per database sequentially:

```typescript
// In server.ts startup
if (config.enableArchiver) {
  for (const dbConfig of config.databases) {
    const pgHistory = databaseManager.getInstance(dbConfig.name)
    if (!pgHistory) {
      console.warn(`Skipping archival for ${dbConfig.name} (not available)`)
      continue
    }

    const retention = dbConfig.retention || config.globalRetention
    const orchestrator = new Orchestrator(
      config.s3,
      retention,
      config.gracePeriod,
      config.batchSize || 10000
    )

    const stats = await orchestrator.run(dbConfig.pool, {
      s3Prefix: dbConfig.name,  // NEW: prefix S3 paths with database name
      ...config.runOptions
    })

    console.log(`Archival complete for ${dbConfig.name}:`, {
      recordsArchived: stats.totalRecordsArchived,
      recordsSoftDeleted: stats.totalRecordsSoftDeleted,
      recordsHardDeleted: stats.totalRecordsHardDeleted,
      durationMs: stats.durationMs
    })
  }
}
```

**S3 Path:** `s3://bucket/{databaseName}/{tableName}/{timestamp}.parquet`

**Archival Metadata:** Each database gets its own `archival_metadata` table (already how it works).

**Execution:** Sequential (one database at a time). Could parallelize later if needed, but sequential is safer and simpler.

**Orchestrator Enhancement:**

Add optional `s3Prefix` to `RunOptions`:

```typescript
interface RunOptions {
  dryRun?: boolean
  targetTable?: string
  s3Prefix?: string  // NEW: prepend to S3 keys
}
```

### 6. Error Handling and Status Tracking

**Error Scenarios:**

| Scenario | Behavior |
|----------|----------|
| Connection failure during setup | Retry 3x with backoff, then mark failed or stop server |
| Trigger creation fails | Same retry logic (idempotent setup handles partial state) |
| API request to unavailable DB | Return 503 with status details |
| Archival failure on one DB | Log error, continue with other databases |

**Health Endpoint Enhancement:**

```typescript
GET /health
Response: {
  status: 'healthy' | 'degraded' | 'unhealthy',
  databases: {
    db1: { status: 'ready', setupAt: '2025-12-03T10:00:00Z' },
    db2: { status: 'failed', error: 'connection timeout' }
  },
  archiver: {
    enabled: true,
    lastRun: '2025-12-03T09:00:00Z'
  }
}
```

**Status Levels:**
- `healthy` - All databases ready
- `degraded` - Some databases failed but `failureMode: 'continue'`
- `unhealthy` - Critical failure (depends on `failureMode`)

## Testing Strategy

### Unit Tests

**DatabaseManager:**
- `setupDatabase()` success case
- `setupDatabase()` with retries and eventual success
- `setupDatabase()` with retries and eventual failure
- `setupAll()` with mixed success/failure
- `failureMode: 'stop'` throws on failure
- `failureMode: 'continue'` continues on failure
- `teardownDatabase()` success
- `getInstance()` returns correct instance
- Status tracking through setup/retry/fail lifecycle

### Integration Tests

**Multi-database scenarios:**
- Server starts with multiple databases
- Auto-setup with `autoSetup: true`
- Per-database retention policies
- S3 archival with correct prefixes
- API endpoints with database parameter
- Database unavailable returns 503

**Backward compatibility:**
- Single database config still works
- Existing tests pass with minimal changes

### API Endpoint Tests

- `POST /api/setup/:database` success/failure
- `POST /api/teardown/:database` success/failure
- `GET /api/databases` returns all statuses
- `GET /api/history/:database/:table/:recordId` with valid/invalid database
- `POST /api/history/search` with database parameter
- Health endpoint shows degraded/healthy status

### Test Updates Required

**Existing tests to update:**
- `PgHistory` tests: ensure backward compatibility
- Server tests: adapt to new config structure
- Archival tests: verify S3 prefix behavior

## Implementation Checklist

- [ ] Create `DatabaseManager` class in `src/DatabaseManager.ts`
- [ ] Update `ServerConfig` type in `src/types.ts`
- [ ] Add retry logic with exponential backoff
- [ ] Update `createServer()` to use `DatabaseManager`
- [ ] Add new API endpoints (setup/teardown/databases)
- [ ] Update history endpoints to include database param
- [ ] Enhance health endpoint with database statuses
- [ ] Add `s3Prefix` support to `Orchestrator`
- [ ] Update archival flow for multi-database
- [ ] Write unit tests for `DatabaseManager`
- [ ] Write integration tests for multi-database scenarios
- [ ] Update existing tests for backward compatibility
- [ ] Update README with multi-database examples
- [ ] Update API documentation

## Migration Path

**From single database:**

```typescript
// Old (still works)
const app = await createServer({
  pool,
  port: 3001,
  enableHistory: true,
  historyConfig: { tables: ['users'] }
})

// New (recommended)
const app = await createServer({
  databases: [{
    name: 'main',
    pool,
    tables: ['users'],
    autoSetup: true
  }],
  globalRetention: { default: 90 },
  gracePeriod: 7,
  port: 3001
})
```

**API calls:**

```typescript
// Old
GET /api/history/users/123

// New
GET /api/history/main/users/123
```

## Future Enhancements

- Parallel archival execution (currently sequential)
- Database connection pooling optimization
- Metrics per database (Prometheus/OpenTelemetry)
- Dynamic database addition/removal without restart
- Per-database gracePeriod overrides
