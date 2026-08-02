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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@/components/ui/tooltip'

export function RunArchivalButton({ available }: { available: boolean }) {
	const [open, setOpen] = useState(false)
	const [pending, startTransition] = useTransition()
	const router = useRouter()

	if (!available) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					{/*
					 * `aria-disabled` rather than `disabled`: a disabled button is
					 * removed from the tab order and swallows pointer events, so the
					 * tooltip explaining *why* it is unavailable would be unreachable by
					 * both keyboard and hover. This stays focusable and inert.
					 */}
					<Button
						variant="outline"
						aria-disabled
						onClick={(event) => event.preventDefault()}
						className="opacity-50"
					>
						<PlayIcon />
						Run archival
					</Button>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					CRON_SECRET is set, so POST /api/archive requires that exact bearer
					token — which cannot also satisfy the JWT middleware guarding /api/*.
					Trigger archival from your scheduler instead.
				</TooltipContent>
			</Tooltip>
		)
	}

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
