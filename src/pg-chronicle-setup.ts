import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { Logger } from './logger'

/**
 * PG identifier limit is 63 chars. Prefixes used by PgChronicle eat part of
 * that budget; beyond the budget PG silently truncates, which lets two
 * long-named tables collide into the same partition/function/trigger.
 *
 * For names that overflow we substitute an 8-hex sha256-truncated suffix.
 * Collision probability is ~2^-32 per pair — effectively zero in practice.
 *
 * IMPORTANT: derived names must be stable across processes. Callers in
 * setup AND query paths (partitions, triggers, functions) must use this
 * same helper so creation and lookup agree.
 */
export function derivedIdentifier(prefix: string, tableName: string): string {
	const MAX_SUFFIX = 63 - prefix.length
	if (tableName.length <= MAX_SUFFIX) return `${prefix}${tableName}`
	const hash = createHash('sha256').update(tableName).digest('hex').slice(0, 8)
	return `${prefix}${hash}`
}

export function partitionNameFor(tableName: string): string {
	return derivedIdentifier('audit_log_', tableName)
}

export function triggerNameFor(tableName: string): string {
	return derivedIdentifier('audit_trigger_', tableName)
}

export function truncateTriggerNameFor(tableName: string): string {
	return derivedIdentifier('audit_truncate_', tableName)
}

export function triggerFuncNameFor(tableName: string): string {
	return derivedIdentifier('audit_trigger_func_', tableName)
}

export async function setupAuditTable(
	pool: Pool,
	auditTable: string,
	schema: string,
	logger: Logger,
): Promise<void> {
	logger.info('Setup phase: audit_log parent table', { schema })
	await pool.query(`
		CREATE TABLE IF NOT EXISTS ${auditTable} (
			id BIGSERIAL,
			table_name TEXT NOT NULL,
			record_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			old_data JSONB,
			new_data JSONB,
			db_user TEXT,
			app_actor TEXT,
			client_addr INET,
			PRIMARY KEY (id, table_name)
		) PARTITION BY LIST (table_name)
	`)

	// Actor columns capture WHO made each change — required for any audit trail.
	// ADD COLUMN IF NOT EXISTS makes this idempotent and upgrades an audit_log
	// created by an older version (pre-actor) in place. db_user = current_user,
	// app_actor = current_setting('pg_chronicle.actor'), client_addr =
	// inet_client_addr(); populated by the generated trigger functions.
	await pool.query(
		`ALTER TABLE ${auditTable} ADD COLUMN IF NOT EXISTS db_user TEXT`,
	)
	await pool.query(
		`ALTER TABLE ${auditTable} ADD COLUMN IF NOT EXISTS app_actor TEXT`,
	)
	await pool.query(
		`ALTER TABLE ${auditTable} ADD COLUMN IF NOT EXISTS client_addr INET`,
	)
}

export async function setupPartitions(
	pool: Pool,
	schema: string,
	tables: string[],
	logger: Logger,
): Promise<void> {
	logger.info('Setup phase: partitions', { count: tables.length })
	for (const tableName of tables) {
		const partitionName = partitionNameFor(tableName)

		const exists = await pool.query(
			'SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
			[schema, partitionName],
		)

		if (exists.rows.length === 0) {
			try {
				const ddlResult = await pool.query(
					`SELECT format(
						'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES IN (%L)',
						$1::text, $2::text, $1::text, $3::text, $4::text
					) AS ddl`,
					[schema, partitionName, 'audit_log', tableName],
				)
				await pool.query(ddlResult.rows[0].ddl)
			} catch (error) {
				throw new Error(
					`Failed to create partition for table "${tableName}": ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			logger.debug('Partition already exists, skipping', {
				partition: partitionName,
			})
		}
	}
}

export async function setupIndexes(
	pool: Pool,
	auditTable: string,
	logger: Logger,
): Promise<void> {
	logger.info('Setup phase: indexes')
	await pool.query(`
		CREATE INDEX IF NOT EXISTS idx_audit_old_data_gin
		ON ${auditTable} USING GIN (old_data jsonb_path_ops)
	`)
	await pool.query(`
		CREATE INDEX IF NOT EXISTS idx_audit_new_data_gin
		ON ${auditTable} USING GIN (new_data jsonb_path_ops)
	`)
	await pool.query(`
		CREATE INDEX IF NOT EXISTS idx_audit_changed_at
		ON ${auditTable} (changed_at DESC)
	`)
	await pool.query(`
		CREATE INDEX IF NOT EXISTS idx_audit_record_id
		ON ${auditTable} (table_name, record_id, changed_at DESC)
	`)
}
