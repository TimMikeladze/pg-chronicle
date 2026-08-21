import 'server-only'

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'

/**
 * Authenticated encryption for the credentials the dashboard stores on behalf
 * of the operator — connection strings and S3 secret keys.
 *
 * These rows live in the registry database, which is backed up, replicated and
 * dumped like any other. A dump of the registry must not be a dump of every
 * audited database's password, so nothing secret is written in plaintext.
 *
 * The key is derived from `PG_CHRONICLE_JWT_SECRET` rather than a fourth
 * variable of its own. That secret already has to exist (the API refuses to
 * start without it), it is already required to be long and random, and one
 * fewer thing to configure is one fewer thing to configure wrong. Domain
 * separation in the digest input keeps this key distinct from the signing key,
 * so a token can never be mistaken for a decryption key or vice versa.
 */

const KEY_DOMAIN = 'pg-chronicle:dashboard:secret-box:v1:'
const FINGERPRINT_DOMAIN = 'pg-chronicle:dashboard:secret-box-fingerprint:v1:'

/**
 * Rotating `PG_CHRONICLE_JWT_SECRET` silently orphans every stored credential.
 * Stamping the key's fingerprint into the ciphertext turns that from "garbage
 * decrypt / cryptic auth failure" into a sentence naming exactly what happened
 * and what to do about it.
 */
export class SecretKeyMismatchError extends Error {
	constructor() {
		super(
			'This value was encrypted with a different PG_CHRONICLE_JWT_SECRET. ' +
				'Restore the previous secret, or re-enter the connection’s credentials to seal them with the current one.',
		)
		this.name = 'SecretKeyMismatchError'
	}
}

export class MissingSecretError extends Error {
	constructor() {
		super(
			'PG_CHRONICLE_JWT_SECRET is required. The dashboard signs its own API tokens with it and encrypts stored credentials under a key derived from it.',
		)
		this.name = 'MissingSecretError'
	}
}

function secret(): string {
	const value = process.env.PG_CHRONICLE_JWT_SECRET?.trim()
	if (!value) throw new MissingSecretError()
	return value
}

function key(): Buffer {
	return createHash('sha256')
		.update(KEY_DOMAIN + secret())
		.digest()
}

/** Eight hex characters — enough to detect a rotation, far too few to attack. */
function fingerprint(): string {
	return createHash('sha256')
		.update(FINGERPRINT_DOMAIN + secret())
		.digest('hex')
		.slice(0, 8)
}

/** `v1:<key fingerprint>:<iv>:<ciphertext+tag>`, all base64url. */
export function seal(plaintext: string): string {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key(), iv)
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, 'utf8'),
		cipher.final(),
	])
	const payload = Buffer.concat([ciphertext, cipher.getAuthTag()])
	return `v1:${fingerprint()}:${iv.toString('base64url')}:${payload.toString('base64url')}`
}

export function open(sealed: string): string {
	const parts = sealed.split(':')
	if (parts.length !== 4 || parts[0] !== 'v1') {
		throw new Error('Stored credential is not in the expected format.')
	}
	const [, storedFingerprint, ivPart, payloadPart] = parts as [
		string,
		string,
		string,
		string,
	]
	if (storedFingerprint !== fingerprint()) throw new SecretKeyMismatchError()

	const payload = Buffer.from(payloadPart, 'base64url')
	// GCM tags are a fixed 16 bytes and are appended, so the split is positional.
	const tag = payload.subarray(payload.length - 16)
	const ciphertext = payload.subarray(0, payload.length - 16)

	const decipher = createDecipheriv(
		'aes-256-gcm',
		key(),
		Buffer.from(ivPart, 'base64url'),
	)
	decipher.setAuthTag(tag)
	try {
		return Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]).toString('utf8')
	} catch {
		// The fingerprint matched, so this is tampering or corruption rather than
		// a rotated key — say so instead of blaming the secret.
		throw new Error('Stored credential failed its integrity check.')
	}
}
