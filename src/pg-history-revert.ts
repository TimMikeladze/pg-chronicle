/**
 * Revert logic extracted from PgHistory.ts.
 *
 * Reverts an audit entry by running the inverse DML against the user table.
 * Handles schema drift detection, optional trigger suppression via
 * session_replication_role, and branches on the audited operation.
 *
 * This module is intentionally decoupled from the PgHistory class — it takes
 * a pool client and the derived identifiers as arguments so it can be unit-
 * tested without the full class.
 */
import type { PoolClient } from 'pg'
import { AuditEntryNotFoundError, RevertError } from './errors'
import { validateColumnNames } from './pg-history-validators'

export interface RevertArgs {
	client: PoolClient
	schema: string
	auditTable: string
	tableName: string
	recordId: string
	auditEntryId: string
	pkColumns: string[]
	suppressAuditTriggers: boolean
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
	} = args

	// Suppress audit triggers for this session if requested.
	// session_replication_role = 'replica' disables user-defined triggers
	// but keeps system triggers (e.g., FK/CHECK) enabled. SET LOCAL scopes
	// it to the current transaction so we don't leak state.
	if (suppressAuditTriggers) {
		await client.query(`SET LOCAL session_replication_role = 'replica'`)
	}

	// Fetch the audit entry
	const entryResult = await client.query(
		`SELECT * FROM ${auditTable}
		WHERE id = $1::bigint
		AND table_name = $2
		AND record_id = $3`,
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

	if (pkColumns.length === 0) {
		throw new RevertError(
			`Cannot revert table "${tableName}" - no primary key defined`,
		)
	}

	validateColumnNames(pkColumns)

	// Cross-check revert data columns against actual table columns
	// to prevent writing to unintended columns via crafted audit_log entries.
	// Also detect schema drift: if the live table has columns the audit data
	// doesn't know about AND those columns are NOT NULL without a default,
	// reverting will fail — warn early with a useful error.
	const revertDataForCheck = entry.old_data || entry.new_data || {}
	const dataColumns = Object.keys(revertDataForCheck)
	if (dataColumns.length > 0) {
		const colResult = await client.query(
			`SELECT column_name, is_nullable, column_default
			FROM information_schema.columns
			WHERE table_schema = $1 AND table_name = $2`,
			[schema, tableName],
		)
		const realColumnRows = colResult.rows as Array<{
			column_name: string
			is_nullable: 'YES' | 'NO'
			column_default: string | null
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
						r.column_default === null,
				)
				.map((r) => r.column_name)
			if (missingRequired.length > 0) {
				throw new RevertError(
					`Cannot revert DELETE: table "${tableName}" has required columns not present in the audit entry: ${missingRequired.join(', ')}. The schema has drifted since this entry was written and re-inserting would violate NOT NULL constraints.`,
				)
			}
		}
	}

	// Branch on operation type
	if (entry.operation === 'INSERT') {
		await revertInsert(client, tableName, pkColumns, entry, recordId)
	} else if (entry.operation === 'DELETE') {
		await revertDelete(client, tableName, entry, auditEntryId, recordId)
	} else {
		await revertUpdate(
			client,
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
	tableName: string,
	pkColumns: string[],
	entry: { new_data: Record<string, unknown> | null },
	recordId: string,
): Promise<void> {
	// Undo INSERT = DELETE the row
	const revertData = entry.new_data || {}
	const { whereClause, values } = buildPkWhereClause(pkColumns, revertData, 0)

	const deleteQuery = `
		DELETE FROM "${tableName}"
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
	tableName: string,
	entry: { old_data: Record<string, unknown> | null },
	auditEntryId: string,
	recordId: string,
): Promise<void> {
	// Undo DELETE = re-INSERT the row
	const revertData = entry.old_data
	if (!revertData || Object.keys(revertData).length === 0) {
		throw new RevertError(
			`No old_data available to revert DELETE for entry ${auditEntryId}`,
		)
	}

	const allColumns = Object.keys(revertData)
	validateColumnNames(allColumns)

	const columnList = allColumns.map((col) => `"${col}"`).join(', ')
	const placeholders = allColumns.map((_, idx) => `$${idx + 1}`).join(', ')
	const values = allColumns.map((col) => revertData[col])

	const insertQuery = `
		INSERT INTO "${tableName}" (${columnList})
		VALUES (${placeholders})
		RETURNING true as success
	`
	const insertResult = await client.query(insertQuery, values)
	if (!insertResult.rows || insertResult.rows.length === 0) {
		throw new RevertError(
			`Failed to revert DELETE for record ${recordId} in table ${tableName}`,
		)
	}
}

async function revertUpdate(
	client: PoolClient,
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
		UPDATE "${tableName}"
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
