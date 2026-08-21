'use client'

import { Trash2Icon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { deleteConnectionAction } from '@/app/connections/actions'
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

/**
 * Removing a connection unlinks it from the dashboard. The dialog says so
 * explicitly: the obvious fear when deleting something from an audit tool is
 * that the audit trail goes with it, and it does not.
 */
export function DeleteConnectionButton({
	id,
	name,
}: {
	id: string
	name: string
}) {
	const [open, setOpen] = useState(false)
	const [pending, startTransition] = useTransition()
	const router = useRouter()

	function confirm() {
		startTransition(async () => {
			await deleteConnectionAction(id)
			toast.success(`Removed ${name}`, {
				description: 'The audit triggers and recorded history are untouched.',
			})
			setOpen(false)
			router.refresh()
		})
	}

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button variant="ghost" size="icon" title="Remove connection">
					<Trash2Icon />
					<span className="sr-only">Remove {name}</span>
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove {name}?</AlertDialogTitle>
					<AlertDialogDescription>
						This removes the connection from the dashboard only. The audit
						triggers stay installed and every recorded change stays in the
						database — add the connection again to see them.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							// The dialog closes on its own after the action resolves, so the
							// default close-on-click would hide the pending state.
							event.preventDefault()
							confirm()
						}}
						disabled={pending}
					>
						{pending ? 'Removing…' : 'Remove'}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
