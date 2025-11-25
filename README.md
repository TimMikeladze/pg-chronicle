# pg-history

**PostgreSQL audit trails with automated archival**

Production-ready change tracking, compliance-ready audit logs, and zero-maintenance PostgreSQL triggers. Includes automated S3 archival and retention management. Uses the standard `pg` package for maximum compatibility.

[![npm version](https://img.shields.io/npm/v/pg-history.svg)](https://www.npmjs.com/package/pg-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

---

## Why pg-history?

**Stop writing PostgreSQL triggers by hand.** pg-history gives you production-grade audit logging with a simple TypeScript API, plus automated archival to keep your database lean.

### What you get:
- **Zero trigger maintenance** - No SQL to write, test, or debug
- **Bulletproof reliability** - Triggers execute atomically within transactions
- **Automated archival** - S3 archival with configurable retention policies
- **Compliance-ready** - Immutable audit trails with full change history
- **Flexible architecture** - Works with any primary key strategy (single, composite, or none)
- **Performance at scale** - Partitioned storage, GIN indexes, cursor pagination
- **REST API with OpenAPI** - Built-in Hono server for monitoring and management

### Perfect for:
- ✅ Compliance requirements (SOC2, HIPAA, GDPR audit trails)
- ✅ Debugging production data changes ("who changed this?")
- ✅ Building rollback/undo features
- ✅ Forensic analysis and change investigation
- ✅ Multi-tenant applications with user tracking
- ✅ Long-term audit retention with automated archival

### vs. Manual Triggers

| Manual Triggers | pg-history |
|----------------|-----------|
| Write complex PL/pgSQL for each table | One-line setup per table |
| Test trigger logic manually | Battle-tested, 20+ test scenarios |
| Handle primary key edge cases yourself | Automatic support for single, composite, no-PK tables |
| Build pagination and search from scratch | Cursor pagination and full-text search included |
| Maintain trigger code across schema changes | Automatic JSONB storage adapts to schema |
| Implement revert logic per table | Built-in revert with transaction safety |

---

## Features

### Core Audit Logging
- 🔍 **Automatic Change Tracking** - PostgreSQL triggers capture INSERT/UPDATE/DELETE operations atomically
- 📊 **Partitioned Storage** - Efficient table partitioning with JSONB data compression
- 👤 **User Context** - Track who made changes with customizable metadata
- 🔄 **Revert Operations** - Roll back records to any previous version
- 🔎 **Full-Text Search** - Search across all history data with flexible filters
- ⚡ **High Performance** - GIN indexes, cursor pagination, optimized for millions of audit records
- 🔑 **Flexible Primary Keys** - Supports single, composite, or no primary keys
- 🔒 **Transaction Safety** - All operations respect PostgreSQL transaction boundaries
- 📦 **Standard PostgreSQL** - Uses the `pg` package for broad Node.js runtime compatibility

### Automated Archival
- 📦 **S3 Archival** - Automatically archive old audit records to S3-compatible storage
- ⏰ **Retention Policies** - Configure retention periods per table or globally
- 🗑️ **Soft/Hard Delete** - Grace period before permanent deletion
- 🔄 **Batch Processing** - Efficient batched archival with configurable batch sizes
- 🎯 **Table Discovery** - Automatically discovers tables with audit triggers (no table scan required)

### API & Management
- 🌐 **REST API** - Built-in Hono server with health checks and OpenAPI documentation
- 🔐 **JWT Authentication** - Optional JWT auth for API endpoints
- 📊 **OpenAPI Docs** - Interactive API documentation at `/openapi`
- 🏥 **Health Checks** - Monitor archival status and performance

## Limitations

- **TRUNCATE operations are not audited** - PostgreSQL TRUNCATE bypasses row-level triggers. Use DELETE instead if audit trail is required.
- **Schema changes** - Adding/removing columns from tracked tables doesn't require migration (JSONB storage adapts automatically), but changing primary keys requires re-running setup.
- **Revert requires primary key** - Tables without primary keys cannot use the revert feature (no reliable way to identify specific rows).

## Installation

```bash
bun add pg-history
```

## Archival Setup

pg-history includes a CLI tool for automated archival of old audit records to S3.

### 1. Create Configuration File

```bash
cp archiver.config.example.json archiver.config.json
```

Edit `archiver.config.json`:

```json
{
  "database": {
    "url": "postgres://user:password@localhost:5432/your_database"
  },
  "s3": {
    "bucket": "your-audit-archives",
    "endpoint": "https://s3.amazonaws.com",
    "region": "us-west-2",
    "accessKeyId": "your-access-key",
    "secretAccessKey": "your-secret-key"
  },
  "retention": {
    "default": 90,
    "tables": {
      "sensitive_table": 30,
      "high_volume_table": 7
    }
  },
  "gracePeriod": 7,
  "batchSize": 10000,
  "healthPort": 3001
}
```

### 2. Run Archiver

```bash
# Archive all tables
bun run cli.ts --config ./archiver.config.json

# Dry run (preview what would be archived)
bun run cli.ts --dry-run

# Archive specific table only
bun run cli.ts --table users

# Custom health check port
bun run cli.ts --health-port 3002
```

### 3. API Endpoints

The archiver starts a REST API server with:

- `GET /health` - Health check endpoint
- `GET /openapi` - OpenAPI documentation

### 4. JWT Authentication (Optional)

Enable JWT authentication by setting the `JWT_SECRET` environment variable:

```bash
JWT_SECRET="your-secret-key" bun run cli.ts
```

When enabled:
- All `/api/*` endpoints require a valid JWT token
- Public endpoints (`/health`, `/openapi`) remain accessible
- Send requests with: `Authorization: Bearer <your-jwt-token>`

### Archival Process

The archiver follows this workflow:

1. **Discovery** - Finds tables with audit triggers (queries `pg_trigger` catalog, not audit log)
2. **Archival** - Moves old records to S3 based on retention policy
3. **Soft Delete** - Marks archived records as deleted (keeps for grace period)
4. **Hard Delete** - Permanently removes records past grace period

**Retention Example:**
- Record created: Day 0
- Retention period: 90 days
- Archived to S3: Day 90
- Soft deleted: Day 90
- Hard deleted: Day 97 (90 + 7 day grace period)

## Quick Start

```typescript
import { Pool } from 'pg';
import { PgHistory } from 'pg-history';

// Connect to your database
const pool = new Pool({ connectionString: 'postgres://localhost:5432/mydb' });

// Initialize with tables to track
const history = new PgHistory({
  pool,
  tables: ['users', 'orders', 'payments']
});

// One-time setup (creates triggers and audit tables)
await history.setup();

// That's it! All changes are now automatically tracked.
// Your application code continues working normally:

await pool.query(
  'INSERT INTO users (id, name, email, role) VALUES ($1, $2, $3, $4)',
  [1, 'Alice Johnson', 'alice@example.com', 'admin']
);

await pool.query(
  'UPDATE users SET role = $1 WHERE id = $2',
  ['superadmin', 1]
);

// Query what changed
const userHistory = await history.getHistory('users', '1');
console.log(userHistory.data);
// [
//   { operation: 'UPDATE', old_data: { role: 'admin' }, new_data: { role: 'superadmin' }, ... },
//   { operation: 'INSERT', new_data: { id: 1, name: 'Alice Johnson', ... }, ... }
// ]

// Search across all tracked changes
const results = await history.search({
  tables: ['users', 'orders'],
  query: 'alice@example.com',
  dateFrom: new Date('2024-01-01')
});

// Revert to a previous version
await history.revert('users', '1', userHistory.data[1].id);
// User role is now back to 'admin'
```

## Usage Examples

### Production Setup with User Tracking

```typescript
import { Pool } from 'pg';
import { PgHistory } from 'pg-history';

// Initialize once at app startup
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const history = new PgHistory({
  pool,
  tables: ['users', 'orders', 'payments', 'subscriptions']
});

await history.setup();

// In your API middleware/routes
async function handleRequest(req: Request, userId: string) {
  // Set user context for audit trail
  await history.setUser(userId, {
    ip: req.headers.get('x-forwarded-for'),
    userAgent: req.headers.get('user-agent'),
    requestId: crypto.randomUUID()
  });

  // All database changes in this request are now tracked with user context
  await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [userId]);

  // Clear user context after request
  await history.clearUser();
}
```

### Investigating Changes (Compliance & Debugging)

```typescript
// "Who changed this user's role?"
const userChanges = await history.getHistory('users', '123');

for (const change of userChanges.data) {
  if (change.oldData?.role !== change.newData?.role) {
    console.log(`Role changed by ${change.changedBy} at ${change.changedAt}`);
    console.log(`From: ${change.oldData?.role} → To: ${change.newData?.role}`);
    console.log('Metadata:', change.metadata);
  }
}

// Search for suspicious activity
const suspiciousChanges = await history.search({
  tables: ['users', 'payments'],
  operation: 'DELETE',
  dateFrom: new Date('2024-01-01'),
  changedBy: 'admin-123'
});
```

### Building Undo/Rollback Features

```typescript
// Get change history for a record
const orderHistory = await history.getHistory('orders', 'order-456', {
  order: 'desc',
  limit: 10
});

// Show user a list of previous versions
for (const version of orderHistory.data) {
  console.log(`${version.changedAt}: ${version.operation} by ${version.changedBy}`);
}

// User selects a version to restore
const targetVersion = orderHistory.data[3];
await history.revert('orders', 'order-456', targetVersion.id);

// The revert itself is audited!
const latest = await history.getHistory('orders', 'order-456', { limit: 1 });
console.log(latest.data[0].metadata); // { revertedFrom: 'audit-entry-789' }
```

### Advanced Search & Filtering

```typescript
// Full-text search across multiple tables
const results = await history.search({
  tables: ['users', 'orders', 'payments'],
  query: 'alice@example.com',
  limit: 50
});

// Filter by operation type
const deletions = await history.search({
  tables: ['users'],
  operation: 'DELETE',
  dateFrom: new Date('2024-01-01'),
  dateTo: new Date('2024-12-31')
});

// Track changes by specific user
const adminChanges = await history.search({
  tables: ['users', 'orders'],
  changedBy: 'admin-123',
  dateFrom: new Date('2024-11-01')
});

// Pagination for large result sets
let cursor: string | null = null;
const allChanges = [];

do {
  const page = await history.search({
    tables: ['orders'],
    limit: 1000,
    cursor: cursor || undefined
  });

  allChanges.push(...page.data);
  cursor = page.nextCursor;
} while (cursor);
```

### Migration & Cleanup

```typescript
// Adding a new table to tracking
const history = new PgHistory({
  sql,
  tables: ['users', 'orders', 'new_table'] // Add new table
});

await history.setup(); // Idempotent - only sets up new_table trigger

// Removing history tracking entirely
await history.teardown(); // Removes all triggers and audit tables

// Clean shutdown
await history.close();
```

## API Reference

### Constructor

```typescript
new PgHistory(config: PgHistoryConfig)
```

**Options:**
- `tables: string[]` - (Required) List of tables to track
- `pool?: Pool` - Existing pg Pool connection
- `connection?: string` - PostgreSQL connection string (alternative to `pool`)

### Methods

#### `setup(): Promise<void>`
Creates audit infrastructure (tables, triggers, indexes). Idempotent and safe to call multiple times.

**Example:**
```typescript
await history.setup();
```

#### `setUser(userId: string, metadata?: Record<string, unknown>): Promise<void>`
Sets user context for subsequent operations. Context persists until `clearUser()` is called.

**Example:**
```typescript
await history.setUser('user-123', {
  ip: '192.168.1.1',
  action: 'api_call',
  requestId: 'req-456'
});
```

#### `clearUser(): Promise<void>`
Clears the current user context.

**Example:**
```typescript
await history.clearUser();
```

#### `getHistory(tableName: string, recordId: string, options?: GetHistoryOptions): Promise<PaginatedResult<AuditEntry>>`
Retrieves paginated history for a specific record.

**Options:**
- `limit?: number` - Results per page (default: 50, max: 1000)
- `cursor?: string` - Pagination cursor from previous response
- `order?: 'asc' | 'desc'` - Sort order (default: 'desc')

**Returns:**
```typescript
{
  data: AuditEntry[],
  nextCursor: string | null,
  hasMore: boolean
}
```

**Example:**
```typescript
const result = await history.getHistory('users', '123', {
  limit: 20,
  order: 'desc'
});
```

#### `search(options: SearchOptions): Promise<PaginatedResult<AuditEntry>>`
Searches across history with flexible filtering.

**Options:**
- `tables: string[]` - (Required) Tables to search
- `query?: string` - Full-text search query
- `operation?: 'INSERT' | 'UPDATE' | 'DELETE'` - Filter by operation type
- `dateFrom?: Date` - Start date filter
- `dateTo?: Date` - End date filter
- `changedBy?: string` - Filter by user ID
- `limit?: number` - Results per page (default: 100, max: 1000)
- `cursor?: string` - Pagination cursor

**Example:**
```typescript
const results = await history.search({
  tables: ['users', 'orders'],
  query: 'alice',
  operation: 'UPDATE',
  dateFrom: new Date('2024-01-01'),
  changedBy: 'admin-123',
  limit: 50
});
```

#### `revert(tableName: string, recordId: string, auditEntryId: string): Promise<void>`
Reverts a record to a previous version. The revert operation itself is audited.

**Note:** Requires the table to have a primary key.

**Example:**
```typescript
await history.revert('users', '123', 'audit-entry-456');
```

#### `teardown(): Promise<void>`
Removes all history tracking infrastructure (triggers, tables, functions). Idempotent.

**Example:**
```typescript
await history.teardown();
```

#### `close(): Promise<void>`
Closes the database connection (only if created by PgHistory).

**Example:**
```typescript
await history.close();
```

### Types

```typescript
interface AuditEntry {
  id: string;
  tableName: string;
  recordId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  changedAt: Date;
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  changedBy: string | null;
  metadata: Record<string, unknown> | null;
}

interface PaginatedResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

## How It Works

pg-history uses PostgreSQL's trigger system to automatically capture changes:

1. **Setup Phase**: Creates a partitioned `audit_log` table and installs triggers on your tracked tables
2. **Automatic Tracking**: Triggers fire on INSERT/UPDATE/DELETE, capturing old and new data as JSONB
3. **Zero Impact**: Your application code doesn't change - triggers work transparently
4. **Transaction Safety**: Audit entries are created in the same transaction as your data changes

### Architecture

```
Your Table (e.g., users)
         ↓
   [TRIGGER fires on change]
         ↓
   audit_log (partitioned by table)
         ↓
   ├── audit_log_users
   ├── audit_log_orders
   └── audit_log_payments
```

**Performance optimizations:**
- Table partitioning for efficient queries on specific tables
- GIN indexes on JSONB columns for fast full-text search
- Cursor-based pagination to handle millions of audit records
- Primary key caching to minimize system catalog queries

### What Gets Tracked

**Captured automatically:**
- Operation type (INSERT, UPDATE, DELETE)
- Timestamp (transaction time)
- Old data (for UPDATE and DELETE)
- New data (for INSERT and UPDATE)
- User ID (if set via `setUser()`)
- Custom metadata (if provided via `setUser()`)

**Not tracked:**
- TRUNCATE operations (PostgreSQL limitation - triggers don't fire)
- DDL changes (ALTER TABLE, etc.)
- Queries that don't modify data (SELECT)

## FAQ

### Does this work with existing tables?

Yes. Run `setup()` on existing tables - triggers are added non-destructively.

### What about performance overhead?

Minimal. Each change writes one row to the audit log (JSONB compression is efficient). Expect ~5-10% overhead for write-heavy workloads. Partitioning and indexes keep query performance fast.

### Can I use this with ORMs?

Yes. pg-history works at the database level, so it captures changes from any source: raw SQL, Drizzle, Prisma, etc.

### How do I handle schema migrations?

JSONB storage adapts automatically to column additions/removals. If you change primary keys, re-run `setup()` to recreate triggers.

### Can I audit changes from multiple applications?

Yes. Any application connecting to the database will have changes tracked. Use `setUser()` with application identifiers in metadata to distinguish sources.

### How long should I keep audit data?

Depends on compliance requirements. Consider archiving old audit data to cold storage (S3, Parquet files) for long-term retention.

### What PostgreSQL versions are supported?

PostgreSQL 12+ (requires partitioning and JSONB support). Tested on PostgreSQL 14, 15, and 16.

## Advanced Topics

### Composite Primary Keys

pg-history fully supports composite primary keys:

```typescript
// Table with composite PK: (tenant_id, user_id)
const history = new PgHistory({
  sql,
  tables: ['multi_tenant_users']
});

await history.setup(); // Automatically detects composite PK

// Record ID is concatenated with '|' delimiter
const changes = await history.getHistory('multi_tenant_users', 'tenant-1|user-123');
```

### Tables Without Primary Keys

Tables without primary keys use an MD5 hash of the row data as the record ID:

```typescript
// Works, but revert() is not available
const history = new PgHistory({
  sql,
  tables: ['log_events'] // No primary key
});

await history.setup();

// Can query history (record ID is hash of row)
const changes = await history.getHistory('log_events', '<hash>');

// Cannot revert (no way to identify specific row)
// await history.revert(...); // Throws error
```

### Transaction Safety

Audit log entries are created within the same transaction as your data changes:

```typescript
await sql.begin(async (tx) => {
  // Both succeed or both fail together
  await tx`UPDATE users SET balance = balance - 100 WHERE id = 1`;
  await tx`UPDATE users SET balance = balance + 100 WHERE id = 2`;
  // Audit entries for both updates are created atomically
});
```

If the transaction rolls back, audit entries are also rolled back.

### Custom Metadata Patterns

```typescript
// Track API requests
await history.setUser(userId, {
  requestId: req.headers.get('x-request-id'),
  endpoint: req.url,
  method: req.method
});

// Track background jobs
await history.setUser('system', {
  jobId: 'cleanup-job-123',
  jobType: 'data_cleanup',
  scheduledAt: new Date()
});

// Track admin actions
await history.setUser(adminId, {
  adminLevel: 'superuser',
  impersonating: targetUserId,
  reason: 'Support ticket #1234'
});
```

## Comparison with Alternatives

| Feature | pg-history | Manual Triggers | Application Logging |
|---------|-----------|----------------|-------------------|
| Setup complexity | One line per table | Complex PL/pgSQL | Moderate (code in every mutation) |
| Transaction safety | ✅ Atomic | ✅ Atomic | ❌ Can be bypassed |
| Captures all sources | ✅ Yes (any DB client) | ✅ Yes | ❌ Only instrumented code |
| Performance overhead | ~5-10% | ~5-10% | Varies (depends on implementation) |
| Maintenance burden | Low (library updates) | High (custom trigger code) | High (scattered across app) |
| Query/search | ✅ Built-in | Manual | Manual |
| Revert functionality | ✅ Built-in | Manual | Manual |
| Primary key flexibility | ✅ Single/composite/none | Manual handling | Manual handling |

## Contributing

Contributions are welcome! Please open an issue or PR on GitHub.

## Testing

Tests run against real PostgreSQL (no mocks):

```bash
# Start PostgreSQL
# Tests use database: pg_audit_test

bun test
```

## License

MIT

---

**Built with ❤️ for Bun developers who need audit trails without the trigger headaches.**
