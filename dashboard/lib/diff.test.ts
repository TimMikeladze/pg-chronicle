/**
 * The diff is how an operator reads an audit entry, so the distinctions it
 * draws are the product: a dropped column must not look like a nulled one, and
 * a redacted change must not look like no change at all.
 */
import { describe, expect, test } from 'bun:test'

import {
	changedFields,
	diffEntry,
	isRevertible,
	onlyExcludedColumnsChanged,
	renderValue,
	revertOutcome,
} from './diff'
import type { AuditEntryWire, Operation } from './types'

function entry(
	operation: Operation,
	oldData: Record<string, unknown> | null,
	newData: Record<string, unknown> | null,
): AuditEntryWire {
	return {
		id: '1',
		tableName: 'users',
		recordId: '1',
		operation,
		changedAt: '2026-01-01T00:00:00.000Z',
		oldData,
		newData,
		dbUser: 'app',
		appActor: null,
		clientAddr: null,
	}
}

describe('renderValue', () => {
	test('absence and SQL NULL are not the same thing', () => {
		// A column that did not exist on that side vs one that held NULL: render
		// them identically and a dropped column reads as a nulled one.
		expect(renderValue(undefined)).toBe('—')
		expect(renderValue(null)).toBe('null')
	})

	test('strings pass through unquoted, objects are formatted', () => {
		expect(renderValue('alice')).toBe('alice')
		expect(renderValue(42)).toBe('42')
		expect(renderValue(false)).toBe('false')
		expect(renderValue({ a: 1 })).toBe('{\n  "a": 1\n}')
	})
})

describe('diffEntry', () => {
	test('an INSERT is all additions', () => {
		const changes = diffEntry(entry('INSERT', null, { name: 'a', role: 'b' }))
		expect(changes.map((c) => c.kind)).toEqual(['added', 'added'])
	})

	test('a DELETE is all removals', () => {
		const changes = diffEntry(entry('DELETE', { name: 'a' }, null))
		expect(changes.map((c) => c.kind)).toEqual(['removed'])
	})

	test('a TRUNCATE has nothing to show', () => {
		expect(diffEntry(entry('TRUNCATE', null, null))).toEqual([])
	})

	test('an UPDATE separates changed from unchanged', () => {
		const changes = diffEntry(
			entry('UPDATE', { name: 'a', role: 'x' }, { name: 'b', role: 'x' }),
		)
		expect(changes.find((c) => c.key === 'name')?.kind).toBe('changed')
		expect(changes.find((c) => c.key === 'role')?.kind).toBe('unchanged')
		expect(changedFields(changes).map((c) => c.key)).toEqual(['name'])
	})

	test('a value changing to NULL is a change, not a removal', () => {
		const changes = diffEntry(
			entry('UPDATE', { email: 'a@b' }, { email: null }),
		)
		expect(changes[0]?.kind).toBe('changed')
	})

	test('nested values compare structurally, not by reference', () => {
		const changes = diffEntry(
			entry('UPDATE', { meta: { a: 1 } }, { meta: { a: 1 } }),
		)
		expect(changes[0]?.kind).toBe('unchanged')
	})
})

describe('redacted updates', () => {
	/**
	 * The trigger writes an UPDATE row only when the row genuinely changed, and
	 * strips excludeColumns from both payloads. An update that touched only a
	 * secret therefore arrives with every audited column identical.
	 */
	test('an all-unchanged UPDATE is flagged as a redacted change', () => {
		const redacted = entry(
			'UPDATE',
			{ id: 1, name: 'alice' },
			{ id: 1, name: 'alice' },
		)
		const changes = diffEntry(redacted)
		expect(changedFields(changes)).toEqual([])
		expect(onlyExcludedColumnsChanged(redacted, changes)).toBe(true)
	})

	test('an ordinary UPDATE with a visible change is not flagged', () => {
		const ordinary = entry('UPDATE', { name: 'alice' }, { name: 'bob' })
		expect(onlyExcludedColumnsChanged(ordinary, diffEntry(ordinary))).toBe(
			false,
		)
	})

	test('operations that legitimately carry no payload are not flagged', () => {
		for (const op of ['INSERT', 'DELETE', 'TRUNCATE'] as const) {
			const e = entry(op, null, null)
			expect(onlyExcludedColumnsChanged(e, diffEntry(e))).toBe(false)
		}
	})
})

describe('revert outcomes', () => {
	test('reverting an INSERT is called out as destructive', () => {
		// It deletes the row, which reliably surprises people.
		const outcome = revertOutcome('INSERT')
		expect(outcome.destructive).toBe(true)
		expect(outcome.verb).toMatch(/delete/i)
	})

	test('restoring operations are not marked destructive', () => {
		expect(revertOutcome('UPDATE').destructive).toBe(false)
		expect(revertOutcome('DELETE').destructive).toBe(false)
	})

	test('TRUNCATE cannot be reverted', () => {
		expect(isRevertible('TRUNCATE')).toBe(false)
		for (const op of ['INSERT', 'UPDATE', 'DELETE'] as const) {
			expect(isRevertible(op)).toBe(true)
		}
	})
})
