import Link from 'next/link'

import { OperationBadge } from '@/components/status'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { absoluteTime, relativeTime, truncate } from '@/lib/format'
import type { AuditEntryWire } from '@/lib/types'

/**
 * The most recent changes across every audited table. This is the one panel
 * that is useful in every configuration — without it the overview is empty for
 * deployments that have not enabled the archiver.
 */
export function RecentActivity({ entries }: { entries: AuditEntryWire[] }) {
	if (entries.length === 0) {
		return (
			<p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
				No changes recorded yet. Triggers capture writes from the moment{' '}
				<code className="font-mono text-xs">setup()</code> ran — earlier rows
				have no history.
			</p>
		)
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="pl-6">When</TableHead>
					<TableHead>Operation</TableHead>
					<TableHead>Table</TableHead>
					<TableHead>Record</TableHead>
					<TableHead className="pr-6">Actor</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{entries.map((entry) => (
					<TableRow key={entry.id}>
						<TableCell
							className="text-muted-foreground pl-6"
							title={absoluteTime(entry.changedAt)}
						>
							{relativeTime(entry.changedAt)}
						</TableCell>
						<TableCell>
							<OperationBadge operation={entry.operation} />
						</TableCell>
						<TableCell className="font-mono text-xs">
							{entry.tableName}
						</TableCell>
						<TableCell>
							<Link
								href={`/history/${encodeURIComponent(entry.tableName)}/${encodeURIComponent(entry.recordId)}`}
								className="font-mono text-xs underline-offset-4 hover:underline"
							>
								{truncate(entry.recordId, 24)}
							</Link>
						</TableCell>
						<TableCell className="text-muted-foreground pr-6 font-mono text-xs">
							{entry.appActor ?? entry.dbUser ?? '—'}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}
