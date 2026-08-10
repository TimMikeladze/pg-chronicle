/**
 * Failed-login throttling for the dashboard's shared password.
 *
 * One password and no user accounts means there is no per-account lockout to
 * fall back on, so an unthrottled form is an online guessing oracle limited
 * only by how fast the server answers.
 *
 * Two behaviours, chosen so the control cannot be turned against the operator:
 *
 *   Known client (an IP the platform gave us) — a real lockout after
 *   MAX_ATTEMPTS failures. Scoped to that client, so it costs the attacker
 *   their own access and nobody else's.
 *
 *   Unknown client — escalating delay only, never a lockout. Without an
 *   identity a lockout would be global, and an attacker could deny the
 *   operator their own dashboard by failing five times.
 *
 * State is per process. On a single long-running instance that is the whole
 * story; spread across serverless instances it degrades to a per-instance
 * limit, which is still a large constant factor and is the reason the password
 * has to be long and random rather than merely secret.
 */

const WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 5
/** Applied per failure regardless, so even the first guess is not free. */
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 5_000
/** Bound the map so a flood of distinct identities cannot grow it without limit. */
const MAX_TRACKED = 10_000

interface Attempts {
	count: number
	firstAt: number
}

const attempts = new Map<string, Attempts>()

function prune(now: number): void {
	for (const [key, value] of attempts) {
		if (now - value.firstAt > WINDOW_MS) attempts.delete(key)
	}
	if (attempts.size >= MAX_TRACKED) {
		// Oldest insertion first (Map preserves order) — coarse, but the bound on
		// memory is what matters under a flood.
		const oldest = attempts.keys().next().value
		if (oldest !== undefined) attempts.delete(oldest)
	}
}

export interface ThrottleDecision {
	/** True when the attempt must be refused without checking the password. */
	lockedOut: boolean
	/** Milliseconds to wait before answering, applied on failure. */
	delayMs: number
	/** Whole minutes until the lockout lifts; only meaningful when lockedOut. */
	retryAfterMinutes: number
}

/**
 * What to do about an attempt from `client` right now. Call before comparing
 * the password; record the outcome with {@link recordFailure} /
 * {@link recordSuccess}.
 *
 * `client` is undefined when the runtime exposes no address — see the module
 * comment for why that path never locks out.
 */
export function checkThrottle(
	client: string | undefined,
	now: number = Date.now(),
): ThrottleDecision {
	prune(now)
	const key = client ?? 'unknown'
	const entry = attempts.get(key)
	if (!entry || now - entry.firstAt > WINDOW_MS) {
		return { lockedOut: false, delayMs: BASE_DELAY_MS, retryAfterMinutes: 0 }
	}

	// Doubling per failure, capped: enough to make sustained guessing pointless
	// without making a mistyped password feel broken.
	const delayMs = Math.min(BASE_DELAY_MS * 2 ** entry.count, MAX_DELAY_MS)

	if (client !== undefined && entry.count >= MAX_ATTEMPTS) {
		const remainingMs = WINDOW_MS - (now - entry.firstAt)
		return {
			lockedOut: true,
			delayMs,
			retryAfterMinutes: Math.max(1, Math.ceil(remainingMs / 60_000)),
		}
	}

	return { lockedOut: false, delayMs, retryAfterMinutes: 0 }
}

export function recordFailure(
	client: string | undefined,
	now: number = Date.now(),
): void {
	const key = client ?? 'unknown'
	const entry = attempts.get(key)
	if (!entry || now - entry.firstAt > WINDOW_MS) {
		attempts.set(key, { count: 1, firstAt: now })
		return
	}
	entry.count++
}

/** A correct password clears the client's history — they are who they claimed. */
export function recordSuccess(client: string | undefined): void {
	attempts.delete(client ?? 'unknown')
}

/** Test seam: drop all tracked state. */
export function resetThrottle(): void {
	attempts.clear()
}
