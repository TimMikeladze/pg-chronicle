'use client'

import Link from 'next/link'

import { ChangeSummary } from '@/components/entry-diff'
import { RelativeTime } from '@/components/relative-time'
import { OperationBadge } from '@/components/status'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { truncate } from '@/lib/format'
import { railStyle } from '@/lib/operations'
import type { AuditEntryWire } from '@/lib/types'

/**
 * The one list of audit entries in the product.
 *
 * Recent activity, search results, and a table's own feed are the same rows
 * with the same columns — they differed only in which columns were redundant
 * for the context. Three near-identical tables meant three places to fix a
 * column, and three subtly different renderings of the same actor field.
 *
 * `columns` hides what the surrounding context already states: a table-scoped
 * page does not repeat the table name in every row, and a page that cannot
 * open an inspector renders the record as a link instead.
 */
export interface EntryTableColumns {
	/** Hide when every row is from the same table (a table-scoped page). */
	table?: boolean
	/** Hide when the diff is not the point (a compact overview feed). */
	changes?: boolean
	entry?: boolean
}

/**
 * App actor is the application's own user id and exists only when the app ran
 * `SET LOCAL pg-chronicle.actor`; DB role is the Postgres login and always exists.
 * Labelling the fallback stops `postgres` from being read as a person.
 */
function Actor({ entry }: { entry: AuditEntryWire }) {
	if (entry.appActor) return <>{entry.appActor}</>
	if (entry.dbUser) {
		return (
			<span className="text-muted-foreground">
				{entry.dbUser}
				<span className="text-muted-foreground/60"> (role)</span>
			</span>
		)
	}
	return <span className="text-muted-foreground/60">—</span>
}

export function EntryTable({
	entries,
	columns = {},
	onInspect,
}: {
	entries: AuditEntryWire[]
	columns?: EntryTableColumns
	/**
	 * When provided, a row opens the inspector. When omitted the record id is a
	 * link to its timeline instead — a row must always lead somewhere.
	 */
	onInspect?: (entry: AuditEntryWire) => void
}) {
	const show = {
		table: columns.table ?? true,
		changes: columns.changes ?? true,
		entry: columns.entry ?? true,
	}

	return (
		<Table>
			<TableHeader>
				{/*
				 * Every column but `Changed columns` holds a short identifier, so each
				 * is sized to its content and the slack collects in the one column
				 * that can use it. Sizing them all evenly left a void mid-row.
				 */}
				<TableRow className="hover:bg-transparent">
					<TableHead className="w-[1%] pl-4 whitespace-nowrap">When</TableHead>
					<TableHead className="w-[1%]">Operation</TableHead>
					{show.table ? <TableHead className="w-[1%]">Table</TableHead> : null}
					<TableHead className="w-[1%]">Record</TableHead>
					{show.changes ? <TableHead>Changed columns</TableHead> : null}
					<TableHead className={show.changes ? 'w-[1%]' : ''}>Actor</TableHead>
					{show.entry ? (
						<TableHead className="w-[1%] pr-4 text-right">Entry</TableHead>
					) : null}
				</TableRow>
			</TableHeader>
			<TableBody>
				{entries.map((entry) => (
					<TableRow
						key={entry.id}
						className={
							onInspect
								? 'op-rail focus-visible:ring-ring cursor-pointer focus-visible:ring-1 focus-visible:outline-none'
								: 'op-rail'
						}
						style={railStyle(entry.operation)}
						{...(onInspect
							? {
									onClick: () => onInspect(entry),
									tabIndex: 0,
									onKeyDown: (event: React.KeyboardEvent) => {
										if (event.key === 'Enter' || event.key === ' ') {
											event.preventDefault()
											onInspect(entry)
										}
									},
								}
							: {})}
					>
						<TableCell className="pl-4">
							<RelativeTime
								iso={entry.changedAt}
								className="text-muted-foreground font-mono text-xs whitespace-nowrap"
							/>
						</TableCell>
						<TableCell>
							<OperationBadge operation={entry.operation} />
						</TableCell>
						{show.table ? (
							<TableCell className="font-mono text-xs whitespace-nowrap">
								<Link
									href={`/tables/${encodeURIComponent(entry.tableName)}`}
									className="decoration-border underline underline-offset-4 transition-colors hover:decoration-current"
									onClick={(event) => event.stopPropagation()}
								>
									{entry.tableName}
								</Link>
							</TableCell>
						) : null}
						<TableCell className="font-mono text-xs">
							{onInspect ? (
								truncate(entry.recordId, 28)
							) : (
								<Link
									href={`/history/${encodeURIComponent(entry.tableName)}/${encodeURIComponent(entry.recordId)}`}
									className="decoration-border underline underline-offset-4 transition-colors hover:decoration-current"
								>
									{truncate(entry.recordId, 28)}
								</Link>
							)}
						</TableCell>
						{show.changes ? (
							<TableCell>
								<ChangeSummary entry={entry} />
							</TableCell>
						) : null}
						<TableCell className="font-mono text-xs whitespace-nowrap">
							<Actor entry={entry} />
						</TableCell>
						{show.entry ? (
							<TableCell className="text-muted-foreground pr-4 text-right font-mono text-xs">
								#{entry.id}
							</TableCell>
						) : null}
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}
