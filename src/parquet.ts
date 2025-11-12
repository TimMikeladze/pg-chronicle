import { ParquetSchema, ParquetWriter } from '@dsnp/parquetjs'

// Define schema for audit log records
const auditSchema = new ParquetSchema({
	id: { type: 'UTF8' },
	table_name: { type: 'UTF8' },
	record_id: { type: 'UTF8' },
	operation: { type: 'UTF8' },
	changed_at: { type: 'TIMESTAMP_MILLIS' },
	old_data: { type: 'UTF8', optional: true }, // JSON stringified
	new_data: { type: 'UTF8', optional: true }, // JSON stringified
	changed_by: { type: 'UTF8', optional: true },
	metadata: { type: 'UTF8', optional: true }, // JSON stringified
})

export async function writeParquet(
	records: Array<Record<string, unknown>>,
	filePath: string,
): Promise<number> {
	const writer = await ParquetWriter.openFile(auditSchema, filePath, {
		compression: 'SNAPPY',
	} as never)

	for (const record of records) {
		// Convert JSONB fields to strings
		const row = {
			...record,
			old_data: record.old_data ? JSON.stringify(record.old_data) : null,
			new_data: record.new_data ? JSON.stringify(record.new_data) : null,
			metadata: record.metadata ? JSON.stringify(record.metadata) : null,
			changed_at:
				record.changed_at instanceof Date
					? record.changed_at.getTime()
					: new Date(record.changed_at as string).getTime(),
		}

		await writer.appendRow(row)
	}

	await writer.close()

	// Get file size
	const file = Bun.file(filePath)
	return file.size
}

export async function readParquet(
	filePath: string,
): Promise<Array<Record<string, unknown>>> {
	const { ParquetReader } = await import('@dsnp/parquetjs')
	const reader = await ParquetReader.openFile(filePath)
	const cursor = reader.getCursor()

	const records: Array<Record<string, unknown>> = []
	let record: unknown = null

	// biome-ignore lint/suspicious/noAssignInExpressions: This is the standard pattern for parquet cursor iteration
	while ((record = await cursor.next())) {
		// Parse JSON strings back to objects
		const typedRecord = record as Record<string, unknown>
		const parsed = {
			...typedRecord,
			old_data: typedRecord.old_data
				? JSON.parse(typedRecord.old_data as string)
				: null,
			new_data: typedRecord.new_data
				? JSON.parse(typedRecord.new_data as string)
				: null,
			metadata: typedRecord.metadata
				? JSON.parse(typedRecord.metadata as string)
				: null,
			changed_at: new Date(typedRecord.changed_at as number),
		}
		records.push(parsed)
	}

	await reader.close()
	return records
}
