/**
 * Dashboard access control.
 *
 * The dashboard mints its own pg-chronicle token on every request, so reaching a
 * page IS full read access plus revert — a destructive, unattributable-to-a-
 * person operation. Nothing in pg-chronicle itself can stop that: from the API's
 * point of view the dashboard is a legitimate authenticated caller. The gate
 * therefore has to live here, in front of the pages.
 *
 * Model: one shared password (`PG_CHRONICLE_DASHBOARD_PASSWORD`) exchanged for a
 * signed, httpOnly session cookie. Deliberately minimal — it is a lock on the
 * door, not an identity system. For real per-user identity, put the deployment
 * behind your SSO / access proxy and set the password as a second factor, or
 * leave it unset in an environment your proxy already protects and accept the
 * startup warning.
 *
 * Edge-safe: middleware runs on the Edge runtime, so this module uses only Web
 * Crypto and `jose`, no Node built-ins.
 */

import { jwtVerify, SignJWT } from 'jose'

export const SESSION_COOKIE = 'pg_chronicle_dashboard_session'

/** Paths that must stay reachable without a session. */
export const PUBLIC_PATHS = ['/login', '/health']

/**
 * `/api/*` is intentionally NOT gated by the cookie. It is the real pg-chronicle
 * REST API, already fail-closed behind its own JWT (and cron secret), and it is
 * what schedulers and other services call. Requiring a browser session there
 * would break them without adding protection.
 */
export function isPublicPath(pathname: string): boolean {
	if (pathname.startsWith('/api/')) return true
	return PUBLIC_PATHS.some(
		(path) => pathname === path || pathname.startsWith(`${path}/`),
	)
}

export function dashboardPassword(): string | undefined {
	return process.env.PG_CHRONICLE_DASHBOARD_PASSWORD?.trim() || undefined
}

/**
 * Whether an unauthenticated deployment is tolerated.
 *
 * Fail closed in production: a dashboard with no password on a public URL is an
 * anonymous revert button. Development keeps working without ceremony.
 * `PG_CHRONICLE_DASHBOARD_ALLOW_ANONYMOUS=true` is the explicit, auditable opt-out
 * for deployments already behind an access proxy.
 */
export function anonymousAccessAllowed(): boolean {
	if (process.env.PG_CHRONICLE_DASHBOARD_ALLOW_ANONYMOUS?.trim() === 'true') {
		return true
	}
	return process.env.NODE_ENV !== 'production'
}

function sessionTtlSeconds(): number {
	const raw = process.env.PG_CHRONICLE_DASHBOARD_SESSION_TTL_HOURS?.trim()
	const hours = raw ? Number.parseInt(raw, 10) : 12
	if (!Number.isFinite(hours) || hours < 1) return 12 * 3600
	return hours * 3600
}

/**
 * Session signing key, derived from the password itself. Rotating the password
 * therefore invalidates every existing session for free — no second secret to
 * configure, and no way to forget to rotate it.
 */
async function sessionKey(password: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`pg-chronicle:dashboard:session:${password}`),
	)
	return new Uint8Array(digest)
}

/** Constant-time comparison of two secrets, via fixed-width digests. */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder()
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	])
	const bytesA = new Uint8Array(digestA)
	const bytesB = new Uint8Array(digestB)
	let diff = bytesA.length ^ bytesB.length
	for (let i = 0; i < bytesA.length; i++) {
		diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0)
	}
	return diff === 0
}

export async function createSessionToken(password: string): Promise<{
	token: string
	maxAge: number
}> {
	const maxAge = sessionTtlSeconds()
	const now = Math.floor(Date.now() / 1000)
	const token = await new SignJWT({})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('dashboard')
		.setIssuedAt(now)
		.setExpirationTime(now + maxAge)
		.sign(await sessionKey(password))
	return { token, maxAge }
}

export async function sessionIsValid(
	token: string | undefined,
): Promise<boolean> {
	const password = dashboardPassword()
	if (!password || !token) return false
	try {
		await jwtVerify(token, await sessionKey(password))
		return true
	} catch {
		return false
	}
}
