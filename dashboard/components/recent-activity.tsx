'use client'

import { EntryTable } from '@/components/entry-table'
import { Callout } from '@/components/status'
import type { AuditEntryWire } from '@/lib/types'

/**
 * The overview's feed. Nothing here but framing: the rows themselves are the
 * same EntryTable used by search and by a table's own page, so a column fix
 * lands in one place.
 *
 * The diff column is dropped — the overview answers "what is happening", and
 * the changed-column list is detail that belongs where an entry can be opened.
 */
export function RecentActivity({
	entries,
	error,
}: {
	entries: AuditEntryWire[]
	error?: string | null
}) {
	// A failed read must not render as "nothing has happened".
	if (error) {
		return (
			<div className="p-4">
				<Callout tone="warning" title="Recent activity unavailable">
					{error}
				</Callout>
			</div>
		)
	}

	if (entries.length === 0) {
		return (
			<p className="text-muted-foreground px-4 py-10 text-center text-[13px] leading-relaxed">
				No changes recorded yet. Triggers capture writes from the moment{' '}
				<code className="text-foreground font-mono text-xs">setup()</code> ran —
				rows written before that have no history.
			</p>
		)
	}

	return <EntryTable entries={entries} columns={{ changes: false }} />
}
