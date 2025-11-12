# pg-history

Audit, history and change tracking for PostgreSQL tables using triggers.

Built for Bun with native `Bun.sql` integration.

## Features

- 🔍 **Automatic Change Tracking** - PostgreSQL triggers capture INSERT/UPDATE/DELETE operations
- 📊 **Partitioned Storage** - Efficient partitioned history table with JSONB data
- 👤 **User Context** - Optional user tracking with metadata
- 🔄 **Revert Operations** - Roll back records to previous versions
- 🔎 **Full-Text Search** - Search across all history data with pagination
- ⚡ **High Performance** - GIN indexes, cursor pagination, native Bun.sql
- 🔑 **Flexible Primary Keys** - Supports single, composite, or no primary keys

## Limitations

- **TRUNCATE operations are not audited** - PostgreSQL TRUNCATE bypasses row-level triggers. Use DELETE instead if history trail is required.
- **Schema changes** - Adding/removing columns from tracked tables doesn't require migration (JSONB storage), but changing primary keys requires re-running setup.
- **Revert requires primary key** - Tables without primary keys cannot use the revert feature.

## Installation

```bash
bun add pg-history
```

## Quick Start

```typescript
import { PgHistory } from 'pg-history';

// Initialize
const history = new PgHistory({
  connection: 'postgres://localhost:5432/mydb',
  tables: ['users', 'orders']
});

// Setup history tracking infrastructure
await history.setup();

// Your app makes changes - they're automatically tracked
await sql`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`;

// Query history
const history = await history.getHistory('users', 'user-123');

// Search across tables
const results = await history.search({
  tables: ['users', 'orders'],
  query: 'alice@example.com'
});

// Revert to previous version
await history.revert('users', 'user-123', history.data[5].id);
```

## API

### `new PgHistory(config)`

Create audit instance with configuration:

```typescript
const history = new PgHistory({
  // Specify tables to track (required)
  tables: ['users', 'orders'],

  // Option 1: Use existing SQL connection
  sql: mySqlConnection,

  // Option 2: Provide connection string
  connection: 'postgres://localhost:5432/mydb',
});
```

### `await history.setup()`

Create history tracking infrastructure (tables, triggers, indexes). Idempotent - safe to call multiple times.

### `await history.setUser(userId, metadata?)`

Associate user context with subsequent operations:

```typescript
await history.setUser('user-123', {
  ip: '1.2.3.4',
  action: 'api_call'
});
```

### `await history.getHistory(table, recordId, options?)`

Get paginated history for a specific record:

```typescript
const history = await history.getHistory('users', '123', {
  limit: 50,
  cursor: 'last-id',
  order: 'desc' // or 'asc'
});

// Returns: { data: AuditEntry[], nextCursor: string | null, hasMore: boolean }
```

### `await history.search(options)`

Search across history data with filters:

```typescript
const results = await history.search({
  tables: ['users', 'orders'],
  query: 'alice', // full-text search
  operation: 'UPDATE',
  dateFrom: new Date('2024-01-01'),
  dateTo: new Date('2024-12-31'),
  changedBy: 'user-123',
  limit: 100,
  cursor: 'last-id'
});
```

### `await history.revert(table, recordId, auditEntryId)`

Revert record to previous version (operation is audited):

```typescript
await history.revert('users', '123', 'audit-entry-456');
```

### `await history.teardown()`

Remove all history tracking infrastructure (tables, triggers). Idempotent.

### `await history.close()`

Close database connection (only if connection created by PgHistory).

## Testing

Tests run against real PostgreSQL (no mocks):

```bash
# Start PostgreSQL
# Tests use database: pg_audit_test

bun test
```

## License

MIT
