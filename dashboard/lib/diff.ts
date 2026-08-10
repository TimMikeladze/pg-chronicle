import type { AuditEntryWire, Operation } from './types'

export type FieldChangeKind = 'added' | 'removed' | 'changed' | 'unchanged'

export interface FieldChange {
	key: string
	kind: FieldChangeKind
	before: unknown
	after: unknown
}

/**
 * Stable, human-readable rendering of a jsonb value for side-by-side display.
 * `undefined` means "this key did not exist on that side", which is different
 * from a SQL NULL — the two must not render identically or a nulled-out column
 * looks the same as a dropped one.
 */
export function renderValue(value: unknown): string {
	if (value === undefined) return '—'
	if (value === null) return 'null'
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value)
	}
	return JSON.stringify(value, null, 2)
}

function isEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === null || b === null || a === undefined || b === undefined) {
		return false
	}
	if (typeof a !== 'object' || typeof b !== 'object') return false
	// jsonb round-trips through JSON, so structural comparison is sound here.
	return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Field-level diff of one audit entry.
 *
 * Driven by key presence, which the operation already determines: an INSERT
 * carries only `newData` so every key reads as an addition, a DELETE only
 * `oldData` so every key reads as a removal, and TRUNCATE carries neither and
 * yields nothing. An entry with an empty payload therefore produces no rows —
 * see `onlyExcludedColumnsChanged` for the case where that is meaningful
 * rather than empty.
 */
export function diffEntry(entry: AuditEntryWire): FieldChange[] {
	const before = entry.oldData ?? {}
	const after = entry.newData ?? {}
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
	keys.sort((a, b) => a.localeCompare(b))

	return keys.map((key) => {
		const hasBefore = key in before
		const hasAfter = key in after
		const beforeValue = hasBefore ? before[key] : undefined
		const afterValue = hasAfter ? after[key] : undefined

		let kind: FieldChangeKind
		if (!hasBefore) kind = 'added'
		else if (!hasAfter) kind = 'removed'
		else if (isEqual(beforeValue, afterValue)) kind = 'unchanged'
		else kind = 'changed'

		return { key, kind, before: beforeValue, after: afterValue }
	})
}

/** Diff rows worth showing by default — unchanged columns are noise on wide tables. */
export function changedFields(changes: FieldChange[]): FieldChange[] {
	return changes.filter((c) => c.kind !== 'unchanged')
}

/**
 * True when an UPDATE recorded a change that the diff cannot show.
 *
 * The trigger only writes an UPDATE row when the whole row actually changed,
 * but it strips `excludeColumns` from both payloads. So an update that touched
 * nothing but a secret arrives here with every audited column identical — the
 * entry means "a redacted column changed at this time", and rendering it as an
 * empty diff or "no columns" reads as a bug instead.
 */
export function onlyExcludedColumnsChanged(
	entry: AuditEntryWire,
	changes: FieldChange[],
): boolean {
	return (
		entry.operation === 'UPDATE' &&
		changes.length > 0 &&
		changes.every((c) => c.kind === 'unchanged')
	)
}

/**
 * What reverting a given entry actually does. Reverting an INSERT deletes the
 * row, which reliably surprises people, so the confirmation dialog states the
 * outcome rather than asking a generic "are you sure?".
 */
export function revertOutcome(operation: Operation): {
	verb: string
	detail: string
	destructive: boolean
} {
	switch (operation) {
		case 'INSERT':
			return {
				verb: 'Delete the row',
				detail:
					'This entry recorded the row being created, so reverting it removes the row entirely.',
				destructive: true,
			}
		case 'UPDATE':
			return {
				verb: 'Restore the previous values',
				detail:
					'The row is written back to the "before" state captured in this entry.',
				destructive: false,
			}
		case 'DELETE':
			return {
				verb: 'Re-insert the row',
				detail:
					'The deleted row is restored from the values captured in this entry.',
				destructive: false,
			}
		case 'TRUNCATE':
			return {
				verb: 'Not revertible',
				detail:
					'TRUNCATE is recorded as a table-level marker and carries no row data to restore.',
				destructive: false,
			}
	}
}

export function isRevertible(operation: Operation): boolean {
	return operation !== 'TRUNCATE'
}
