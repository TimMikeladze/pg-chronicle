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
		// id is now stored as INT64 in parquet (fix #12) — hyparquet returns
		// it as a bigint. Downstream consumers (DuckDB, Athena) get INT64 natively.
		expect(readRecords[0]?.id).toBe(123n)
		expect(readRecords[0]?.table_name).toBe('users')
		expect(readRecords[0]?.operation).toBe('INSERT')
	})

	test('stores id as INT64 so bigint values survive the round-trip', async () => {
		// Fix #12: id was previously stored as STRING, forcing downstream
		// consumers to cast from text. INT64 is the correct type for BIGSERIAL.
		const records = [
			{
				id: '9223372036854775807', // pg-js returns BIGSERIAL as string
				table_name: 'orders',
				record_id: 'order-huge',
				operation: 'INSERT' as const,
				changed_at: new Date('2025-06-01T00:00:00Z'),
				new_data: { amount: 42 },
				old_data: null,
			},
		]

		await writeParquet(records, testFile)
		const readRecords = await readParquet(testFile)

		expect(readRecords[0]?.id).toBe(9223372036854775807n)
	})

	test('writeParquet rejects records with non-string required fields', async () => {
		// Fix #27: blindly casting `r.table_name as string` hid type errors.
		// The sanitized writer should now throw with a clear message.
		const bad = [
			{
				id: '1',
				table_name: 123, // wrong type
				record_id: 'x',
				operation: 'INSERT',
				changed_at: new Date(),
				old_data: null,
				new_data: null,
			},
		] as unknown as Array<Record<string, unknown>>

		await expect(writeParquet(bad, testFile)).rejects.toThrow(/table_name/)
	})

	test('source declares id column as INT64, not STRING', async () => {
		// Fix #12: regression guard against a stray revert to STRING
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/parquet.ts', 'utf-8')

		const idDeclaration = source.slice(
			source.indexOf("name: 'id'"),
			source.indexOf("name: 'table_name'"),
		)
		expect(idDeclaration).toContain("type: 'INT64'")
		expect(idDeclaration).not.toContain("type: 'STRING'")
	})
})
