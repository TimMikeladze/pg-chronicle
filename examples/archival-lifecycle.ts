#!/usr/bin/env bun
/**
 * Archival Lifecycle
 *
 * Demonstrates: the full S3 archival pipeline using the Orchestrator
 * directly — archive old records to Parquet, soft delete, hard delete.
 *
 * Requires MinIO running (docker compose up -d).
 *
 * Run:
 *   docker compose up -d
 *   bun examples/archival-lifecycle.ts
 */

import { Client, Pool } from 'pg'
import { PgHistory } from '../src'
import { Orchestrator } from '../src/orchestrator'
import { setupArchiverSchema } from '../src/schema'
import { assert, assertEqual, run } from './_assert'

const DB_NAME = `pg_history_archival_${Date.now()}`
const ADMIN_URL =
	process.env.DATABASE_URL ||
	'postgres://postgres:postgres@localhost:5432/postgres'

async function main() {
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${DB_NAME}"`)
	await admin.end()

	const connStr = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`)
	const pool = new Pool({ connectionString: connStr })

	await pool.query(`
    CREATE TABLE logs (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `)

	const history = new PgHistory({ pool, tables: ['logs'] })
	await history.setup()

	// Set up archiver schema (adds archived_at, s3_path, soft_deleted_at columns)
	await setupArchiverSchema(pool)

	try {
		// ── 1. Generate old audit records ─────────────────────
		console.log('1. Inserting logs and backdating audit records...\n')

		for (let i = 0; i < 30; i++) {
			await pool.query(`INSERT INTO logs (level, message) VALUES ($1, $2)`, [
				i % 3 === 0 ? 'error' : 'info',
				`Log message ${i + 1}`,
			])
		}

		// Backdate all audit records to 100 days ago so they're past retention
		await pool.query(`
      UPDATE "public"."audit_log"
      SET changed_at = NOW() - INTERVAL '100 days'
    `)

		const countResult = await pool.query(
			`SELECT COUNT(*) as count FROM "public"."audit_log"`,
		)
		console.log(
			`   ${countResult.rows[0].count} audit records created and backdated\n`,
		)
		assertEqual(
			Number(countResult.rows[0].count),
			30,
			'30 INSERTs should produce 30 audit records',
		)

		// ── 2. Run the orchestrator ──────────────────────────
		console.log('2. Running orchestrator (dry run first)...\n')

		const orchestrator = new Orchestrator(
			{
				bucket: 'test-bucket',
				endpoint: process.env.PGHISTORY_S3_ENDPOINT || 'http://localhost:9000',
				accessKeyId: process.env.PGHISTORY_S3_ACCESS_KEY_ID || 'root',
				secretAccessKey:
					process.env.PGHISTORY_S3_SECRET_ACCESS_KEY || 'password',
				region: process.env.PGHISTORY_S3_REGION || 'us-west-1',
			},
			{ default: 90 }, // 90 day retention
			0, // 0 day grace period (for demo — normally 7+)
			10, // batch size of 10
		)

		// Dry run — shows what would happen
		const dryStats = await orchestrator.run(pool, { dryRun: true })
		console.log(`   Dry run found ${dryStats.tables.length} tables\n`)

		// A dry run must leave the audit log untouched.
		const afterDryRun = await pool.query(
			`SELECT COUNT(*) as count FROM "public"."audit_log"`,
		)
		assertEqual(
			Number(afterDryRun.rows[0].count),
			30,
			'dry run must not delete anything',
		)

		// Real run — actually archives
		console.log('3. Running orchestrator (real)...\n')
		const stats = await orchestrator.run(pool)

		console.log('   Results:')
		console.log(`   - Records archived to S3: ${stats.totalRecordsArchived}`)
		console.log(`   - Records soft deleted:   ${stats.totalRecordsSoftDeleted}`)
		console.log(`   - Records hard deleted:   ${stats.totalRecordsHardDeleted}`)
		console.log(`   - Errors:                 ${stats.errors.length}`)
		for (const e of stats.errors) {
			console.log(`     • [${e.table}/${e.operation}] ${e.error}`)
		}
		console.log(`   - Duration:               ${stats.durationMs}ms`)

		assertEqual(stats.errors.length, 0, 'archival run should have no errors')
		assertEqual(stats.totalRecordsArchived, 30, 'all 30 records archived to S3')
		assertEqual(
			stats.totalRecordsSoftDeleted,
			30,
			'all 30 records soft deleted',
		)
		assertEqual(
			stats.totalRecordsHardDeleted,
			30,
			'all 30 records hard deleted',
		)

		// ── 3. Check what's left ─────────────────────────────
		const remaining = await pool.query(
			`SELECT COUNT(*) as count FROM "public"."audit_log"`,
		)
		console.log(
			`\n4. Remaining audit records in database: ${remaining.rows[0].count}`,
		)
		assertEqual(
			Number(remaining.rows[0].count),
			0,
			'hard delete should empty the audit log',
		)

		// Check S3 metadata
		const metadata = await pool.query(
			`SELECT table_name, archive_date, record_count, file_size
       FROM "public"."audit_archive_metadata"
       ORDER BY archive_date`,
		)
		console.log(`\n5. S3 archive files created: ${metadata.rows.length}`)
		for (const row of metadata.rows) {
			console.log(
				`   ${row.table_name} | ${row.archive_date} | ${row.record_count} records | ${row.file_size} bytes`,
			)
		}

		// batchSize 10 over 30 records → 3 Parquet files, 10 records each.
		assertEqual(metadata.rows.length, 3, 'batchSize 10 should produce 3 files')
		assertEqual(
			metadata.rows.reduce(
				(sum: number, r: { record_count: string }) =>
					sum + Number(r.record_count),
				0,
			),
			30,
			'archive metadata should account for all 30 records',
		)
		assert(
			metadata.rows.every(
				(r: { file_size: string }) => Number(r.file_size) > 0,
			),
			'every Parquet file should be non-empty',
		)

		console.log('\nDone.')
		await history.teardown()
	} finally {
		await pool.end()
		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`DROP DATABASE "${DB_NAME}"`)
		await cleanup.end()
		console.log('Database dropped.')
	}
}

run(main)
