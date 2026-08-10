import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { validateIdentifier } from './pg-history-validators'

// Cache schema per pool instance to avoid repeated round-trips.
// The schema does not change during a session; keying by pool avoids
// cross-contamination when multiple pools are used in the same process (tests).
const schemaCache = new WeakMap<Pool, string>()

/** List the child partition relnames of audit_log in the current schema. */
async function listPartitions(pool: Pool): Promise<string[]> {
	const result = await pool.query(
		`SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE p.relname = 'audit_log' AND n.nspname = current_schema()`,
	)
	const names = result.rows.map((r: { relname: string }) => r.relname)
	for (const name of names) validateIdentifier(name, 'table')
	return names
}

/** Derive a <=63-char, collision-resistant child index name for a partition. */
function childIndexName(partition: string, code: string): string {
	const name = `${partition}_${code}`
	if (name.length <= 63) return name
	const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
	return `pgh_${code}_${hash}`
}

/**
 * Create a partitioned-table index WITHOUT blocking writes:
 *   1. CREATE INDEX ... ON ONLY parent — creates an INVALID parent index with a
 *      brief lock and no data scan (the partitioned parent holds no rows itself).
 *   2. CREATE INDEX CONCURRENTLY on each partition — no write-blocking lock.
 *   3. ALTER INDEX parent ATTACH PARTITION child — marks the parent VALID once
 *      every partition's index is attached.
 * All steps use IF NOT EXISTS / an already-attached guard so re-runs are safe.
 * CREATE INDEX CONCURRENTLY cannot run in a transaction; these pool.query calls
 * are autocommit, which satisfies that.
 */
async function createAuditLogIndexPartitioned(
	pool: Pool,
	schemaPrefix: string,
	spec: { name: string; code: string; body: string },
	partitions: string[],
): Promise<void> {
	await pool.query(
		`CREATE INDEX IF NOT EXISTS ${spec.name} ON ONLY ${schemaPrefix}."audit_log" ${spec.body}`,
	)
	for (const part of partitions) {
		const child = childIndexName(part, spec.code)
		await pool.query(
			`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${child} ON ${schemaPrefix}."${part}" ${spec.body}`,
		)
		try {
			await pool.query(
				`ALTER INDEX ${schemaPrefix}.${spec.name} ATTACH PARTITION ${schemaPrefix}.${child}`,
			)
		} catch (err) {
			// Re-running after a prior successful attach errors because the child is
			// already a partition of the parent index — that is the desired state.
			const msg = err instanceof Error ? err.message : String(err)
			if (!/already/i.test(msg)) throw err
		}
	}
}

async function getSchemaPrefix(pool: Pool): Promise<string> {
	const cached = schemaCache.get(pool)
	if (cached) return cached

	const result = await pool.query('SELECT current_schema() as schema')
	const schema = result.rows[0]?.schema || 'public'
	validateIdentifier(schema, 'schema')
	const prefix = `"${schema}"`
	schemaCache.set(pool, prefix)
	return prefix
}

// Distinct from PgHistory's setup namespace (73616469) and the orchestrator's
// per-table namespace (73616468) so the three lock families never collide.
const ARCHIVER_SETUP_LOCK_NAMESPACE = 73_616_470

/** How long a waiter polls before giving up on the process doing the build. */
const SETUP_LOCK_WAIT_MS = 5 * 60_000
const SETUP_LOCK_POLL_MS = 250

