/**
 * Revert logic extracted from PgChronicle.ts.
 *
 * Reverts an audit entry by running the inverse DML against the user table.
 * Handles schema drift detection, optional trigger suppression via
 * session_replication_role, and branches on the audited operation.
 *
 * This module is intentionally decoupled from the PgChronicle class — it takes
 * a pool client and the derived identifiers as arguments so it can be unit-
 * tested without the full class.
 */
import type { PoolClient } from 'pg'
import { AuditEntryNotFoundError, RevertError } from './errors'
import {
	validateColumnNames,
	validateIdentifier,
} from './pg-chronicle-validators'

export interface RevertArgs {
	client: PoolClient
	schema: string
	auditTable: string
	tableName: string
	recordId: string
	auditEntryId: string
	pkColumns: string[]
	suppressAuditTriggers: boolean
	/** When true, the query filters out soft-deleted audit entries. */
	hasSoftDeleteColumn?: boolean
}

/**
 * Execute the revert inside the caller-provided transaction.
 * Caller is responsible for BEGIN/COMMIT/ROLLBACK around this call.
 */
export async function executeRevert(args: RevertArgs): Promise<void> {
	const {
		client,
		schema,
		auditTable,
		tableName,
		recordId,
		auditEntryId,
		pkColumns,
		suppressAuditTriggers,
		hasSoftDeleteColumn,
	} = args

	// Self-defend: validate tableName even if the caller already checked an allowlist.
	// executeRevert is a public export — callers may pass tableName from untrusted sources.
	validateIdentifier(tableName, 'table')

	// Suppress audit triggers for this session if requested.
	// session_replication_role = 'replica' disables user-defined triggers
	// but keeps system triggers (e.g., FK/CHECK) enabled. SET LOCAL scopes
	// it to the current transaction so we don't leak state.
	// Requires SUPERUSER or the pg_replication role (PostgreSQL 16+).
	if (suppressAuditTriggers) {
		try {
			await client.query(`SET LOCAL session_replication_role = 'replica'`)
		} catch (err) {
			const code = (err as { code?: string }).code
			if (code === '42501') {
				throw new RevertError(
					'Cannot suppress audit triggers: the database user lacks the required privilege. ' +
						'Grant the pg_replication role (PostgreSQL 16+) or SUPERUSER, ' +
						'or pass suppressAuditTriggers: false to allow revert operations to be re-audited.',
				)
			}
			throw err
		}
	}

	// Fetch the audit entry. When the archiver schema is present, exclude
	// soft-deleted entries — a row pending hard deletion should not be used as a
	// revert source (the backup may already be on its way to S3 and the DB row
	// may disappear at any time).
	const softDeleteFilter = hasSoftDeleteColumn
		? ' AND soft_deleted_at IS NULL'
		: ''
	const entryResult = await client.query(
		`SELECT * FROM ${auditTable}
		WHERE id = $1::bigint
		AND table_name = $2
		AND record_id = $3${softDeleteFilter}`,
		[auditEntryId, tableName, recordId],
	)
	const [entry] = entryResult.rows as Array<{
		id: number
		table_name: string
		record_id: string
		operation: string
		old_data: Record<string, unknown> | null
		new_data: Record<string, unknown> | null
	}>

	if (!entry) {
		throw new AuditEntryNotFoundError(auditEntryId, tableName, recordId)
	}

	// TRUNCATE is recorded as a single statement-level marker with no OLD/NEW
	// payload, so there is nothing to restore from. Say that plainly — falling
	// through to the UPDATE branch produced a misleading "no old_data available".
	if (entry.operation === 'TRUNCATE') {
		throw new RevertError(
			`Cannot revert entry ${auditEntryId}: it records a TRUNCATE of "${tableName}". ` +
				'TRUNCATE fires a statement-level trigger with no per-row data, so the ' +
				'audit trail marks that the wipe happened but cannot reconstruct the rows. ' +
				'Restore from a database backup or from the archived Parquet files ' +
				'(PgChronicleArchiver.listArchives / readArchive).',
		)
	}

	if (pkColumns.length === 0) {
		throw new RevertError(
			`Cannot revert table "${tableName}" - no primary key defined`,
		)
	}

	validateColumnNames(pkColumns)

	// Pre-flight: ensure every PK column is present in the audit data before
	// entering the SQL path. buildPkWhereClause would otherwise throw mid-
	// transaction with a less-actionable error. Only INSERT (inverse: DELETE
	// WHERE pk) and UPDATE (inverse: UPDATE WHERE pk) reverts need the PK;
	// DELETE reverts re-INSERT whole rows and don't build a PK where clause.
	if (entry.operation === 'INSERT' || entry.operation === 'UPDATE') {
		const revertSource =
			entry.operation === 'INSERT' ? entry.new_data : entry.old_data
		if (revertSource) {
			const missingPk = pkColumns.filter(
				(col) => revertSource[col] === undefined,
			)
			if (missingPk.length > 0) {
				throw new RevertError(
					`Cannot revert ${entry.operation} for entry ${auditEntryId}: primary key column(s) [${missingPk.join(', ')}] missing from audit data for table "${tableName}". The audit entry may be corrupted or from a schema that predates the current primary key.`,
				)
			}
		}
	}

	// Cross-check revert data columns against actual table columns
	// to prevent writing to unintended columns via crafted audit_log entries.
	// Also detect schema drift: if the live table has columns the audit data
	// doesn't know about AND those columns are NOT NULL without a default,
	// reverting will fail — warn early with a useful error.
	const revertDataForCheck = entry.old_data || entry.new_data || {}
	const dataColumns = Object.keys(revertDataForCheck)
	if (dataColumns.length > 0) {
		const colResult = await client.query(
			`SELECT column_name, is_nullable, column_default, is_generated, identity_generation
			FROM information_schema.columns
			WHERE table_schema = $1 AND table_name = $2`,
			[schema, tableName],
		)
		const realColumnRows = colResult.rows as Array<{
			column_name: string
			is_nullable: 'YES' | 'NO'
			column_default: string | null
			is_generated: 'ALWAYS' | 'NEVER' | string
			identity_generation: 'ALWAYS' | 'BY DEFAULT' | null
		}>
		const realColumnNames = new Set(realColumnRows.map((r) => r.column_name))
		const unknownColumns = dataColumns.filter((c) => !realColumnNames.has(c))
		if (unknownColumns.length > 0) {
			throw new RevertError(
				`Revert data contains columns not in table "${tableName}": ${unknownColumns.join(', ')}. The table schema may have drifted since this audit entry was written.`,
			)
		}

		// For DELETE revert (re-INSERT), warn if live table has required columns
		// not in the audit data — the INSERT will fail at the PG level with
		// a less-clear error, so surface it here.
		if (entry.operation === 'DELETE') {
			const auditColumnSet = new Set(dataColumns)
			const missingRequired = realColumnRows
				.filter(
					(r) =>
						!auditColumnSet.has(r.column_name) &&
						r.is_nullable === 'NO' &&
						r.column_default === null &&
						// GENERATED ALWAYS columns cannot be supplied — exclude from check
						r.identity_generation !== 'ALWAYS' &&
						r.is_generated !== 'ALWAYS',
				)
				.map((r) => r.column_name)
			if (missingRequired.length > 0) {
				throw new RevertError(
					`Cannot revert DELETE: table "${tableName}" has required columns not present in the audit entry: ${missingRequired.join(', ')}. The schema has drifted since this entry was written and re-inserting would violate NOT NULL constraints.`,
				)
			}
		}

		// Collect columns that are GENERATED ALWAYS — they cannot be supplied in INSERT
		const generatedAlwaysColumns = new Set(
			realColumnRows
				.filter(
					(r) =>
						r.identity_generation === 'ALWAYS' || r.is_generated === 'ALWAYS',
				)
				.map((r) => r.column_name),
		)

		if (entry.operation === 'DELETE' && generatedAlwaysColumns.size > 0) {
			// Pass generated column set so revertDelete can exclude them from INSERT
			await revertDelete(
				client,
				schema,
				tableName,
				entry,
				auditEntryId,
				recordId,
				generatedAlwaysColumns,
			)
			return
		}
	}

	// Branch on operation type
	if (entry.operation === 'INSERT') {
		await revertInsert(client, schema, tableName, pkColumns, entry, recordId)
	} else if (entry.operation === 'DELETE') {
		await revertDelete(
			client,
			schema,
			tableName,
			entry,
			auditEntryId,
			recordId,
			new Set(),
		)
	} else {
		await revertUpdate(
			client,
			schema,
			tableName,
			pkColumns,
			entry,
			auditEntryId,
			recordId,
		)
	}
}

