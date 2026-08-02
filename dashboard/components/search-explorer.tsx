'use client'

import { SearchIcon } from 'lucide-react'
import { useCallback, useMemo, useState, useTransition } from 'react'

import { searchAction, searchNextPageAction } from '@/app/actions'
import { ChangeSummary } from '@/components/entry-diff'
import { EntryInspector } from '@/components/entry-inspector'
import { OperationBadge } from '@/components/status'
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { absoluteTime, relativeTime, truncate } from '@/lib/format'
import {
	type AuditEntryWire,
	SEARCHABLE_OPERATIONS,
	type SearchParams,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const ANY_OPERATION = 'ANY'
const LIMITS = [25, 50, 100, 250]

/** datetime-local yields "2026-01-01T10:00" with no zone; the API wants ISO-8601. */
function toIso(local: string): string | undefined {
	if (!local) return undefined
	const date = new Date(local)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function TableToggle({
	name,
	selected,
	onToggle,
}: {
	name: string
	selected: boolean
	onToggle: () => void
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={selected}
			className={cn(
				'rounded-md border px-2.5 py-1 font-mono text-xs transition-colors',
				selected
					? 'bg-primary text-primary-foreground border-transparent'
					: 'text-muted-foreground hover:text-foreground',
			)}
		>
			{name}
		</button>
	)
}

export function SearchExplorer({ tables }: { tables: string[] }) {
	const [selectedTables, setSelectedTables] = useState<string[]>(tables)
	const [query, setQuery] = useState('')
	const [operation, setOperation] = useState<string>(ANY_OPERATION)
	const [dateFrom, setDateFrom] = useState('')
	const [dateTo, setDateTo] = useState('')
	const [limit, setLimit] = useState(50)

	const [results, setResults] = useState<AuditEntryWire[] | null>(null)
	const [cursor, setCursor] = useState<string | null>(null)
	const [hasMore, setHasMore] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [pending, startTransition] = useTransition()

	const [inspected, setInspected] = useState<AuditEntryWire | null>(null)

	/*
	 * The API treats `query` as a JSONB containment document. Parsing it here
	 * turns a typo into inline feedback instead of a round trip that comes back
	 * as a generic 400.
	 */
	const queryError = useMemo(() => {
		const trimmed = query.trim()
		if (!trimmed) return null
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (
				typeof parsed !== 'object' ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				return 'Containment queries must be a JSON object, e.g. {"email":"a@b.com"}'
			}
			return null
		} catch {
			return 'Not valid JSON'
		}
	}, [query])

	const rangeError =
		dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)
			? 'The "from" date must be on or before the "to" date'
			: null

	const params: SearchParams = useMemo(
		() => ({
			tables: selectedTables,
			query: query.trim() || undefined,
			operation:
				operation === ANY_OPERATION
					? undefined
					: (operation as SearchParams['operation']),
			dateFrom: toIso(dateFrom),
			dateTo: toIso(dateTo),
			limit,
		}),
		[selectedTables, query, operation, dateFrom, dateTo, limit],
	)

	const canSearch =
		selectedTables.length > 0 && !queryError && !rangeError && !pending

	const runSearch = useCallback(() => {
		startTransition(async () => {
			const result = await searchAction(params)
			if (result.ok) {
				setResults(result.value.data)
				setCursor(result.value.nextCursor)
				setHasMore(result.value.hasMore)
				setError(null)
			} else {
				setError(
					result.code === 'RATE_LIMITED'
						? 'Too many searches at once. pg-history caps concurrent searches so an unindexed scan cannot starve the pool — retry in a moment.'
						: result.message,
				)
				setResults(null)
			}
		})
	}, [params])

	const loadMore = useCallback(() => {
		if (!cursor) return
		startTransition(async () => {
			// The cursor came from search(), which paginates descending — it is not
			// interchangeable with a getHistory() cursor.
			const result = await searchNextPageAction(params, cursor)
			if (result.ok) {
				setResults((prev) => [...(prev ?? []), ...result.value.data])
				setCursor(result.value.nextCursor)
				setHasMore(result.value.hasMore)
			} else {
				setError(result.message)
			}
		})
	}, [cursor, params])

	return (
		<div className="flex flex-col gap-6">
			<div className="bg-card flex flex-col gap-4 rounded-xl border p-4">
				<div className="flex flex-col gap-2">
					<Label>Tables</Label>
					<div className="flex flex-wrap items-center gap-1.5">
						{tables.map((name) => (
							<TableToggle
								key={name}
								name={name}
								selected={selectedTables.includes(name)}
								onToggle={() =>
									setSelectedTables((prev) =>
										prev.includes(name)
											? prev.filter((t) => t !== name)
											: [...prev, name],
									)
								}
							/>
						))}
						{selectedTables.length === 0 ? (
							<span className="text-muted-foreground text-xs">
								Select at least one table
							</span>
						) : null}
					</div>
				</div>

				<div className="grid gap-4 md:grid-cols-[2fr_1fr]">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="query">JSON containment</Label>
						<Textarea
							id="query"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={'{"email": "alice@example.com"}'}
							aria-invalid={queryError !== null}
							className="min-h-20 font-mono text-xs"
						/>
						<p
							className={cn(
								'text-xs',
								queryError ? 'text-destructive' : 'text-muted-foreground',
							)}
						>
							{queryError ??
								'Matched against old_data and new_data with the GIN-indexed @> operator. Leave empty to match everything.'}
						</p>
					</div>

					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="operation">Operation</Label>
							<Select value={operation} onValueChange={setOperation}>
								<SelectTrigger id="operation" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ANY_OPERATION}>Any</SelectItem>
									{SEARCHABLE_OPERATIONS.map((op) => (
										<SelectItem key={op} value={op}>
											{op}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="limit">Page size</Label>
							<Select
								value={String(limit)}
								onValueChange={(value) => setLimit(Number(value))}
							>
								<SelectTrigger id="limit" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{LIMITS.map((value) => (
										<SelectItem key={value} value={String(value)}>
											{value}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>

				<div className="flex flex-wrap items-end gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="from">From</Label>
						<Input
							id="from"
							type="datetime-local"
							value={dateFrom}
							onChange={(event) => setDateFrom(event.target.value)}
							className="w-56"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="to">To</Label>
						<Input
							id="to"
							type="datetime-local"
							value={dateTo}
							onChange={(event) => setDateTo(event.target.value)}
							aria-invalid={rangeError !== null}
							className="w-56"
						/>
					</div>
					<Button onClick={runSearch} disabled={!canSearch}>
						<SearchIcon />
						{pending ? 'Searching…' : 'Search'}
					</Button>
					{rangeError ? (
						<p className="text-destructive pb-2 text-xs">{rangeError}</p>
					) : null}
				</div>
			</div>

			{error ? (
				<div
					className="rounded-lg border p-4 text-sm"
					style={{
						borderColor:
							'color-mix(in srgb, var(--status-critical) 45%, transparent)',
						backgroundColor:
							'color-mix(in srgb, var(--status-critical) 8%, transparent)',
					}}
				>
					{error}
				</div>
			) : null}

			{results === null ? (
				<p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
					Run a search to see audit entries.
				</p>
			) : results.length === 0 ? (
				<p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
					No entries matched. Containment matches whole values — try{' '}
					<code className="font-mono text-xs">{'{"status":"active"}'}</code>{' '}
					rather than a partial string.
				</p>
			) : (
				<div className="overflow-hidden rounded-xl border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="pl-4">When</TableHead>
								<TableHead>Operation</TableHead>
								<TableHead>Table</TableHead>
								<TableHead>Record</TableHead>
								<TableHead>Changed columns</TableHead>
								<TableHead className="pr-4">Actor</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{results.map((entry) => (
								<TableRow
									key={entry.id}
									onClick={() => setInspected(entry)}
									className="cursor-pointer"
								>
									<TableCell
										className="text-muted-foreground pl-4"
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
									<TableCell className="font-mono text-xs">
										{truncate(entry.recordId, 24)}
									</TableCell>
									<TableCell>
										<ChangeSummary entry={entry} />
									</TableCell>
									<TableCell className="text-muted-foreground pr-4 font-mono text-xs">
										{entry.appActor ?? entry.dbUser ?? '—'}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>

					<div className="flex items-center justify-between gap-3 border-t px-4 py-3">
						<span className="text-muted-foreground text-xs">
							{results.length} {results.length === 1 ? 'entry' : 'entries'}
							{hasMore ? ' so far' : ''}
						</span>
						{hasMore ? (
							<Button
								variant="outline"
								size="sm"
								onClick={loadMore}
								disabled={pending}
							>
								{pending ? 'Loading…' : 'Load older'}
							</Button>
						) : null}
					</div>
				</div>
			)}

			<EntryInspector
				entry={inspected}
				open={inspected !== null}
				onOpenChange={(open) => {
					if (!open) setInspected(null)
				}}
			/>
		</div>
	)
}
