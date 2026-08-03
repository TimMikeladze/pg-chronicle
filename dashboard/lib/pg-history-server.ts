import 'server-only'

import { SignJWT } from 'jose'
import { GET as pgHistoryGET, POST as pgHistoryPOST } from 'pg-history/next'

import { readConfig } from './config'
import type {
	ApiErrorCode,
	ArchivalStatsRow,
	AuditEntryWire,
	DetailedHealth,
	HistoryCursor,
	PaginatedWire,
	SearchParams,
} from './types'

/**
 * The dashboard talks to pg-history by invoking the very same route handlers it
 * mounts at /api — in-process, with a synthetic Request. `hono/vercel`'s
 * `handle()` is just `app.fetch(req)`, so this is a direct function call: no
 * network hop, no CORS, no second connection pool, and identical auth /
 * validation / error semantics to an external caller.
 *
 * The consequence that matters: the signing secret never leaves the server, and
 * the browser is never issued a token.
 */

const TOKEN_TTL_SECONDS = 60

/**
 * The API accepts asymmetric algorithms too, but this dashboard signs its own
 * tokens and therefore needs the symmetric secret to be the verification key.
 * Fail loudly rather than emitting tokens the server will reject with a 401.
 */
function assertSymmetricAlg(): void {
	const alg = process.env.PG_HISTORY_JWT_ALG?.trim().toUpperCase()
	if (alg && !alg.startsWith('HS')) {
		throw new Error(
			`The dashboard signs its own tokens and needs a symmetric algorithm, but PG_HISTORY_JWT_ALG is "${alg}". ` +
				'Use HS256/384/512, or front the API with a token issuer that can sign with your private key.',
		)
	}
}

async function mintToken(): Promise<string> {
	const secret = process.env.PG_HISTORY_JWT_SECRET
	if (!secret) {
		throw new Error(
			'PG_HISTORY_JWT_SECRET is required. The dashboard exposes revert, so the API refuses to start without it.',
		)
	}
	assertSymmetricAlg()

	const alg = process.env.PG_HISTORY_JWT_ALG?.trim().toUpperCase() || 'HS256'
	const now = Math.floor(Date.now() / 1000)

	return (
		new SignJWT({})
			// pg-history logs `sub` as the actor on every revert — that audit line is
			// the only record of who used the dashboard, so it must be meaningful.
			.setSubject(readConfig().actor)
			.setProtectedHeader({ alg })
			.setIssuedAt(now)
			.setExpirationTime(now + TOKEN_TTL_SECONDS)
			.sign(new TextEncoder().encode(secret))
	)
}

export class ApiError extends Error {
	constructor(
		readonly code: ApiErrorCode,
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = 'ApiError'
	}
}

/**
 * The origin is arbitrary — nothing dials it. `Request` merely requires an
 * absolute URL, and Hono routes on the pathname alone.
 */
const INTERNAL_ORIGIN = 'http://pg-history.internal'

async function call<T>(
	method: 'GET' | 'POST',
	path: string,
	body?: unknown,
): Promise<T> {
	const token = await mintToken()
	const request = new Request(`${INTERNAL_ORIGIN}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})

	const response =
		method === 'GET'
			? await pgHistoryGET(request)
			: await pgHistoryPOST(request)

	// 204 has no body; every other pg-history response is JSON.
	const text = await response.text()
	const payload = text ? JSON.parse(text) : null

	if (!response.ok) {
		const err = (payload as { error?: { code?: string; message?: string } })
			?.error
		throw new ApiError(
			(err?.code as ApiErrorCode) ?? 'DATABASE_ERROR',
			err?.message ?? `Request failed with status ${response.status}`,
			response.status,
		)
	}

	return payload as T
}

export function getRecordHistory(
	table: string,
	recordId: string,
	options: {
		limit?: number
		cursor?: HistoryCursor
		order?: 'asc' | 'desc'
	} = {},
): Promise<PaginatedWire<AuditEntryWire>> {
	const params = new URLSearchParams()
	if (options.limit !== undefined) params.set('limit', String(options.limit))
	if (options.cursor) params.set('cursor', options.cursor)
	if (options.order) params.set('order', options.order)

	const query = params.toString()
	// Both segments are user-supplied; encode so a slash or space in a composite
	// key can't reshape the route.
	const path = `/api/history/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}${query ? `?${query}` : ''}`

	return call<PaginatedWire<AuditEntryWire>>('GET', path)
}

export function searchHistory(
	params: SearchParams,
): Promise<PaginatedWire<AuditEntryWire>> {
	return call<PaginatedWire<AuditEntryWire>>(
		'POST',
		'/api/history/search',
		params,
	)
}

export function revertEntry(input: {
	table: string
	recordId: string
	auditEntryId: string
	/**
	 * Skip audit rows for the revert itself. Requires SUPERUSER or the
	 * `pg_replication` role (PostgreSQL 16+); omitted rather than sent as
	 * `false` so the request body matches what a default caller would send.
	 */
	suppressAuditTriggers?: boolean
}): Promise<{ success: true }> {
	return call<{ success: true }>('POST', '/api/history/revert', {
		table: input.table,
		recordId: input.recordId,
		auditEntryId: input.auditEntryId,
		...(input.suppressAuditTriggers ? { suppressAuditTriggers: true } : {}),
	})
}

export function getStats(): Promise<{ stats: ArchivalStatsRow[] }> {
	return call<{ stats: ArchivalStatsRow[] }>('GET', '/api/stats')
}

export function getDetailedHealth(): Promise<DetailedHealth> {
	return call<DetailedHealth>('GET', '/api/health/detailed')
}

export function runArchival(): Promise<{
	success: boolean
	archival: DetailedHealth['archival']
}> {
	return call<{ success: boolean; archival: DetailedHealth['archival'] }>(
		'POST',
		'/api/archive',
	)
}

/**
 * The OpenAPI document. pg-history JWT-gates `/openapi` unless `publicOpenApi`
 * is set, and this entry point never sets it — so a browser hitting the route
 * directly would get a 401. Fetching it here with the minted token is what
 * makes the spec reachable at all.
 */
export function getOpenApiSpec(): Promise<Record<string, unknown>> {
	return call<Record<string, unknown>>('GET', '/openapi')
}

/**
 * The public probe. It lives outside `/api`, so it is not reachable through the
 * catch-all route the dashboard mounts — we call the handler directly for the
 * same reason we do everywhere else.
 */
export async function getHealth(): Promise<{ status: string } | null> {
	try {
		const response = await pgHistoryGET(
			new Request(`${INTERNAL_ORIGIN}/health`),
		)
		return (await response.json()) as { status: string }
	} catch {
		return null
	}
}
