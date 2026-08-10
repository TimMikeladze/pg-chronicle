/**
 * The throttle is the only thing making the shared password expensive to guess,
 * and the one way it could go wrong is by locking out the operator instead of
 * the attacker — so both halves of that trade-off are pinned here.
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import {
	checkThrottle,
	recordFailure,
	recordSuccess,
	resetThrottle,
} from './login-throttle'

const IP = '203.0.113.7'
const T0 = 1_700_000_000_000

beforeEach(() => {
	resetThrottle()
})

describe('a known client', () => {
	test('is locked out after five failures', () => {
		for (let i = 0; i < 5; i++) {
			expect(checkThrottle(IP, T0).lockedOut).toBe(false)
			recordFailure(IP, T0)
		}
		const decision = checkThrottle(IP, T0)
		expect(decision.lockedOut).toBe(true)
		expect(decision.retryAfterMinutes).toBeGreaterThan(0)
	})

	test('the delay escalates before the lockout lands', () => {
		const first = checkThrottle(IP, T0).delayMs
		recordFailure(IP, T0)
		const second = checkThrottle(IP, T0).delayMs
		recordFailure(IP, T0)
		const third = checkThrottle(IP, T0).delayMs

		expect(second).toBeGreaterThan(first)
		expect(third).toBeGreaterThan(second)
	})

	test('the delay is capped, so a wrong password never hangs', () => {
		for (let i = 0; i < 40; i++) recordFailure(IP, T0)
		expect(checkThrottle(IP, T0).delayMs).toBeLessThanOrEqual(5_000)
	})

	test('the lockout lifts once the window passes', () => {
		for (let i = 0; i < 6; i++) recordFailure(IP, T0)
		expect(checkThrottle(IP, T0).lockedOut).toBe(true)

		const afterWindow = T0 + 15 * 60_000 + 1
		expect(checkThrottle(IP, afterWindow).lockedOut).toBe(false)
	})

	test('a correct password clears the history', () => {
		for (let i = 0; i < 4; i++) recordFailure(IP, T0)
		recordSuccess(IP)
		expect(checkThrottle(IP, T0).delayMs).toBe(500)
		expect(checkThrottle(IP, T0).lockedOut).toBe(false)
	})

	test('clients are tracked separately', () => {
		for (let i = 0; i < 6; i++) recordFailure(IP, T0)
		expect(checkThrottle(IP, T0).lockedOut).toBe(true)
		// The attacker's failures must not cost anyone else their access.
		expect(checkThrottle('198.51.100.4', T0).lockedOut).toBe(false)
	})
})

describe('an unidentifiable client', () => {
	/**
	 * With no address there is only one bucket, so a lockout would be global —
	 * five deliberate failures would deny the operator their own dashboard.
	 * Delay is the only safe lever.
	 */
	test('is never locked out, however many times it fails', () => {
		for (let i = 0; i < 50; i++) recordFailure(undefined, T0)
		const decision = checkThrottle(undefined, T0)
		expect(decision.lockedOut).toBe(false)
		expect(decision.delayMs).toBe(5_000)
	})
})