const LOCK_SQL = `SELECT pg_try_advisory_lock(hashtextextended('pg-history:archiver-setup:' || current_schema(), $1::bigint)) AS acquired`
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtextextended('pg-history:archiver-setup:' || current_schema(), $1::bigint))`

/**
 * Take the archiver-setup lock without ever *blocking* on it.
 *
 * Deliberately `pg_try_advisory_lock` in a poll loop rather than the blocking
 * `pg_advisory_lock`. A session parked inside `pg_advisory_lock()` is running a
 * statement, and therefore has an open transaction — and `CREATE INDEX
 * CONCURRENTLY` (which the holder is about to run) waits for every such
 * transaction to finish. Blocking here would deadlock the two against each
 * other: the holder waiting for the waiter's transaction, the waiter waiting
 * for the holder's lock. Between polls this session is idle with no
 * transaction, which CIC is happy to ignore.
 */
export async function setupArchiverSchema(pool: Pool): Promise<void> {
	// Probe outside the lock: the steady state is "already set up", and taking a
	// lock on every boot would serialize an otherwise free no-op.
	if (await archiverSchemaIsCurrent(pool)) return

	const deadline = Date.now() + SETUP_LOCK_WAIT_MS
	for (;;) {
		const lockClient = await pool.connect()
		let acquired = false
		try {
			const result = await lockClient.query(LOCK_SQL, [
				ARCHIVER_SETUP_LOCK_NAMESPACE,
			])
			acquired = result.rows[0]?.acquired === true

			if (acquired) {
				// Re-probe under the lock: the process we queued behind has very
				// likely just finished, and without this the loser repeats every DDL
				// statement including the CONCURRENTLY index builds.
				if (await archiverSchemaIsCurrent(pool)) return
				await applyArchiverSchema(pool)
				return
			}
		} finally {
			if (acquired) {
				await lockClient
					.query(UNLOCK_SQL, [ARCHIVER_SETUP_LOCK_NAMESPACE])
					.catch(() => {})
			}
			lockClient.release()
		}

		// Someone else holds it. Watch for their result instead of queueing.
		if (await archiverSchemaIsCurrent(pool)) return
		if (Date.now() > deadline) {
			throw new Error(
				'setupArchiverSchema: timed out waiting for another process to finish archiver schema setup. ' +
					'Check for a stuck CREATE INDEX CONCURRENTLY on audit_log (pg_stat_activity).',
			)
		}
		await new Promise((resolve) => setTimeout(resolve, SETUP_LOCK_POLL_MS))
	}
}

/**
 * True when every archiver column, table and index is present and valid.
 * Critical on serverless cold starts: it collapses 10+ DDL roundtrips into one
 * probe query. Indexes are checked too — without them, archival queries fall
 * back to seq scans and the perf regression is invisible without an EXPLAIN.
 */
async function archiverSchemaIsCurrent(pool: Pool): Promise<boolean> {
	const probe = await pool.query(
		`SELECT
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_log'
          AND column_name IN ('archived_at', 's3_path', 'soft_deleted_at', 'claim_id', 'claimed_at',
                              'db_user', 'app_actor', 'client_addr')) AS col_count,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('audit_archive_metadata', 'audit_archival_stats')) AS tbl_count,
       -- Count only VALID + READY indexes. An interrupted CREATE INDEX
       -- CONCURRENTLY leaves an INVALID index of the same name; counting it
       -- (as pg_indexes would) makes the fast path skip rebuilding it forever.
       (SELECT COUNT(*) FROM pg_class i
          JOIN pg_index ix ON ix.indexrelid = i.oid
          JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE n.nspname = current_schema()
          AND ix.indisvalid AND ix.indisready
          AND i.relname IN (
            'idx_audit_log_archival',
            'idx_audit_log_unclaimed',
            'idx_audit_log_claimed',
            'idx_audit_log_soft_delete',
            'idx_audit_log_hard_delete',
            'idx_archive_metadata_table_date',
            'idx_archival_stats_updated'
          )) AS idx_count,
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_archive_metadata'
          AND column_name = 'checksum_sha256') AS meta_ck`,
	)
	const colCount = Number(probe.rows[0]?.col_count ?? 0)
	const tblCount = Number(probe.rows[0]?.tbl_count ?? 0)
	const idxCount = Number(probe.rows[0]?.idx_count ?? 0)
	const metaCk = Number(probe.rows[0]?.meta_ck ?? 0)
	return colCount === 8 && tblCount === 2 && idxCount === 7 && metaCk === 1
}

async function applyArchiverSchema(pool: Pool): Promise<void> {
	const s = await getSchemaPrefix(pool)
	const auditTable = `${s}."audit_log"`
	const metadataTable = `${s}."audit_archive_metadata"`
	const statsTable = `${s}."audit_archival_stats"`

	// The archiver extends the table PgHistory.setup() creates; it does not
	// create it. Enabling the archiver first (S3 variables set, no audited
	// tables) otherwise fails on the first ALTER with a bare
	// `relation "public.audit_log" does not exist`, which says nothing about
	// what the operator actually got wrong.
	const auditLogExists = await pool.query(
		`SELECT 1 FROM pg_class c
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = current_schema() AND c.relname = 'audit_log'`,
	)
	if (auditLogExists.rows.length === 0) {
		throw new Error(
			`pg-history: cannot set up the archiver — ${auditTable} does not exist. ` +
				'The archiver extends the audit table rather than creating it, so run ' +
				'PgHistory.setup() first (on the standalone server, that means setting ' +
				'PG_HISTORY_TABLES alongside the S3 configuration).',
		)
	}

	// Drop any INVALID archiver parent indexes (from an interrupted CONCURRENTLY
	// build) so the CREATE ... IF NOT EXISTS below actually rebuilds them instead
	// of skipping over the broken one. Dropping a partitioned parent index
	// cascades to its (also-invalid) partition indexes.
	const invalidIdx = await pool.query(
		`SELECT i.relname FROM pg_class i
       JOIN pg_index ix ON ix.indexrelid = i.oid
       JOIN pg_namespace n ON n.oid = i.relnamespace
     WHERE n.nspname = current_schema()
       AND NOT ix.indisvalid
       AND i.relname IN (
         'idx_audit_log_archival','idx_audit_log_unclaimed','idx_audit_log_claimed',
         'idx_audit_log_soft_delete','idx_audit_log_hard_delete',
         'idx_archive_metadata_table_date','idx_archival_stats_updated'
       )`,
	)
	for (const row of invalidIdx.rows as Array<{ relname: string }>) {
		validateIdentifier(row.relname, 'table')
		await pool.query(`DROP INDEX IF EXISTS ${s}."${row.relname}"`)
	}

	// Add archived_at column to audit_log
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
  `)

	// Add s3_path to track where record is backed up
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS s3_path TEXT
  `)

	// Add soft_deleted_at column
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS soft_deleted_at TIMESTAMPTZ
  `)

	// Attribution columns. PgHistory.setup() owns audit_log's shape and creates
	// these, but a cron-only deployment may run the archiver against a table
	// written by an older pg-history elsewhere. The archiver now copies these
	// into the Parquet archive, so it must be able to read them: assert they
	// exist rather than failing the batch with "column does not exist".
	await pool.query(
		`ALTER TABLE ${auditTable} ADD COLUMN IF NOT EXISTS db_user TEXT`,
	)
	await pool.query(
		`ALTER TABLE ${auditTable} ADD COLUMN IF NOT EXISTS app_actor TEXT`,
	)
	await pool.query(
		`ALTER TABLE ${auditTable} ADD COLUMN IF NOT EXISTS client_addr INET`,
	)

	// Claim columns implement non-blocking archival: a worker UPDATEs claim_id
	// on a batch of rows in one short transaction, releases the lock, performs
	// the slow S3 upload outside any transaction, then UPDATEs archived_at in a
	// second short transaction. Crashed workers leave stale claims that
	// PgHistoryArchiver.reapStaleClaims() resets via claimed_at < NOW() - interval.
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS claim_id UUID
  `)
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ
  `)

	// Archiver indexes on audit_log. audit_log is ALWAYS partitioned (PARTITION
	// BY LIST), so a plain CREATE INDEX would take a write-blocking ShareLock on
	// the parent and every partition. Because the audit trigger INSERTs into
	// audit_log synchronously inside every user DML, that would stall writes on
	// EVERY audited table for the whole build. Instead build each index without
	// blocking writes: CREATE INDEX ... ON ONLY parent (instant, invalid), then
	// CREATE INDEX CONCURRENTLY on each partition, then ATTACH. See createAuditLogIndex.
	const partitionCheck = await pool.query(
		`SELECT c.relkind = 'p' AS is_partitioned
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = current_schema() AND c.relname = 'audit_log'`,
	)
	const isPartitioned = partitionCheck.rows[0]?.is_partitioned === true

	const indexSpecs: Array<{ name: string; code: string; body: string }> = [
		{
			name: 'idx_audit_log_archival',
			code: 'arch',
			body: '(table_name, changed_at) WHERE archived_at IS NULL',
		},
		{
			name: 'idx_audit_log_unclaimed',
			code: 'uncl',
			body: '(table_name, changed_at) WHERE archived_at IS NULL AND claim_id IS NULL',
		},
		{
			name: 'idx_audit_log_claimed',
			code: 'clm',
			body: '(claimed_at) WHERE claim_id IS NOT NULL AND archived_at IS NULL',
		},
		{
			name: 'idx_audit_log_soft_delete',
			code: 'sd',
			body: '(archived_at) WHERE archived_at IS NOT NULL AND soft_deleted_at IS NULL',
		},
		{
			name: 'idx_audit_log_hard_delete',
			code: 'hd',
			body: '(soft_deleted_at) WHERE soft_deleted_at IS NOT NULL',
		},
	]

	if (isPartitioned) {
		const partitions = await listPartitions(pool)
		for (const spec of indexSpecs) {
			await createAuditLogIndexPartitioned(pool, s, spec, partitions)
		}
	} else {
		// Non-partitioned (legacy) audit_log: CONCURRENTLY is allowed and safe.
		for (const spec of indexSpecs) {
			await pool.query(
				`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON ${auditTable} ${spec.body}`,
			)
		}
	}

	// Create metadata tracking table. checksum_sha256 (base64 SHA-256 of the
	// uploaded Parquet) is persisted so hardDeletePurged can re-verify byte
	// integrity — not just existence — before permanently deleting audit rows.
	await pool.query(`
    CREATE TABLE IF NOT EXISTS ${metadataTable} (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      archive_date DATE NOT NULL,
      s3_path TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      file_size BIGINT NOT NULL,
      checksum_sha256 TEXT,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(s3_path)
    )
  `)
	// Idempotent upgrade for metadata tables created before checksum tracking.
	await pool.query(
		`ALTER TABLE ${metadataTable} ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT`,
	)

	// Create indexes on metadata table
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_archive_metadata_table_date
      ON ${metadataTable}(table_name, archive_date)
  `)

	// Create lightweight stats table to avoid scanning audit_log
	await pool.query(`
    CREATE TABLE IF NOT EXISTS ${statsTable} (
      table_name TEXT PRIMARY KEY,
      records_pending_archive BIGINT NOT NULL DEFAULT 0,
      records_pending_soft_delete BIGINT NOT NULL DEFAULT 0,
      records_pending_hard_delete BIGINT NOT NULL DEFAULT 0,
      oldest_unarchived_record TIMESTAMPTZ,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

	// Create index for stat queries
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_archival_stats_updated
      ON ${statsTable}(last_updated)
  `)
}

/**
 * Update archival stats for a table.
 * Scans audit_log rows matching the table with FILTER aggregates. On large tables
 * this can be expensive — call after archival runs, not on every request. The partial
 * indexes (idx_audit_log_archival, idx_audit_log_soft_delete, idx_audit_log_hard_delete)
 * help but don't eliminate the scan cost.
 */
export async function updateArchivalStats(
	pool: Pool,
	tableName: string,
	retentionDays: number,
	gracePeriodDays: number,
): Promise<void> {
	const s = await getSchemaPrefix(pool)
	const auditTable = `${s}."audit_log"`
	const statsTable = `${s}."audit_archival_stats"`

	// Get counts in a single query using FILTER aggregates.
	// Each FILTER is self-contained — no outer WHERE pre-filtering is needed and
	// adding one creates subtle correctness bugs (e.g. pending_soft_delete rows
	// may not satisfy changed_at < retentionCutoff but still need counting).
	// Cutoffs are computed from the DATABASE clock (NOW()), matching what the
	// archiver's processTable uses. Deriving them from the Node clock instead
	// would make these reported counts disagree with what archival processes
	// under app-server/DB clock skew.
	// This scans the full table partition, which is acceptable: this method runs
	// outside the advisory lock and is a reporting-only operation.
	const result = await pool.query(
		`SELECT
      COUNT(*) FILTER (WHERE archived_at IS NULL AND changed_at < NOW() - ($2 * INTERVAL '1 day')) as pending_archive,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL AND archived_at < NOW() - ($3 * INTERVAL '1 day') AND soft_deleted_at IS NULL AND s3_path IS NOT NULL) as pending_soft_delete,
      COUNT(*) FILTER (WHERE soft_deleted_at IS NOT NULL AND soft_deleted_at < NOW() - ($3 * INTERVAL '1 day')) as pending_hard_delete,
      MIN(changed_at) FILTER (WHERE archived_at IS NULL) as oldest_unarchived
    FROM ${auditTable}
    WHERE table_name = $1`,
		[tableName, retentionDays, gracePeriodDays],
	)

	// Destructure by name so a future query shape change doesn't silently
	// remap columns to the wrong INSERT slots.
	const {
		pending_archive = 0,
		pending_soft_delete = 0,
		pending_hard_delete = 0,
		oldest_unarchived = null,
	} = (result.rows[0] ?? {}) as {
		pending_archive?: number | string
		pending_soft_delete?: number | string
		pending_hard_delete?: number | string
		oldest_unarchived?: Date | null
	}

	// Upsert stats
	await pool.query(
		`INSERT INTO ${statsTable} (
      table_name,
      records_pending_archive,
      records_pending_soft_delete,
      records_pending_hard_delete,
      oldest_unarchived_record,
      last_updated
    ) VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (table_name) DO UPDATE SET
      records_pending_archive = EXCLUDED.records_pending_archive,
      records_pending_soft_delete = EXCLUDED.records_pending_soft_delete,
      records_pending_hard_delete = EXCLUDED.records_pending_hard_delete,
      oldest_unarchived_record = EXCLUDED.oldest_unarchived_record,
      last_updated = NOW()`,
		[
			tableName,
			pending_archive,
			pending_soft_delete,
			pending_hard_delete,
			oldest_unarchived,
		],
	)
}

/**
 * Get archival stats for all tables
 * Fast query - no audit_log scan required
 */
export async function getArchivalStats(pool: Pool): Promise<
	Array<{
		tableName: string
		recordsPendingArchive: number
		recordsPendingSoftDelete: number
		recordsPendingHardDelete: number
		oldestUnarchivedRecord: Date | null
		lastUpdated: Date
	}>
> {
	const s = await getSchemaPrefix(pool)
	const statsTable = `${s}."audit_archival_stats"`

	const result = await pool.query(`
    SELECT
      table_name,
      records_pending_archive,
      records_pending_soft_delete,
      records_pending_hard_delete,
      oldest_unarchived_record,
      last_updated
    FROM ${statsTable}
    ORDER BY records_pending_archive DESC
  `)

	return result.rows.map((row) => ({
		tableName: row.table_name,
		recordsPendingArchive: Number.parseInt(row.records_pending_archive, 10),
		recordsPendingSoftDelete: Number.parseInt(
			row.records_pending_soft_delete,
			10,
		),
		recordsPendingHardDelete: Number.parseInt(
			row.records_pending_hard_delete,
			10,
		),
		oldestUnarchivedRecord: row.oldest_unarchived_record,
		lastUpdated: row.last_updated,
	}))
}

export async function teardownArchiverSchema(pool: Pool): Promise<void> {
	const s = await getSchemaPrefix(pool)
	const auditTable = `${s}."audit_log"`
	const statsTable = `${s}."audit_archival_stats"`
	const metadataTable = `${s}."audit_archive_metadata"`

	// Drop stats table
	await pool.query(`DROP TABLE IF EXISTS ${statsTable} CASCADE`)

	// Drop metadata table
	await pool.query(`DROP TABLE IF EXISTS ${metadataTable} CASCADE`)

	// Drop archiver-owned indexes explicitly before dropping their columns.
	// We avoid CASCADE on DROP COLUMN so that user-defined indexes/views/
	// constraints that reference these columns surface as a loud error
	// instead of being silently destroyed.
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_archival`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_unclaimed`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_claimed`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_soft_delete`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_hard_delete`)

	await pool.query(
		`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS archived_at`,
	)
	await pool.query(`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS s3_path`)
	await pool.query(
		`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS soft_deleted_at`,
	)
	await pool.query(`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS claim_id`)
	await pool.query(`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS claimed_at`)
	// db_user / app_actor / client_addr are deliberately NOT dropped: they are
	// audit content owned by PgHistory.setup(), not archiver bookkeeping. The
	// archiver only ensures they exist.
}
