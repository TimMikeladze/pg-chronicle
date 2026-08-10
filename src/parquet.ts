import { stat } from 'node:fs/promises'
import { parquetWriteFile } from 'hyparquet-writer'
import { consoleLogger, type Logger } from './logger'

/**
 * Convert an id value (which pg-js returns as a string for BIGINT by default)
 * to a native bigint for parquet INT64 column storage. Falls back gracefully
 * if the source is already a number or bigint.
 */
function toBigInt(value: unknown): bigint {
	if (typeof value === 'bigint') return value
	if (typeof value === 'number') return BigInt(value)
	if (typeof value === 'string') return BigInt(value)
	throw new Error(`Cannot convert value to bigint: ${String(value)}`)
}

/**
 * Serialize a jsonb payload for the Parquet STRING column. The archiver selects
 * old_data/new_data as ::text, so `value` is already exact JSON text — pass it
 * through verbatim to preserve integers > 2^53. Objects (from other callers /
 * tests) are stringified as a fallback. NULL stays NULL.
 */
function toJsonText(value: unknown): string | null {
	if (value == null) return null
	if (typeof value === 'string') return value
	return JSON.stringify(value)
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(
			`Parquet column "${field}" expected string, got ${typeof value}`,
		)
	}
	return value
}

/**
 * Nullable text column. The actor columns (`db_user`, `app_actor`,
 * `client_addr`) are legitimately NULL — an unset `pg_history.actor`, or a
 * connection over a local socket — and rows written by an older pg-history omit
 * them entirely, so `undefined` normalizes to NULL rather than throwing.
 */
function optionalString(value: unknown): string | null {
	if (value == null) return null
	return typeof value === 'string' ? value : String(value)
}

export async function writeParquet(
	records: Array<Record<string, unknown>>,
	filePath: string,
): Promise<number> {
	// Prepare column data for hyparquet-writer.
	// Store id as INT64 (native bigint) so DuckDB / Athena consumers don't have
	// to cast every id from STRING.
	const columnData = [
		{
			name: 'id',
			data: records.map((r) => toBigInt(r.id)),
			type: 'INT64' as const,
		},
		{
			name: 'table_name',
			data: records.map((r) => requireString(r.table_name, 'table_name')),
			type: 'STRING' as const,
		},
		{
			name: 'record_id',
			data: records.map((r) => requireString(r.record_id, 'record_id')),
			type: 'STRING' as const,
		},
		{
			name: 'operation',
			data: records.map((r) => requireString(r.operation, 'operation')),
			type: 'STRING' as const,
		},
		{
			name: 'changed_at',
			data: records.map((r) => {
				if (r.changed_at instanceof Date) return r.changed_at
				if (typeof r.changed_at === 'string') return new Date(r.changed_at)
				throw new Error(
					`Parquet column "changed_at" expected Date or string, got ${typeof r.changed_at}`,
				)
			}),
			type: 'TIMESTAMP' as const,
		},
		{
			name: 'old_data',
			data: records.map((r) => toJsonText(r.old_data)),
			type: 'STRING' as const,
		},
		{
			name: 'new_data',
			data: records.map((r) => toJsonText(r.new_data)),
			type: 'STRING' as const,
		},
		// Attribution. These MUST be archived: once a row is hard-deleted from
		// audit_log the Parquet file is the only remaining record of the change,
		// and an audit trail that cannot say who made the change is not an audit
		// trail. Nullable — see optionalString.
		{
			name: 'db_user',
			data: records.map((r) => optionalString(r.db_user)),
			type: 'STRING' as const,
		},
		{
			name: 'app_actor',
			data: records.map((r) => optionalString(r.app_actor)),
			type: 'STRING' as const,
		},
		{
			name: 'client_addr',
			data: records.map((r) => optionalString(r.client_addr)),
			type: 'STRING' as const,
		},
	]

	await parquetWriteFile({
		filename: filePath,
		columnData,
		codec: 'SNAPPY',
	})

	// Get file size (use fs.stat for Node.js compatibility)
	const fileStats = await stat(filePath)
	return fileStats.size
}

export async function readParquet(
	filePath: string,
	options: { logger?: Logger } = {},
): Promise<Array<Record<string, unknown>>> {
	const logger = options.logger ?? consoleLogger
	const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet')

	const file = await asyncBufferFromFile(filePath)
	const data = await parquetReadObjects({ file })

	// Parse JSON strings back to objects.
	// Parse failures are rare but surfaced explicitly: we log a warn with the
	// file path and the raw value is kept on the record so callers can still
	// recover partial data instead of silently discarding the row.
	return data.map((record, index) => {
		let oldData = null
		let newData = null

		if (record.old_data && typeof record.old_data === 'string') {
			try {
				oldData = JSON.parse(record.old_data)
			} catch (err) {
				logger.warn('Failed to parse old_data from parquet', {
					filePath,
					rowIndex: index,
					err,
				})
				oldData = { _raw: record.old_data, _parseError: true }
			}
		}

		if (record.new_data && typeof record.new_data === 'string') {
			try {
				newData = JSON.parse(record.new_data)
			} catch (err) {
				logger.warn('Failed to parse new_data from parquet', {
					filePath,
					rowIndex: index,
					err,
				})
				newData = { _raw: record.new_data, _parseError: true }
			}
		}

		return {
			...record,
			old_data: oldData,
			new_data: newData,
			changed_at: new Date(record.changed_at as number | string),
		}
	})
}
