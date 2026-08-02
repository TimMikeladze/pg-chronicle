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

/** Straight to one record's timeline, for the "a customer emailed about order 4821" case. */
export function RecordJump({ tables }: { tables: string[] }) {
	const router = useRouter()
	const [table, setTable] = useState(tables[0] ?? '')
	const [recordId, setRecordId] = useState('')

	const canGo = table !== '' && recordId.trim() !== ''

	return (
		<form
			className="flex flex-wrap items-end gap-3"
			onSubmit={(event) => {
				event.preventDefault()
				if (!canGo) return
				router.push(
					`/history/${encodeURIComponent(table)}/${encodeURIComponent(recordId.trim())}`,
				)
			}}
		>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="jump-table">Table</Label>
				<Select value={table} onValueChange={setTable}>
					<SelectTrigger id="jump-table" className="w-44">
						<SelectValue placeholder="Select a table" />
					</SelectTrigger>
					<SelectContent>
						{tables.map((name) => (
							<SelectItem key={name} value={name}>
								{name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="jump-record">Record ID</Label>
				<Input
					id="jump-record"
					value={recordId}
					onChange={(event) => setRecordId(event.target.value)}
					placeholder="1"
					className="w-56 font-mono"
				/>
			</div>

			<Button type="submit" disabled={!canGo}>
				View timeline
				<ArrowRightIcon />
			</Button>
		</form>
	)
}
