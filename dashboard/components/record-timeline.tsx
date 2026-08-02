'use client'

import { ArrowDownUpIcon } from 'lucide-react'
import { useCallback, useState, useTransition } from 'react'

import { loadHistoryPageAction } from '@/app/actions'
import { EntryDiff } from '@/components/entry-diff'
import { RevertButton } from '@/components/revert-button'
import { OperationBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { absoluteTime, relativeTime } from '@/lib/format'
import type { AuditEntryWire } from '@/lib/types'

const PAGE_SIZE = 25

function Entry({ entry, isLast }: { entry: AuditEntryWire; isLast: boolean }) {
	const [expanded, setExpanded] = useState(false)

	return (
		<li className="relative pl-8">
			{/* Timeline rail: the dot sits on the line running down the gutter. The
			    last entry draws no line, so the rail ends on the final dot rather
			    than trailing into empty space. */}
			{isLast ? null : (
				<span
					aria-hidden
					className="bg-border absolute top-3 left-[7px] h-full w-px"
				/>
			)}
			<span
				aria-hidden
				className="bg-background border-border absolute top-2 left-0 size-3.5 rounded-full border-2"
			/>

			<div className="bg-card mb-4 rounded-xl border">
				<div className="flex flex-wrap items-center gap-3 p-4">
					<OperationBadge operation={entry.operation} />
					<span
						className="text-muted-foreground text-sm"
						title={absoluteTime(entry.changedAt)}
					>
						{relativeTime(entry.changedAt)}
					</span>
					<span className="text-muted-foreground font-mono text-xs">
						#{entry.id}
					</span>
					<span className="text-muted-foreground ml-auto font-mono text-xs">
						{entry.appActor ?? entry.dbUser ?? 'unknown actor'}
						{entry.clientAddr ? ` · ${entry.clientAddr}` : ''}
					</span>
				</div>

				<div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setExpanded((value) => !value)}
						aria-expanded={expanded}
					>
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
			<div className="flex items-center justify-between gap-3">
				<span className="text-muted-foreground text-sm">
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

			{error ? (
				<div
					className="rounded-lg border p-4 text-sm"
					style={{
						borderColor:
							'color-mix(in srgb, var(--status-critical) 45%, transparent)',
						backgroundColor:
							'color-mix(in srgb, var(--status-critical) 8%, transparent)',
					}}
				>
					{error}
				</div>
			) : null}

			{entries.length === 0 ? (
				<p className="text-muted-foreground mx-auto max-w-xl rounded-xl border border-dashed p-8 text-center text-sm">
					No audit entries for this record. It may never have been written since
					triggers were installed, the ID may not match the primary key
					pg-history recorded, or its history may already be archived —
					soft-deleted entries are filtered out of every read and live in S3.
				</p>
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
