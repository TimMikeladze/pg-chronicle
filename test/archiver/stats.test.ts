import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import {
	getArchivalStats,
	setupArchiverSchema,
	updateArchivalStats,
} from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'

describe('Archival Stats', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('should update archival stats for a table', async () => {
		// Update stats for users table with 90 day retention
		await updateArchivalStats(pool, 'users', 90, 7)

		// Verify stats were created
		const result = await pool.query(
			`SELECT * FROM audit_archival_stats WHERE table_name = $1`,
			['users'],
		)

		expect(result.rows.length).toBe(1)
		const stats = result.rows[0]
		expect(stats.table_name).toBe('users')
		expect(
			Number.parseInt(stats.records_pending_archive, 10),
		).toBeGreaterThanOrEqual(0)
		expect(stats.last_updated).toBeDefined()
	})

	test('should get archival stats for all tables', async () => {
		// Update stats for multiple tables
		await updateArchivalStats(pool, 'users', 90, 7)
		await updateArchivalStats(pool, 'orders', 90, 7)

		// Get all stats
		const stats = await getArchivalStats(pool)

		expect(stats.length).toBeGreaterThanOrEqual(2)
		expect(stats[0]?.tableName).toBeDefined()
		expect(stats[0]?.recordsPendingArchive).toBeGreaterThanOrEqual(0)
	})

	test('should track pending archive count correctly', async () => {
		const retentionDays = 90
		const cutoff = new Date()
		cutoff.setDate(cutoff.getDate() - retentionDays)

		// Count records that should be archived
		const countResult = await pool.query(
			`SELECT COUNT(*) as count
       FROM audit_log
       WHERE table_name = 'users'
         AND changed_at < $1
         AND archived_at IS NULL`,
			[cutoff],
		)

		const expectedCount = Number.parseInt(countResult.rows[0].count, 10)

		// Update stats
		await updateArchivalStats(pool, 'users', retentionDays, 7)

		// Get stats
		const stats = await getArchivalStats(pool)
		const userStats = stats.find((s) => s.tableName === 'users')

		expect(userStats).toBeDefined()
		if (userStats) {
			expect(userStats.recordsPendingArchive).toBe(expectedCount)
		}
	})

	test('should update stats idempotently', async () => {
		// Update stats twice
		await updateArchivalStats(pool, 'users', 90, 7)
		await updateArchivalStats(pool, 'users', 90, 7)

		// Should only have one row
		const result = await pool.query(
			`SELECT COUNT(*) as count FROM audit_archival_stats WHERE table_name = $1`,
			['users'],
		)

		expect(Number.parseInt(result.rows[0].count, 10)).toBe(1)
	})

	test('should track oldest unarchived record', async () => {
		await updateArchivalStats(pool, 'users', 90, 7)

		const stats = await getArchivalStats(pool)
		const userStats = stats.find((s) => s.tableName === 'users')

		expect(userStats).toBeDefined()
		// Should have oldest record from test data
		if (
			userStats?.recordsPendingArchive &&
			userStats.recordsPendingArchive > 0
		) {
			expect(userStats.oldestUnarchivedRecord).toBeDefined()
			expect(userStats.oldestUnarchivedRecord).toBeInstanceOf(Date)
		}
	})
})
