import { secretsMatch } from '@/lib/auth'
import { runArchival } from '@/lib/pg-chronicle-server'
import { listArchivingConnections } from '@/lib/registry'

/**
 * Runs archival for every connection that has it configured.
 *
 * Archival used to be a single `POST /api/archive` because the deployment had a
 * single database. It now has as many as the operator added, and none of them
 * is known at deploy time — so the scheduled entry point is this one route,
 * which reads the registry and walks the set. `dashboard/vercel.json` points
 * the daily cron here.
 *
 * Vercel Cron issues a GET with `Authorization: Bearer $CRON_SECRET`; POST is
 * accepted too, for schedulers that prefer it.
 */

/**
 * Fail closed. Without a secret this route would let anyone reachable on the
 * internet trigger archival — which deletes rows — on every database the
 * dashboard manages. Unlike the library's own `/api/archive`, there is no JWT
 * alternative here: the route is machine-facing and a browser session is not a
 * credential for it.
 */
async function authorized(request: Request): Promise<boolean> {
	const secret = process.env.CRON_SECRET?.trim()
	if (!secret) return false
	const presented = request.headers
		.get('authorization')
		?.replace(/^Bearer\s+/i, '')
		.trim()
	if (!presented) return false
	return secretsMatch(presented, secret)
}

interface Outcome {
	connection: string
	ok: boolean
	status?: string
	error?: string
}

async function handle(request: Request): Promise<Response> {
	if (!process.env.CRON_SECRET?.trim()) {
		return Response.json(
			{
				code: 'NOT_CONFIGURED',
				message:
					'CRON_SECRET is not set, so scheduled archival is disabled. Archival can still be run per connection from the dashboard.',
			},
			{ status: 503 },
		)
	}
	if (!(await authorized(request))) {
		return Response.json(
			{ code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret.' },
			{ status: 401 },
		)
	}

	const connections = await listArchivingConnections()

	/*
	 * Sequential on purpose. Each run streams batches of audit rows through this
	 * process on its way to S3, and the archiver's own memory ceiling is set per
	 * run — running several at once multiplies a bound that was chosen to fit
	 * the instance. A daily job has the wall-clock to spare.
	 */
	const results: Outcome[] = []
	for (const entry of connections) {
		if (entry.connection === null) {
			// Credentials predate a rotation of PG_CHRONICLE_JWT_SECRET. Name it and
			// carry on: the rest of the databases still need archiving tonight.
			results.push({
				connection: entry.id,
				ok: false,
				error:
					'Stored credentials cannot be decrypted with the current PG_CHRONICLE_JWT_SECRET. Re-enter them on this connection’s edit page.',
			})
			continue
		}
		try {
			const result = await runArchival(entry.connection)
			results.push({
				connection: entry.id,
				ok: result.success,
				status: result.archival.status,
				...(result.archival.lastError
					? { error: result.archival.lastError }
					: {}),
			})
		} catch (error) {
			// One unreachable database must not stop the rest from being archived.
			console.error(`scheduled archival failed (${entry.id})`, error)
			results.push({
				connection: entry.id,
				ok: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			})
		}
	}

	const failed = results.filter((result) => !result.ok).length
	return Response.json(
		{ ran: results.length, failed, results },
		// A partial failure is reported as one: a 200 here would let a broken
		// nightly archival sit unnoticed in the platform's cron log.
		{ status: failed > 0 ? 500 : 200 },
	)
}

export function GET(request: Request): Promise<Response> {
	return handle(request)
}

export function POST(request: Request): Promise<Response> {
	return handle(request)
}

export const dynamic = 'force-dynamic'
// Archival walks every configured connection; the platform default would cut a
// large backlog short.
export const maxDuration = 300
