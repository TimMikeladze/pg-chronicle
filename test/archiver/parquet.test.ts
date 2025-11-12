import { afterEach, describe, expect, test } from 'bun:test'
import { unlink } from 'node:fs/promises'
import { readParquet, writeParquet } from '../../src/parquet'

describe('Parquet Writing', () => {
	const testFile = '/tmp/test-archive.parquet'

	afterEach(async () => {
		try {
			await unlink(testFile)
		} catch {}
	})

	test('should write records to Parquet file', async () => {
		const records = [
			{
				id: '123',
				table_name: 'users',
				record_id: 'user-1',
				operation: 'INSERT',
				changed_at: new Date('2025-01-15T10:00:00Z'),
				new_data: { name: 'Alice', email: 'alice@example.com' },
				old_data: null,
				changed_by: 'user-123',
				metadata: { ip: '1.2.3.4' },
			},
			{
				id: '124',
				table_name: 'users',
				record_id: 'user-2',
				operation: 'UPDATE',
				changed_at: new Date('2025-01-15T10:05:00Z'),
				new_data: { name: 'Bob Updated', email: 'bob@example.com' },
				old_data: { name: 'Bob', email: 'bob@example.com' },
				changed_by: 'user-456',
				metadata: null,
			},
		]

		const bytes = await writeParquet(records, testFile)

		expect(bytes).toBeGreaterThan(0)
		expect(await Bun.file(testFile).exists()).toBe(true)
	})

	test('should read back written Parquet data', async () => {
		const records = [
			{
				id: '123',
				table_name: 'users',
				record_id: 'user-1',
				operation: 'INSERT',
				changed_at: new Date('2025-01-15T10:00:00Z'),
				new_data: { name: 'Alice' },
				old_data: null,
				changed_by: 'user-123',
				metadata: null,
			},
		]

		await writeParquet(records, testFile)
		const readRecords = await readParquet(testFile)

		expect(readRecords.length).toBe(1)
		expect(readRecords[0]?.id).toBe('123')
		expect(readRecords[0]?.table_name).toBe('users')
		expect(readRecords[0]?.operation).toBe('INSERT')
	})
})
