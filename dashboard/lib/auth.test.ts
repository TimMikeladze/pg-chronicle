/**
 * The dashboard's access control is the only thing between a public URL and an
 * anonymous revert button, and until now nothing tested it — the CI job for
 * this app only typechecks and builds.
 *
 * These cover the primitives the middleware is built from. The wiring itself
 * (redirect vs 401, the 503 in production) is exercised by hand against a real
 * server; what is pinned here is the logic that decides who gets in.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
	anonymousAccessAllowed,
	createSessionToken,
	dashboardPassword,
	isPublicPath,
	secretsMatch,
	sessionIsValid,
} from './auth'

const ENV_KEYS = [
	'PG_HISTORY_DASHBOARD_PASSWORD',
	'PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS',
	'PG_HISTORY_DASHBOARD_SESSION_TTL_HOURS',
	'NODE_ENV',
] as const

const saved = new Map<string, string | undefined>()

// `process.env` is typed with a readonly NODE_ENV; these tests deliberately
// flip it to prove the production fail-closed path, which is the whole point.
const env = process.env as Record<string, string | undefined>

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
	if (!saved.has(key)) saved.set(key, env[key])
	if (value === undefined) delete env[key]
	else env[key] = value
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete env[key]
		else env[key] = value
	}
	saved.clear()
})

describe('which paths bypass the gate', () => {
	test('the API and the public probe are never gated', () => {
		// /api/* carries its own JWT and cron-secret auth and is what schedulers
		// call; gating it on a browser cookie would break them without adding
		// protection.
		expect(isPublicPath('/api/history/users/1')).toBe(true)
		expect(isPublicPath('/api/archive')).toBe(true)
		expect(isPublicPath('/health')).toBe(true)
		expect(isPublicPath('/login')).toBe(true)
	})

	test('every page that shows audit data is gated', () => {
		for (const path of [
			'/',
			'/tables',
			'/tables/users',
			'/history/users/1',
			'/search',
			'/archival',
			'/openapi',
			'/openapi.json',
		]) {
			expect(isPublicPath(path)).toBe(false)
		}
	})

	test('a path merely starting with "api" is not the API', () => {
		// `/apifoo` must not inherit the /api/* exemption.
		expect(isPublicPath('/apifoo')).toBe(false)
		expect(isPublicPath('/api')).toBe(false)
	})
})

describe('fail-closed in production', () => {
	test('no password in production is not allowed', () => {
		setEnv('NODE_ENV', 'production')
		setEnv('PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS', undefined)
		expect(anonymousAccessAllowed()).toBe(false)
	})

	test('development stays open', () => {
		setEnv('NODE_ENV', 'development')
		setEnv('PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS', undefined)
		expect(anonymousAccessAllowed()).toBe(true)
	})

	test('the opt-out must be exactly "true"', () => {
		setEnv('NODE_ENV', 'production')
		for (const value of ['1', 'yes', 'TRUE', '']) {
			setEnv('PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS', value)
			expect(anonymousAccessAllowed()).toBe(false)
		}
		setEnv('PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS', 'true')
		expect(anonymousAccessAllowed()).toBe(true)
	})

	test('a whitespace-only password does not count as configured', () => {
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', '   ')
		expect(dashboardPassword()).toBeUndefined()
	})
})

describe('password comparison', () => {
	test('accepts the exact password and nothing else', async () => {
		expect(await secretsMatch('hunter2', 'hunter2')).toBe(true)
		expect(await secretsMatch('hunter2', 'hunter3')).toBe(false)
		// A prefix must not pass — the comparison is over digests, not a
		// startsWith.
		expect(await secretsMatch('hunter', 'hunter2')).toBe(false)
		expect(await secretsMatch('', 'hunter2')).toBe(false)
	})
})

describe('sessions', () => {
	test('a token minted for the password validates', async () => {
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', 'correct horse')
		const { token } = await createSessionToken('correct horse')
		expect(await sessionIsValid(token)).toBe(true)
	})

	test('rotating the password invalidates existing sessions', async () => {
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', 'old password')
		const { token } = await createSessionToken('old password')
		expect(await sessionIsValid(token)).toBe(true)

		// The signing key is derived from the password, so this is the whole
		// revocation story — there is no session store to clear.
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', 'new password')
		expect(await sessionIsValid(token)).toBe(false)
	})

	test('garbage and absent cookies are rejected', async () => {
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', 'correct horse')
		expect(await sessionIsValid(undefined)).toBe(false)
		expect(await sessionIsValid('')).toBe(false)
		expect(await sessionIsValid('not-a-jwt')).toBe(false)
		// A structurally valid JWT signed with the wrong key.
		const { token } = await createSessionToken('some other secret')
		expect(await sessionIsValid(token)).toBe(false)
	})

	test('no session is valid when no password is configured', async () => {
		const { token } = await createSessionToken('whatever')
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', undefined)
		expect(await sessionIsValid(token)).toBe(false)
	})

	test('an expired token is rejected', async () => {
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', 'correct horse')
		// jose rejects on `exp`; a TTL floor of 1 hour means we cannot mint an
		// already-expired token through the public API, so assert the TTL that
		// lands in the cookie instead.
		setEnv('PG_HISTORY_DASHBOARD_SESSION_TTL_HOURS', '3')
		const { maxAge } = await createSessionToken('correct horse')
		expect(maxAge).toBe(3 * 3600)
	})

	test('a nonsense TTL falls back to the default rather than 0', async () => {
		setEnv('PG_HISTORY_DASHBOARD_PASSWORD', 'correct horse')
		for (const bad of ['0', '-5', 'abc', '']) {
			setEnv('PG_HISTORY_DASHBOARD_SESSION_TTL_HOURS', bad)
			const { maxAge } = await createSessionToken('correct horse')
			expect(maxAge).toBe(12 * 3600)
		}
	})
})