async function revertInsert(
	client: PoolClient,
	schema: string,
	tableName: string,
	pkColumns: string[],
	entry: { new_data: Record<string, unknown> | null },
	recordId: string,
): Promise<void> {
	// Undo INSERT = DELETE the row
	const revertData = entry.new_data || {}
	const { whereClause, values } = buildPkWhereClause(pkColumns, revertData, 0)

	const deleteQuery = `
		DELETE FROM "${schema}"."${tableName}"
		WHERE ${whereClause}
		RETURNING true as success
	`
	const deleteResult = await client.query(deleteQuery, values)
	if (!deleteResult.rows || deleteResult.rows.length === 0) {
		throw new RevertError(
			`Failed to revert INSERT for record ${recordId} in table ${tableName} - row not found`,
		)
	}
}

async function revertDelete(
	client: PoolClient,
	schema: string,
	tableName: string,
	entry: { old_data: Record<string, unknown> | null },
	auditEntryId: string,
	recordId: string,
	generatedAlwaysColumns: Set<string>,
): Promise<void> {
	// Undo DELETE = re-INSERT the row
	const revertData = entry.old_data
	if (!revertData || Object.keys(revertData).length === 0) {
		throw new RevertError(
			`No old_data available to revert DELETE for entry ${auditEntryId}`,
		)
	}

	// Exclude GENERATED ALWAYS columns — PostgreSQL forbids supplying values for them.
	// SERIAL/IDENTITY BY DEFAULT columns CAN be overridden, so we include those.
	const allColumns = Object.keys(revertData).filter(
		(col) => !generatedAlwaysColumns.has(col),
	)

	if (allColumns.length === 0) {
		throw new RevertError(
			`Cannot revert DELETE for entry ${auditEntryId}: all audited columns in table "${tableName}" are GENERATED ALWAYS. ` +
				'PostgreSQL does not allow supplying values for generated columns. ' +
				'The row will be re-created by the sequence/generation expression if inserted without explicit column values.',
		)
	}

	validateColumnNames(allColumns)

	const columnList = allColumns.map((col) => `"${col}"`).join(', ')
	const placeholders = allColumns.map((_, idx) => `$${idx + 1}`).join(', ')
	const values = allColumns.map((col) => revertData[col])

	const insertQuery = `
		INSERT INTO "${schema}"."${tableName}" (${columnList})
		VALUES (${placeholders})
		RETURNING true as success
	`
	let insertResult: { rows: unknown[] }
	try {
		insertResult = await client.query(insertQuery, values)
	} catch (err) {
		const code = (err as { code?: string }).code
		if (code === '23505') {
			throw new RevertError(
				`Cannot revert DELETE for record ${recordId} in table "${tableName}": a row with the same key already exists (unique constraint violation). The record was likely re-created after the audited DELETE.`,
			)
		}
		if (code === '23503') {
			throw new RevertError(
				`Cannot revert DELETE for record ${recordId} in table "${tableName}": foreign key constraint violation — referenced rows may no longer exist.`,
			)
		}
		throw err
	}
	if (!insertResult.rows || insertResult.rows.length === 0) {
		throw new RevertError(
			`Failed to revert DELETE for record ${recordId} in table ${tableName}`,
		)
	}
}

