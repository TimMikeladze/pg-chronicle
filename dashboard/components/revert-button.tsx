'use client'

import { UndoIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { revertAction } from '@/app/actions'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { isRevertible, revertOutcome } from '@/lib/diff'
import type { AuditEntryWire } from '@/lib/types'

export function RevertButton({
	entry,
	onReverted,
}: {
	entry: AuditEntryWire
	onReverted?: () => void
}) {
	const [open, setOpen] = useState(false)
	const [suppress, setSuppress] = useState(false)
	const [pending, startTransition] = useTransition()
	const router = useRouter()

	const outcome = revertOutcome(entry.operation)

	if (!isRevertible(entry.operation)) {
		return (
			<Button variant="outline" size="sm" disabled title={outcome.detail}>
				<UndoIcon />
				Not revertible
			</Button>
		)
	}

	function confirm() {
		startTransition(async () => {
			const result = await revertAction({
				table: entry.tableName,
				recordId: entry.recordId,
				auditEntryId: entry.id,
				suppressAuditTriggers: suppress,
			})
			if (result.ok) {
				toast.success('Reverted', {
					description: `${entry.tableName} · ${entry.recordId} — ${outcome.verb.toLowerCase()}.`,
				})
				setOpen(false)
				onReverted?.()
				router.refresh()
			} else {
				toast.error('Revert failed', { description: result.message })
			}
		})
	}

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button variant="outline" size="sm">
					<UndoIcon />
					Revert
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					{/* The outcome is stated up front: reverting an INSERT deletes the
					    row, which is not what "revert" suggests to most people. */}
					<AlertDialogTitle>{outcome.verb}?</AlertDialogTitle>
					<AlertDialogDescription>{outcome.detail}</AlertDialogDescription>
				</AlertDialogHeader>

				<dl className="bg-inset grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 text-xs">
					<dt className="text-muted-foreground">Table</dt>
					<dd className="font-mono">{entry.tableName}</dd>
					<dt className="text-muted-foreground">Record</dt>
					<dd className="font-mono break-all">{entry.recordId}</dd>
					<dt className="text-muted-foreground">Audit entry</dt>
					<dd className="font-mono">#{entry.id}</dd>
				</dl>

				{/*
				 * `suppressAuditTriggers` is off by default and stays that way unless
				 * explicitly chosen: recording the revert is the repudiation defense,
				 * and suppressing it needs SUPERUSER or pg_replication (PG 16+), so a
				 * silent default would fail on least-privilege roles.
				 */}
				<label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-xs">
					<input
						type="checkbox"
						checked={suppress}
						onChange={(event) => setSuppress(event.target.checked)}
						disabled={pending}
						className="accent-primary mt-0.5 size-3.5"
					/>
					<span>
						<span className="text-ink font-medium">
							Do not audit this revert
						</span>
						<span className="text-muted-foreground mt-0.5 block">
							Requires SUPERUSER or the <code>pg_replication</code> role
							(PostgreSQL 16+). Leave off unless you are avoiding
							revert-of-revert chains — recording the revert is what keeps the
							trail non-repudiable.
						</span>
					</span>
				</label>

				<p className="text-muted-foreground text-xs">
					{suppress
						? 'The revert will not appear in this record’s timeline.'
						: /*
							 * Deliberately specific: the new entry is attributed to the
							 * database role, not to this dashboard's actor. pghistory logs
							 * the JWT `sub` on its own log line, but never writes it to
							 * app_actor — so the audit row alone does not say who did it.
							 */
							'The revert is itself an audited write, so it appears in this record’s timeline as a new entry — attributed to the database role. The dashboard actor is recorded in the server log, not on the audit row.'}
				</p>

				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault()
							confirm()
						}}
						disabled={pending}
						className={
							outcome.destructive
								? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
								: undefined
						}
					>
						{pending ? 'Reverting…' : outcome.verb}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
