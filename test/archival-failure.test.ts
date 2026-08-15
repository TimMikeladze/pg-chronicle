/**
 * What the server does when archival cannot succeed.
 *
 * The retry/backoff loop and the "every table failed" detection were the
 * largest untested block in server.ts, and they are what stands between a
 * broken S3 configuration and a service that silently reports itself healthy
 * while the audit log grows without bound.
 *
 * S3 here points at a closed port, so every upload fails fast and for a
 * realistic reason (bad endpoint, revoked credentials, bucket gone).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgChronicle } from '../src'
import { createServer } from '../src/server'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

/** A port nothing listens on: connections are refused immediately. */
const DEAD_S3 = 'http://127.0.0.1:1'

const CRON_SECRET = 'archival-failure-cron-secret'

async function seedArchivableRows(pool: Pool): Promise<void> {
	await pool.query(
		`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
	)
	const history = new PgChronicle({ pool, tables: ['users'] })
	await history.setup()

	// Old enough to be past the retention cutoff, so the archiver actually
	// attempts an upload rather than finding nothing to do.
	await pool.query(
		`INSERT INTO audit_log (table_name, record_id, operation, changed_at, new_data)
		 VALUES ('users', '1', 'INSERT', NOW() - INTERVAL '200 days', '{"name":"Alice"}'::jsonb)`,
	)
}

async function failingServer(pool: Pool) {
	return createServer({
		pool,
		enableArchiver: true,
		archiverConfig: {
			s3: {
				bucket: 'nonexistent-bucket',
				endpoint: DEAD_S3,
				region: 'us-east-1',
				accessKeyId: 'x',
				secretAccessKey: 'y',
			},
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		},
		// Two attempts with a negligible gap: enough to prove the loop retries
		// without making the suite wait on a real backoff.
		archivalRetry: { maxAttempts: 2, delays: [10] },
		archiveCronSecret: CRON_SECRET,
		serverless: true,
	})
}

async function triggerArchival(
	app: Awaited<ReturnType<typeof createServer>>['app'],
): Promise<Response> {
	return app.request('/api/archive', {
		method: 'POST',
		headers: { Authorization: `Bearer ${CRON_SECRET}` },
	})
}

describe('archival that cannot reach S3', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await seedArchivableRows(pool)
	})

	test('the run is reported as attempted, and health turns degraded', async () => {
		const { app } = await failingServer(pool)

		const res = await triggerArchival(app)
		// A run that exhausted its attempts is not a success. Answering 200 here
		// would put a green tick in the scheduler's history for an archiver that
		// is doing nothing.
		expect(res.status).toBe(500)
		const body = (await res.json()) as {
			success: boolean
			ran: boolean
			error: { code: string }
			archival: { status: string }
		}
		expect(body.success).toBe(false)
		// Distinct from "someone else was already running": this attempt did the
		// work and the work failed.
		expect(body.ran).toBe(true)
		expect(body.error.code).toBe('ARCHIVAL_FAILED')
		expect(body.archival.status).toBe('failed')

		// A failing archiver must not look healthy to a platform probe: the audit
		// log is growing and nothing is draining it.
		const health = await app.request('/health')
		expect(health.status).toBe(200)
		expect((await health.json()).status).toBe('degraded')
	})

	test('the failure and its retry count are visible to an operator', async () => {
		const { app } = await failingServer(pool)
		await triggerArchival(app)

		const detailed = await app.request('/api/health/detailed', {
			headers: { Authorization: `Bearer ${CRON_SECRET}` },
		})
		expect(detailed.status).toBe(200)

		const body = (await detailed.json()) as {
			status: string
			archival: { status: string; attempts: number; lastError: string | null }
		}
		expect(body.status).toBe('degraded')
		expect(body.archival.status).toBe('failed')
		// Both attempts ran: the counter is "retries since last success", and it
		// was never reset because there was no success.
		expect(body.archival.attempts).toBe(2)
		expect(body.archival.lastError).toBeTruthy()
	})

	test('rows are left unarchived rather than marked done', async () => {
		const { app } = await failingServer(pool)
		await triggerArchival(app)

		// The failure mode that would actually lose data is marking rows archived
		// against a file that was never written.
		const pending = await pool.query(
			`SELECT COUNT(*)::int AS count FROM audit_log
			 WHERE table_name = 'users' AND archived_at IS NULL`,
		)
		expect(pending.rows[0].count).toBeGreaterThan(0)

		const claimed = await pool.query(
			`SELECT COUNT(*)::int AS count FROM audit_log WHERE claim_id IS NOT NULL`,
		)
		// The claim is released on upload failure, so the rows are eligible again
		// on the next run without waiting for the stale-claim reaper.
		expect(claimed.rows[0].count).toBe(0)
	})

	test('dispose() cuts a retry backoff short instead of waiting it out', async () => {
		const { app, dispose } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: {
					bucket: 'nonexistent-bucket',
					endpoint: DEAD_S3,
					region: 'us-east-1',
					accessKeyId: 'x',
					secretAccessKey: 'y',
				},
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 10,
			},
			// A backoff long enough that waiting it out would blow the test budget
			// — and, in production, the platform's kill timeout.
			archivalRetry: { maxAttempts: 2, delays: [60_000] },
			archiveCronSecret: CRON_SECRET,
			serverless: true,
		})

		const inFlight = triggerArchival(app)
		// Let the first attempt fail and the loop enter its backoff.
		await new Promise((resolve) => setTimeout(resolve, 500))

		const started = Date.now()
		await dispose(1_000)
		await inFlight
		expect(Date.now() - started).toBeLessThan(20_000)
	})
})
