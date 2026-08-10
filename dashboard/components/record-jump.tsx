'use client'

import { ArrowRightIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'

/**
 * Straight to one record's timeline, for the "a customer emailed about order
 * 4821" case — the most common way anyone actually arrives at this tool.
 *
 * Shaped as a single command bar rather than a form in a card: table selector
 * and id fuse into one control, because neither is useful alone. On a
 * table-scoped page `fixedTable` is set and the selector disappears rather than
 * restating what the page already says.
 */
export function RecordJump({
	tables,
	fixedTable,
}: {
	tables: string[]
	/** When set, the table is not selectable — the page already scopes it. */
	fixedTable?: string
}) {
	const router = useRouter()
	const [table, setTable] = useState(fixedTable ?? tables[0] ?? '')
	const [recordId, setRecordId] = useState('')

	const effectiveTable = fixedTable ?? table
	const canGo = effectiveTable !== '' && recordId.trim() !== ''

	return (
		<form
			className="bg-card flex flex-wrap items-stretch overflow-hidden rounded-lg border sm:flex-nowrap"
			onSubmit={(event) => {
				event.preventDefault()
				if (!canGo) return
				router.push(
					`/history/${encodeURIComponent(effectiveTable)}/${encodeURIComponent(recordId.trim())}`,
				)
			}}
		>
			<Label htmlFor="jump-record" className="sr-only">
				Record ID
			</Label>

			{fixedTable ? null : (
				<>
					<Label htmlFor="jump-table" className="sr-only">
						Table
					</Label>
					<Select value={table} onValueChange={setTable}>
						<SelectTrigger
							id="jump-table"
							className="w-full rounded-none border-0 border-b font-mono text-xs shadow-none focus-visible:ring-0 sm:w-48 sm:border-r sm:border-b-0"
						>
							<SelectValue placeholder="Table" />
						</SelectTrigger>
						<SelectContent>
							{tables.map((name) => (
								<SelectItem key={name} value={name}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</>
			)}

			<Input
				id="jump-record"
				value={recordId}
				onChange={(event) => setRecordId(event.target.value)}
				placeholder="Primary key value — e.g. 4821"
				// PgHistory bounds recordId at 500 characters (the HTTP route at
				// 512). Stopping it here beats a round trip that 400s.
				maxLength={500}
				className="min-w-0 flex-1 rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-0"
			/>

			<Button
				type="submit"
				disabled={!canGo}
				variant="ghost"
				className="rounded-none border-t sm:border-t-0 sm:border-l"
			>
				Open timeline
				<ArrowRightIcon />
			</Button>
		</form>
	)
}
