import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { open, SecretKeyMismatchError, seal } from './secret-box'

/**
 * These are the credentials for every database the dashboard manages, so the
 * two properties that matter are that a round trip is lossless and that a
 * rotated secret fails loudly rather than silently.
 */

const ORIGINAL = process.env.PG_CHRONICLE_JWT_SECRET

beforeEach(() => {
	process.env.PG_CHRONICLE_JWT_SECRET = 'test-secret-0123456789abcdef'
})

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.PG_CHRONICLE_JWT_SECRET
	else process.env.PG_CHRONICLE_JWT_SECRET = ORIGINAL
})

describe('secret box', () => {
	it('round-trips a connection string', () => {
		const plaintext = 'postgres://user:p@ss w0rd@host:5432/db?sslmode=require'
		expect(open(seal(plaintext))).toBe(plaintext)
	})

	/** A fresh IV per call: two seals of the same value must not be comparable. */
	it('produces a different ciphertext each time', () => {
		expect(seal('same')).not.toBe(seal('same'))
	})

	it('names the rotated secret when the key has changed', () => {
		const sealed = seal('postgres://host/db')
		process.env.PG_CHRONICLE_JWT_SECRET = 'a-different-secret'
		expect(() => open(sealed)).toThrow(SecretKeyMismatchError)
	})

	it('rejects a tampered ciphertext under the same key', () => {
		const sealed = seal('postgres://host/db')
		const parts = sealed.split(':')
		// Flip the last character of the payload; GCM's tag must catch it.
		const payload = parts[3] as string
		parts[3] = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A')
		expect(() => open(parts.join(':'))).toThrow('integrity check')
	})

	it('requires a secret to be configured', () => {
		delete process.env.PG_CHRONICLE_JWT_SECRET
		expect(() => seal('x')).toThrow('PG_CHRONICLE_JWT_SECRET is required')
	})
})
