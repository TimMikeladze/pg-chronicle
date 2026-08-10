'use client'

import { ArrowDownUpIcon, ChevronRightIcon } from 'lucide-react'
import { useCallback, useState, useTransition } from 'react'

import { loadHistoryPageAction } from '@/app/actions'
import { ChangeSummary, EntryDiff } from '@/components/entry-diff'
import { RelativeTime } from '@/components/relative-time'
import { RevertButton } from '@/components/revert-button'
import { Callout, OperationBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { operationColor } from '@/lib/operations'
import type { AuditEntryWire } from '@/lib/types'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 25

/**
 * One event on the spine.
 *
 * The signature device of the product: a continuous rule down the gutter with a
 * node per event, each node in its operation's hue. Read top to bottom, a
 * record's entire life is a colored barcode — which operations, in what order,
 * how bunched in time — before a single value is expanded.
 */
function Entry({ entry, isLast }: { entry: AuditEntryWire; isLast: boolean }) {
	const [expanded, setExpanded] = useState(false)
	const color = operationColor(entry.operation)

	return (
		<li className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
			{/*
			 * The rule spans this entry's full height — from the top of the row, not
			 * from the node — so consecutive entries butt together into one unbroken
			 * spine across the card gutter. The last entry draws none, ending the
			 * spine on the final node rather than trailing into empty space.
			 */}
			{isLast ? null : (
				<span
					aria-hidden
					className="bg-border absolute inset-y-0 left-[7px] w-px"
				/>
			)}
			{/* Opaque fill so the rule passes behind the node, not through it. */}
			<span
				aria-hidden
				className="bg-background relative z-10 mt-1.5 size-3.5 rounded-full border-2"
				style={{ borderColor: color }}
			/>

			<div className="min-w-0 pb-4">
				<div className="bg-card overflow-hidden rounded-lg border">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
						<OperationBadge operation={entry.operation} />
						{/*
						 * The changed columns, not the operation verb, are what tell two
						 * entries apart. A row edited sixty times renders sixty identical
						 * "Row modified" lines unless the fields that moved are on the
						 * collapsed row — so the summary is here, and `verb` is dropped
						 * as a restatement of the badge beside it.
						 */}
						<ChangeSummary entry={entry} />
						<RelativeTime
							iso={entry.changedAt}
							className="text-muted-foreground font-mono text-xs"
						/>

						{/* `ml-auto` only once there is room for it: below sm the metadata
						    cluster wraps to its own line rather than being squeezed
						    against the operation badge. */}
						<div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] sm:ml-auto">
							{/* An app actor is an application user, a DB role is a Postgres
							    login. Labelling the role case stops "postgres" from being
							    read as a person. */}
							<span title="Who performed this change">
								{entry.appActor ??
									(entry.dbUser ? `${entry.dbUser} (role)` : 'unattributed')}
							</span>
							{entry.clientAddr ? (
								<span title="Client network address">{entry.clientAddr}</span>
							) : null}
							<span title="Audit entry id">#{entry.id}</span>
						</div>
					</div>

					<div className="flex flex-wrap items-center gap-1 border-t px-2 py-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setExpanded((value) => !value)}
							aria-expanded={expanded}
						>
							<ChevronRightIcon
								className={cn('transition-transform', expanded && 'rotate-90')}
							/>
							{expanded ? 'Hide changes' : 'Show changes'}
						</Button>
						<RevertButton entry={entry} />
					</div>

					{expanded ? (
						<div className="border-t p-4">
							<EntryDiff entry={entry} />
						</div>
					) : null}
				</div>
			</div>
		</li>
	)
}

export function RecordTimeline({
	table,
	recordId,
	initialEntries,
	initialCursor,
	initialHasMore,
}: {
	table: string
	recordId: string
	initialEntries: AuditEntryWire[]
	initialCursor: string | null
	initialHasMore: boolean
}) {
	const [order, setOrder] = useState<'asc' | 'desc'>('desc')
	const [entries, setEntries] = useState(initialEntries)
	const [cursor, setCursor] = useState(initialCursor)
	const [hasMore, setHasMore] = useState(initialHasMore)
	const [error, setError] = useState<string | null>(null)
	const [pending, startTransition] = useTransition()

	const load = useCallback(
		(nextOrder: 'asc' | 'desc', nextCursor: string | undefined) => {
			startTransition(async () => {
				const result = await loadHistoryPageAction({
					table,
					recordId,
					order: nextOrder,
					cursor: nextCursor,
					limit: PAGE_SIZE,
				})
				if (result.ok) {
					setEntries((prev) =>
						nextCursor ? [...prev, ...result.value.data] : result.value.data,
					)
					setCursor(result.value.nextCursor)
					setHasMore(result.value.hasMore)
					setError(null)
				} else {
					setError(result.message)
				}
			})
		},
		[table, recordId],
	)

	function toggleOrder() {
		const next = order === 'desc' ? 'asc' : 'desc'
		setOrder(next)
		// Cursors are direction-bound: reversing the sort invalidates the current
		// one, so the timeline restarts from the first page.
		setCursor(null)
		load(next, undefined)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<span className="text-muted-foreground font-mono text-[11px]">
					{entries.length} {entries.length === 1 ? 'entry' : 'entries'}
					{hasMore ? ' loaded' : ''}
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={toggleOrder}
					disabled={pending}
				>
					<ArrowDownUpIcon />
					{order === 'desc' ? 'Newest first' : 'Oldest first'}
				</Button>
			</div>

			{error ? <Callout title="Could not load history">{error}</Callout> : null}

			{entries.length === 0 ? (
				<div className="relative overflow-hidden rounded-lg border border-dashed">
					<div aria-hidden className="grid-field absolute inset-0 opacity-40" />
					<div className="text-muted-foreground relative mx-auto max-w-lg px-6 py-14 text-center text-[13px] leading-relaxed">
						<p className="text-ink mb-2 text-sm font-medium">
							No audit entries for this record
						</p>
						<p>
							Three things produce this: the row has not been written since
							triggers were installed, the id does not match the primary key
							pg-history recorded, or the history has already been archived —
							soft-deleted entries are filtered out of every read and live in
							S3.
						</p>
					</div>
				</div>
			) : (
				<ul className="flex flex-col">
					{entries.map((entry, index) => (
						<Entry
							key={entry.id}
							entry={entry}
							isLast={index === entries.length - 1}
						/>
					))}
				</ul>
			)}

			{hasMore ? (
				<Button
					variant="outline"
					className="self-center"
					onClick={() => load(order, cursor ?? undefined)}
					disabled={pending || !cursor}
				>
					{pending ? 'Loading…' : 'Load more'}
				</Button>
			) : null}
		</div>
	)
}
