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

		// ── 2. Run the orchestrator ──────────────────────────
		console.log('2. Running orchestrator (dry run first)...\n')

		const orchestrator = new Orchestrator(
			{
				bucket: 'test-bucket',
				endpoint: process.env.PG_HISTORY_S3_ENDPOINT || 'http://localhost:9000',
				accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID || 'root',
				secretAccessKey:
					process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY || 'password',
				region: process.env.PG_HISTORY_S3_REGION || 'us-west-1',
			},
			{ default: 90 }, // 90 day retention
			0, // 0 day grace period (for demo — normally 7+)
			10, // batch size of 10
		)

		// Dry run — shows what would happen
		const dryStats = await orchestrator.run(pool, { dryRun: true })
		console.log(`   Dry run found ${dryStats.tables.length} tables\n`)

		// Real run — actually archives
		console.log('3. Running orchestrator (real)...\n')
		const stats = await orchestrator.run(pool)

		console.log('   Results:')
		console.log(`   - Records archived to S3: ${stats.totalRecordsArchived}`)
		console.log(`   - Records soft deleted:   ${stats.totalRecordsSoftDeleted}`)
		console.log(`   - Records hard deleted:   ${stats.totalRecordsHardDeleted}`)
		console.log(`   - Errors:                 ${stats.errors.length}`)
		console.log(`   - Duration:               ${stats.durationMs}ms`)

		// ── 3. Check what's left ─────────────────────────────
		const remaining = await pool.query(
			`SELECT COUNT(*) as count FROM "public"."audit_log"`,
		)
		console.log(
			`\n4. Remaining audit records in database: ${remaining.rows[0].count}`,
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

main().catch(console.error)
