'use client'

import { ExternalLinkIcon } from 'lucide-react'
import Link from 'next/link'

import { EntryDiff } from '@/components/entry-diff'
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
import { absoluteTime, relativeTime } from '@/lib/format'
import type { AuditEntryWire } from '@/lib/types'

function Provenance({ entry }: { entry: AuditEntryWire }) {
	const rows: Array<[string, string]> = [
		['Audit entry', `#${entry.id}`],
		['Table', entry.tableName],
		['Record', entry.recordId],
		[
			'Changed at',
			`${absoluteTime(entry.changedAt)} (${relativeTime(entry.changedAt)})`,
		],
		['DB role', entry.dbUser ?? '—'],
		// Null unless the app ran `SET LOCAL pg_history.actor` before the write.
		['App actor', entry.appActor ?? 'not set'],
		// inet_client_addr() is null over a local unix socket.
		['Client address', entry.clientAddr ?? 'local socket'],
	]

	return (
		<dl className="bg-inset grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border p-3 text-xs">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="font-mono break-all">{value}</dd>
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

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent side="right" className="gap-5">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<OperationBadge operation={entry.operation} />
						<span className="font-mono text-sm">
							{entry.tableName} · {entry.recordId}
						</span>
					</DialogTitle>
					<DialogDescription>
						{absoluteTime(entry.changedAt)} · {relativeTime(entry.changedAt)}
					</DialogDescription>
				</DialogHeader>

				<Provenance entry={entry} />
				<EntryDiff entry={entry} />

				<div className="flex flex-wrap items-center gap-2">
					<RevertButton entry={entry} onReverted={() => onOpenChange(false)} />
					{showTimelineLink ? (
						<Button asChild variant="ghost" size="sm">
							<Link
								href={`/history/${encodeURIComponent(entry.tableName)}/${encodeURIComponent(entry.recordId)}`}
							>
								Full timeline
								<ExternalLinkIcon />
							</Link>
						</Button>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	)
}
