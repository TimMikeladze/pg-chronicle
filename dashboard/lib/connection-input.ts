import type { ArchiverSettings, Connection, ConnectionInput } from './registry'

/**
 * Turns the connection form into a validated {@link ConnectionInput}.
 *
 * Pure and free of `server-only` on purpose: this is the whole of the
 * dashboard's input validation, and validation that cannot be unit-tested
 * without a database is validation nobody runs.
 *
 * Everything is checked here rather than left to Postgres, because the failures
 * this catches are typos an operator can fix in the form — a mistyped table
 * name should say so next to the field, not surface later as an INVALID_TABLE
 * from a page that was supposed to be working.
 */

/**
 * What the connection form's `useActionState` holds. It lives here rather than
 * beside the actions because a `"use server"` module may only export async
 * functions — a constant in one is a build error.
 */
export interface ConnectionFormState {
	error: string | null
}

export const EMPTY_FORM_STATE: ConnectionFormState = { error: null }

export type ParseResult =
	| { ok: true; value: ConnectionInput }
	| { ok: false; message: string }

/** PostgreSQL identifier rules, mirroring `validateIdentifier` in the library. */
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

const NAME_MAX_LENGTH = 64

function text(form: FormData, field: string): string {
	const value = form.get(field)
	return typeof value === 'string' ? value.trim() : ''
}

function checked(form: FormData, field: string): boolean {
	const value = form.get(field)
	return value === 'on' || value === 'true'
}

/** Comma- or newline-separated, so a pasted list works either way. */
export function parseTables(raw: string): string[] {
	const seen = new Set<string>()
	for (const part of raw.split(/[\s,]+/)) {
		const name = part.trim()
		if (name) seen.add(name)
	}
	return [...seen]
}

function positiveInteger(
	raw: string,
	fallback: number,
	{ min }: { min: number },
): number | null {
	if (raw === '') return fallback
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isFinite(parsed) || parsed < min) return null
	return parsed
}

/**
 * `postgres://` and `postgresql://` only. Rejecting anything else is not
 * pedantry: `pg` accepts a bare hostname and quietly falls back to PGHOST /
 * PGUSER / PGPASSWORD from the deployment's environment, which on this
 * deployment points at the registry — so a typo would silently audit the wrong
 * database.
 */
function validDatabaseUrl(raw: string): boolean {
	try {
		const url = new URL(raw)
		return (
			(url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
			url.hostname !== ''
		)
	} catch {
		return false
	}
}

/**
 * @param existing When editing, the connection being edited. Blank credential
 * fields then mean "leave unchanged" — renaming a connection or adding a table
 * must not require re-pasting a password the operator no longer has to hand.
 */
export function parseConnectionForm(
	form: FormData,
	existing?: Connection,
): ParseResult {
	const name = text(form, 'name')
	if (!name) return { ok: false, message: 'Name is required.' }
	if (name.length > NAME_MAX_LENGTH) {
		return {
			ok: false,
			message: `Name must be ${NAME_MAX_LENGTH} characters or fewer.`,
		}
	}

	const rawUrl = text(form, 'databaseUrl')
	const databaseUrl = rawUrl || existing?.databaseUrl || ''
	if (!databaseUrl) {
		return { ok: false, message: 'Connection string is required.' }
	}
	if (!validDatabaseUrl(databaseUrl)) {
		return {
			ok: false,
			message:
				'Connection string must be a postgres:// or postgresql:// URL including a host.',
		}
	}

	const tables = parseTables(text(form, 'tables'))
	if (tables.length === 0) {
		return {
			ok: false,
			message:
				'List at least one table. The audit triggers are installed on exactly these tables, and the API refuses to read any other.',
		}
	}
	const invalid = tables.find((table) => !IDENTIFIER.test(table))
	if (invalid) {
		return {
			ok: false,
			message: `“${invalid}” is not a valid table name. Names must start with a letter or underscore and contain only letters, digits and underscores.`,
		}
	}

	if (!checked(form, 'archiverEnabled')) {
		return { ok: true, value: { name, databaseUrl, tables, archiver: null } }
	}

	const bucket = text(form, 's3Bucket')
	if (!bucket) {
		return {
			ok: false,
			message: 'An S3 bucket is required when archival is enabled.',
		}
	}

	const retentionDays = positiveInteger(text(form, 'retentionDays'), 90, {
		min: 1,
	})
	if (retentionDays === null) {
		return { ok: false, message: 'Retention must be at least 1 day.' }
	}

	// Zero is meaningful: purge as soon as the S3 write is confirmed.
	const gracePeriodDays = positiveInteger(text(form, 'gracePeriodDays'), 7, {
		min: 0,
	})
	if (gracePeriodDays === null) {
		return { ok: false, message: 'Grace period must be 0 days or more.' }
	}

	const batchSize = positiveInteger(text(form, 'batchSize'), 10_000, { min: 1 })
	if (batchSize === null) {
		return { ok: false, message: 'Batch size must be at least 1.' }
	}

	const secretAccessKey =
		text(form, 's3SecretAccessKey') || existing?.archiver?.secretAccessKey

	const archiver: ArchiverSettings = {
		bucket,
		endpoint: text(form, 's3Endpoint') || undefined,
		region: text(form, 's3Region') || undefined,
		accessKeyId: text(form, 's3AccessKeyId') || undefined,
		secretAccessKey: secretAccessKey || undefined,
		retentionDays,
		gracePeriodDays,
		batchSize,
	}

	return { ok: true, value: { name, databaseUrl, tables, archiver } }
}
