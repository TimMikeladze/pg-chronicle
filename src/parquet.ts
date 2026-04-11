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

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(
			`Parquet column "${field}" expected string, got ${typeof value}`,
		)
	}
	return value
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
			data: records.map((r) =>
				r.old_data == null ? null : JSON.stringify(r.old_data),
			),
			type: 'STRING' as const,
		},
		{
			name: 'new_data',
			data: records.map((r) =>
				r.new_data == null ? null : JSON.stringify(r.new_data),
			),
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
