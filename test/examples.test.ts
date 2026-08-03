import { describe, expect, test } from 'bun:test'

/**
 * Runs every file in examples/ as a subprocess and requires a zero exit code.
 *
 * The examples assert their own behavior (see examples/_assert.ts), so this
 * suite is what turns them into executable documentation: if an example's
 * output stops matching what it claims, the assertion throws and the process
 * exits non-zero.
 *
 * Requires Postgres (and MinIO for the archival examples) — same services as
 * the rest of the integration suite, see docker-compose.yml.
 */

const EXAMPLES = [
	'basic-audit-trail.ts',
	'search-and-revert.ts',
	'multi-table-tracking.ts',
	'error-handling.ts',
	'rest-api-server.ts',
	'cron-archival.ts',
	'archival-lifecycle.ts',
] as const

// Examples that write Parquet files to S3 and need MinIO reachable.
const NEEDS_S3 = new Set(['archival-lifecycle.ts', 'cron-archival.ts'])

const S3_ENDPOINT = process.env.PGHISTORY_S3_ENDPOINT || 'http://localhost:9000'

async function s3Reachable(): Promise<boolean> {
	try {
		await fetch(`${S3_ENDPOINT}/minio/health/live`, {
			signal: AbortSignal.timeout(2000),
		})
		return true
	} catch {
		return false
	}
}

const hasS3 = await s3Reachable()

describe('examples', () => {
	for (const example of EXAMPLES) {
		const needsS3 = NEEDS_S3.has(example)
		const skip = needsS3 && !hasS3
		const runTest = skip ? test.skip : test

		runTest(
			`${example} runs successfully`,
			async () => {
				const proc = Bun.spawn(['bun', `examples/${example}`], {
					cwd: new URL('..', import.meta.url).pathname,
					stdout: 'pipe',
					stderr: 'pipe',
				})

				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				])

				if (exitCode !== 0) {
					// Surface the example's own output — the assertion message is in it.
					console.error(`--- ${example} stdout ---\n${stdout}`)
					console.error(`--- ${example} stderr ---\n${stderr}`)
				}

				expect(exitCode).toBe(0)
			},
			120_000,
		)
	}
})
