import { dispatch } from '@/lib/pg-chronicle-server'
import { getConnection } from '@/lib/registry'
import { SecretKeyMismatchError } from '@/lib/secret-box'

/**
 * The real pg-chronicle REST API, one mount per managed connection.
 *
 * The dashboard's own pages do NOT go through this route — they dispatch into
 * the same Hono app in-process (see lib/pg-chronicle-server.ts). This mount
 * exists so the deployment is a complete pg-chronicle server for everything
 * else: schedulers, scripts, and other services.
 *
 *   GET  /api/db/<connection>/history/<table>/<recordId>
 *   POST /api/db/<connection>/history/search
 *   POST /api/db/<connection>/history/revert
 *   GET  /api/db/<connection>/stats
 *   GET  /api/db/<connection>/health/detailed
 *   POST /api/db/<connection>/archive
 *   GET  /api/db/<connection>/health
 *   GET  /api/db/<connection>/openapi
 *
 * Authentication is unchanged: every route below `/api` is behind the same JWT
 * the library has always required, and `/archive` additionally accepts
 * `CRON_SECRET`. Naming a connection in the path grants nothing — an unknown
 * name is a 404 and a known one still needs a token.
 */

/**
 * The library registers exactly two routes at the root — the public `/health`
 * probe and `/openapi` — and everything else under `/api`. Callers should not
 * have to know that, so the public path omits the prefix and it is restored
 * here.
 *
 * Matched as whole paths, not by first segment: `/api/health/detailed` is an
 * `/api` route that merely starts with the same word, and treating it as a root
 * route sends it to a path the library never registered.
 */
const ROOT_ROUTES = new Set(['health', 'openapi'])

function internalPath(segments: string[], search: string): string {
	const rest = segments.map(encodeURIComponent).join('/')
	const base =
		segments.length === 1 && ROOT_ROUTES.has(segments[0] as string)
			? `/${rest}`
			: `/api/${rest}`
	return `${base}${search}`
}

async function handle(
	request: Request,
	params: Promise<{ conn: string; route?: string[] }>,
): Promise<Response> {
	const { conn, route = [] } = await params

	let connection: Awaited<ReturnType<typeof getConnection>>
	try {
		connection = await getConnection(conn)
	} catch (error) {
		if (error instanceof SecretKeyMismatchError) {
			return Response.json(
				{ code: 'NOT_CONFIGURED', message: error.message },
				{ status: 503 },
			)
		}
		throw error
	}

	if (!connection) {
		return Response.json(
			{ code: 'NOT_FOUND', message: `No connection named "${conn}".` },
			{ status: 404 },
		)
	}

	const url = new URL(request.url)
	const target = new Request(
		`${url.origin}${internalPath(route, url.search)}`,
		request,
	)

	try {
		return await dispatch(connection, target)
	} catch (error) {
		// Initialisation failures (unreachable database, missing table) surface
		// here rather than as an unhandled rejection.
		console.error(`pg-chronicle API error (${conn})`, error)
		return Response.json(
			{
				code: 'INIT_ERROR',
				message: 'The pg-chronicle server for this connection failed to start.',
			},
			{ status: 500 },
		)
	}
}

export function GET(
	request: Request,
	{ params }: { params: Promise<{ conn: string; route?: string[] }> },
): Promise<Response> {
	return handle(request, params)
}

export function POST(
	request: Request,
	{ params }: { params: Promise<{ conn: string; route?: string[] }> },
): Promise<Response> {
	return handle(request, params)
}

export function OPTIONS(
	request: Request,
	{ params }: { params: Promise<{ conn: string; route?: string[] }> },
): Promise<Response> {
	return handle(request, params)
}

// The pool and the audit triggers are per-instance state; a static render would
// capture a build-time response.
export const dynamic = 'force-dynamic'
