'use client'

import { PlayIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { runArchivalAction } from '@/app/actions'
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

export function RunArchivalButton() {
	const [open, setOpen] = useState(false)
	const [pending, startTransition] = useTransition()
	const router = useRouter()

	function confirm() {
		startTransition(async () => {
			const result = await runArchivalAction()
			if (result.ok) {
				toast.success('Archival run finished', {
					description: `Status: ${result.value.status}`,
				})
				router.refresh()
			} else {
				toast.error('Archival failed', { description: result.message })
			}
			setOpen(false)
		})
	}

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button variant="outline">
					<PlayIcon />
					Run archival
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Run archival now?</AlertDialogTitle>
					<AlertDialogDescription>
						This uploads eligible audit rows to S3 as Parquet, then soft-deletes
						and hard-deletes according to your retention policy and grace
						period. Rows past the grace period are permanently removed from the
						database. The run holds an advisory lock, so it is safe alongside a
						scheduled run.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault()
							confirm()
						}}
						disabled={pending}
					>
						{pending ? 'Running…' : 'Run archival'}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