async function revertUpdate(
	client: PoolClient,
	schema: string,
	tableName: string,
	pkColumns: string[],
	entry: { old_data: Record<string, unknown> | null },
	auditEntryId: string,
	recordId: string,
): Promise<void> {
	// UPDATE: restore old_data
	const revertData = entry.old_data
	if (!revertData || Object.keys(revertData).length === 0) {
		throw new RevertError(
			`No old_data available to revert for entry ${auditEntryId}`,
		)
	}

	const columns = Object.keys(revertData).filter((k) => !pkColumns.includes(k))
	if (columns.length === 0) {
		throw new RevertError(
			`Cannot revert UPDATE for entry ${auditEntryId}: no non-primary-key columns found in audit data for table "${tableName}". The audited row may contain only primary key columns.`,
		)
	}
	validateColumnNames(columns)

	const setClauses = columns
		.map((col, idx) => `"${col}" = $${idx + 1}`)
		.join(', ')
	const values: unknown[] = columns.map((col) => revertData[col])

	const { whereClause, values: pkValues } = buildPkWhereClause(
		pkColumns,
		revertData,
		values.length,
	)
	values.push(...pkValues)

	const updateQuery = `
		UPDATE "${schema}"."${tableName}"
		SET ${setClauses}
		WHERE ${whereClause}
		RETURNING true as success
	`

	const updateResult = await client.query(updateQuery, values)
	if (!updateResult.rows || updateResult.rows.length === 0) {
		throw new RevertError(
			`Failed to revert record ${recordId} in table ${tableName} - no rows updated`,
		)
	}
}

function buildPkWhereClause(
	pkColumns: string[],
	data: Record<string, unknown>,
	paramOffset: number,
): { whereClause: string; values: unknown[] } {
	const values: unknown[] = []
	const clauses = pkColumns.map((col) => {
		const value = data[col]
		if (value === undefined) {
			throw new RevertError(
				`Primary key column "${col}" not found in audit data`,
			)
		}
		values.push(value)
		return `"${col}" = $${paramOffset + values.length}`
	})
	return { whereClause: clauses.join(' AND '), values }
}
