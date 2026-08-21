import { describe, expect, it } from 'bun:test'

import { parseConnectionForm, parseTables } from './connection-input'
import type { Connection } from './registry'

/**
 * The form is the only path by which a database enters the dashboard, so this
 * is the whole of its input validation. The cases below are the ones that would
 * otherwise be discovered as a broken page after the fact.
 */

function form(fields: Record<string, string>): FormData {
	const data = new FormData()
	for (const [key, value] of Object.entries(fields)) data.append(key, value)
	return data
}

const VALID = {
	name: 'Production',
	databaseUrl: 'postgres://user:pw@db.example.com:5432/app',
	tables: 'users, orders',
}

const EXISTING: Connection = {
	id: 'production',
	name: 'Production',
	databaseUrl: 'postgres://user:pw@db.example.com:5432/app',
	tables: ['users'],
	archiver: {
		bucket: 'audit',
		retentionDays: 30,
		gracePeriodDays: 3,
		batchSize: 500,
		secretAccessKey: 'stored-secret',
	},
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('parseTables', () => {
	it('accepts commas, spaces and newlines, and de-duplicates', () => {
		expect(parseTables('users, orders\ninvoices users')).toEqual([
			'users',
			'orders',
			'invoices',
		])
	})
})

describe('parseConnectionForm', () => {
	it('accepts a minimal connection with archival off', () => {
		const result = parseConnectionForm(form(VALID))
		expect(result).toEqual({
			ok: true,
			value: {
				name: 'Production',
				databaseUrl: VALID.databaseUrl,
				tables: ['users', 'orders'],
				archiver: null,
			},
		})
	})

	it('requires at least one table', () => {
		const result = parseConnectionForm(form({ ...VALID, tables: '  ' }))
		expect(result.ok).toBe(false)
	})

	/**
	 * Mirrors `validateIdentifier` in the library. Without this the name reaches
	 * SQL that interpolates identifiers directly.
	 */
	it('rejects a table name that is not a Postgres identifier', () => {
		const result = parseConnectionForm(
			form({ ...VALID, tables: 'users;DROP TABLE orders' }),
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.message).toContain('not a valid table name')
	})

	/**
	 * `pg` accepts a bare hostname and falls back to PGHOST/PGUSER/PGPASSWORD —
	 * which on a dashboard deployment point at the registry. A typo must not
	 * silently audit the wrong database.
	 */
	it('rejects a connection string that is not a postgres URL', () => {
		for (const databaseUrl of [
			'db.example.com',
			'mysql://host/db',
			'https://x',
		]) {
			expect(parseConnectionForm(form({ ...VALID, databaseUrl })).ok).toBe(
				false,
			)
		}
	})

	it('accepts postgresql:// as well as postgres://', () => {
		const result = parseConnectionForm(
			form({ ...VALID, databaseUrl: 'postgresql://host:5432/db' }),
		)
		expect(result.ok).toBe(true)
	})

	describe('editing', () => {
		it('keeps the stored connection string when the field is blank', () => {
			const result = parseConnectionForm(
				form({ name: 'Production', databaseUrl: '', tables: 'users' }),
				EXISTING,
			)
			expect(result.ok).toBe(true)
			if (result.ok) expect(result.value.databaseUrl).toBe(EXISTING.databaseUrl)
		})

		it('requires a connection string when there is nothing stored', () => {
			const result = parseConnectionForm(
				form({ name: 'Production', databaseUrl: '', tables: 'users' }),
			)
			expect(result.ok).toBe(false)
		})

		it('keeps the stored S3 secret key when the field is blank', () => {
			const result = parseConnectionForm(
				form({
					...VALID,
					archiverEnabled: 'on',
					s3Bucket: 'audit',
					s3SecretAccessKey: '',
				}),
				EXISTING,
			)
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value.archiver?.secretAccessKey).toBe('stored-secret')
			}
		})
	})

	describe('archival', () => {
		it('requires a bucket when enabled', () => {
			const result = parseConnectionForm(
				form({ ...VALID, archiverEnabled: 'on', s3Bucket: '' }),
			)
			expect(result.ok).toBe(false)
		})

		it('fills the library defaults for blank numeric fields', () => {
			const result = parseConnectionForm(
				form({ ...VALID, archiverEnabled: 'on', s3Bucket: 'audit' }),
			)
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value.archiver).toMatchObject({
					bucket: 'audit',
					retentionDays: 90,
					gracePeriodDays: 7,
					batchSize: 10_000,
				})
			}
		})

		/** 0 means "purge as soon as the S3 write is confirmed" — not "unset". */
		it('accepts a zero grace period but not a zero retention', () => {
			const base = { ...VALID, archiverEnabled: 'on', s3Bucket: 'audit' }
			expect(
				parseConnectionForm(form({ ...base, gracePeriodDays: '0' })).ok,
			).toBe(true)
			expect(
				parseConnectionForm(form({ ...base, retentionDays: '0' })).ok,
			).toBe(false)
		})
	})
})
