import { parquetWriteFile } from 'hyparquet-writer'

export async function writeParquet(
	records: Array<Record<string, unknown>>,
	filePath: string,
): Promise<number> {
	// Prepare column data for hyparquet-writer
	const columnData = [
		{
			name: 'id',
			data: records.map((r) => String(r.id)),
			type: 'STRING' as const,
		},
		{
			name: 'table_name',
			data: records.map((r) => r.table_name as string),
			type: 'STRING' as const,
		},
		{
			name: 'record_id',
			data: records.map((r) => r.record_id as string),
			type: 'STRING' as const,
		},
		{
			name: 'operation',
			data: records.map((r) => r.operation as string),
			type: 'STRING' as const,
		},
		{
			name: 'changed_at',
			data: records.map((r) => {
				const date =
					r.changed_at instanceof Date
						? r.changed_at
						: new Date(r.changed_at as string)
				return date
			}),
			type: 'TIMESTAMP' as const,
		},
		{
			name: 'old_data',
			data: records.map((r) =>
				r.old_data ? JSON.stringify(r.old_data) : null,
			),
			type: 'STRING' as const,
		},
		{
			name: 'new_data',
			data: records.map((r) =>
				r.new_data ? JSON.stringify(r.new_data) : null,
			),
			type: 'STRING' as const,
		},
	]

	await parquetWriteFile({
		filename: filePath,
		columnData,
		codec: 'SNAPPY',
	})

	// Get file size
	const file = Bun.file(filePath)
	return file.size
}

export async function readParquet(
	filePath: string,
): Promise<Array<Record<string, unknown>>> {
	const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet')

	const file = await asyncBufferFromFile(filePath)
	const data = await parquetReadObjects({ file })

	// Parse JSON strings back to objects
	return data.map((record) => ({
		...record,
		old_data:
			record.old_data && typeof record.old_data === 'string'
				? JSON.parse(record.old_data)
				: null,
		new_data:
			record.new_data && typeof record.new_data === 'string'
				? JSON.parse(record.new_data)
				: null,
		changed_at: new Date(record.changed_at as number | string),
	}))
}
