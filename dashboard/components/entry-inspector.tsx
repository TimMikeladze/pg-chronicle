'use client'

import { ArrowRightIcon } from 'lucide-react'
import Link from 'next/link'

import { EntryDiff } from '@/components/entry-diff'
import { RelativeTime } from '@/components/relative-time'
import { RevertButton } from '@/components/revert-button'
import { OperationBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { absoluteTime } from '@/lib/format'
import { OPERATION_META, railStyle } from '@/lib/operations'
import type { AuditEntryWire } from '@/lib/types'

/**
 * Provenance is the reason an audit trail exists, so all three identity fields
 * are shown separately and always — never collapsed to whichever is non-null.
 * They answer different questions and a missing one is itself information:
 *
 * - DB role (`current_user`) is who Postgres authenticated. Always present.
 * - App actor is the application's own user id, and is NULL unless the app ran
 *   `SET LOCAL pg-chronicle.actor` before the write. "not set" therefore means the
 *   application is not attributing its writes, not that nobody did it.
 * - Client address is NULL over a unix socket, which is the normal case for a
 *   colocated app server — so "local socket" is a fact, not a gap.
 */
function Provenance({ entry }: { entry: AuditEntryWire }) {
	const rows: Array<{ label: string; value: string; muted?: boolean }> = [
		{ label: 'Entry', value: `#${entry.id}` },
		{ label: 'Table', value: entry.tableName },
		{ label: 'Record', value: entry.recordId },
		{ label: 'Changed at', value: absoluteTime(entry.changedAt) },
		{ label: 'DB role', value: entry.dbUser ?? '—', muted: !entry.dbUser },
		{
			label: 'App actor',
			value: entry.appActor ?? 'not set',
			muted: !entry.appActor,
		},
		{
			label: 'Client address',
			value: entry.clientAddr ?? 'local socket',
			muted: !entry.clientAddr,
		},
	]

	return (
		<dl className="bg-inset grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 rounded-lg border p-4 text-xs">
			{rows.map((row) => (
				<div key={row.label} className="contents">
					<dt className="text-muted-foreground">{row.label}</dt>
					<dd
						className={
							row.muted
								? 'text-muted-foreground/70 font-mono break-all italic'
								: 'text-foreground font-mono break-all'
						}
					>
						{row.value}
					</dd>
				</div>
			))}
		</dl>
	)
}

/**
 * Right-hand sheet rather than a centered modal: it is opened from a result
 * row, and covering that row loses the context the operator was scanning.
 */
export function EntryInspector({
	entry,
	open,
	onOpenChange,
	showTimelineLink = true,
}: {
	entry: AuditEntryWire | null
	open: boolean
	onOpenChange: (open: boolean) => void
	showTimelineLink?: boolean
}) {
	if (!entry) return null

	const meta = OPERATION_META[entry.operation]

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				side="right"
				className="op-rail gap-5 overflow-y-auto sm:max-w-xl"
				style={railStyle(entry.operation)}
			>
				<DialogHeader>
					<DialogTitle className="flex flex-wrap items-center gap-2">
						<OperationBadge operation={entry.operation} />
						<span className="text-ink text-sm font-medium">{meta.verb}</span>
					</DialogTitle>
					<DialogDescription className="font-mono text-xs break-all">
						{entry.tableName} · {entry.recordId}
					</DialogDescription>
					<p className="text-muted-foreground text-xs">
						<RelativeTime iso={entry.changedAt} /> · {meta.captured}
					</p>
				</DialogHeader>

				<Provenance entry={entry} />
				<EntryDiff entry={entry} />

				<div className="flex flex-wrap items-center gap-2 border-t pt-4">
					<RevertButton entry={entry} onReverted={() => onOpenChange(false)} />
					{showTimelineLink ? (
						<Button asChild variant="ghost" size="sm">
							<Link
								href={`/history/${encodeURIComponent(entry.tableName)}/${encodeURIComponent(entry.recordId)}`}
							>
								Full timeline
								<ArrowRightIcon />
							</Link>
						</Button>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	)
}
