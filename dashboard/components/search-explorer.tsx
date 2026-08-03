'use client'

import { BracesIcon, GaugeIcon, SearchIcon, TypeIcon } from 'lucide-react'
import { useCallback, useMemo, useState, useTransition } from 'react'

import { searchAction, searchNextPageAction } from '@/app/actions'
import { EntryInspector } from '@/components/entry-inspector'
import { EntryTable } from '@/components/entry-table'
import { EmptyState, Panel, PanelFooter } from '@/components/section'
import { Callout } from '@/components/status'
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
import { Textarea } from '@/components/ui/textarea'
import { tintStyle } from '@/lib/operations'
import {
	type AuditEntryWire,
	SEARCHABLE_OPERATIONS,
	type SearchParams,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const ANY_OPERATION = 'ANY'
const LIMITS = [25, 50, 100, 250]
/** PgHistory validates `query` with a 500-character bound. */
const QUERY_MAX_LENGTH = 500

/** datetime-local yields "2026-01-01T10:00" with no zone; the API wants ISO-8601. */
function toIso(local: string): string | undefined {
	if (!local) return undefined
	const date = new Date(local)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

type QueryMode = 'empty' | 'containment' | 'text'

/**
 * The two query engines have very different costs, and the choice between them
 * is made implicitly by whether the text starts with `{`. Stating the engine,
 * its index, and its timeout as a persistent chip — rather than as a sentence
 * under the field — is the difference between an operator knowing they just
 * asked for an unindexed full scan and finding out via a 429.
 */
const MODE_META: Record<
	QueryMode,
	{
		icon: typeof BracesIcon
		label: string
		index: string
		timeout: string
		color: string | null
		detail: string
	}
> = {
	empty: {
		icon: SearchIcon,
		label: 'Match all',
		index: 'ordered by id',
		timeout: '30s',
		color: null,
		detail:
			'Returns the most recent entries for the selected tables. Add a query to narrow it.',
	},
	containment: {
		icon: BracesIcon,
		label: 'JSONB containment',
		index: 'GIN index',
		timeout: '30s',
		color: 'var(--status-good)',
		detail:
			'Matched against old_data and new_data with @>. Indexed and cheap, but it matches whole values only — {"status":"active"}, never a partial string.',
	},
	text: {
		icon: TypeIcon,
		label: 'ILIKE scan',
		index: 'no index',
		timeout: '5s',
		color: 'var(--status-warning)',
		detail:
			'Case-insensitive substring match over every serialized row. This is an unindexed scan: it is bounded at 5 seconds, counts against the concurrent-search cap, and gets slower as the trail grows.',
	},
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
					: 'text-muted-foreground hover:text-foreground hover:border-border-strong',
			)}
		>
			{name}
		</button>
	)
}

export function SearchExplorer({
	tables,
	initialTable,
}: {
	tables: string[]
	/** Preselects a single table when arriving from that table's page. */
	initialTable?: string
}) {
	const [selectedTables, setSelectedTables] = useState<string[]>(
		initialTable && tables.includes(initialTable) ? [initialTable] : tables,
	)
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
	 * `query` has two server-side modes, chosen by the same shape test used in
	 * PgHistory.buildSearchConditions: a value that starts with `{` and ends
	 * with `}` is parsed as a JSONB containment document and hits the GIN
	 * index; anything else becomes an ILIKE substring scan over old_data and
	 * new_data. Mirroring that test exactly matters — validating everything as
	 * JSON would make plain-text search unreachable.
	 */
	const queryMode = useMemo<QueryMode>(() => {
		const trimmed = query.trim()
		if (!trimmed) return 'empty'
		return trimmed.startsWith('{') && trimmed.endsWith('}')
			? 'containment'
			: 'text'
	}, [query])

	const queryError = useMemo(() => {
		const trimmed = query.trim()
		if (!trimmed) return null
		// PgHistory bounds the query at 500 characters.
		if (trimmed.length > QUERY_MAX_LENGTH) {
			return `Queries are limited to ${QUERY_MAX_LENGTH} characters (currently ${trimmed.length})`
		}
		if (queryMode !== 'containment') return null
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
			// The server rejects this too: it only treats `{…}` as JSON, so a
			// malformed object never silently degrades into a text search.
			return 'Looks like JSON but does not parse. Remove the braces to search as plain text.'
		}
	}, [query, queryMode])

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
						? 'Too many searches running at once. pghistory caps concurrent searches so one unindexed scan cannot starve the connection pool. Retry in a moment, or switch to a containment query.'
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

	const mode = MODE_META[queryMode]
	const ModeIcon = mode.icon

	return (
		<div className="flex flex-col gap-6">
			{/* Query console. Grouped as one bordered instrument rather than loose
			    fields, because every control in it contributes to a single request. */}
			<div className="bg-card flex flex-col divide-y rounded-lg border">
				{/* The nav bar names the audited set; this row subsets it per query,
				    which is a different job and the only place it is editable. */}
				<div className="flex flex-wrap items-center gap-2 px-4 py-3">
					<Label className="eyebrow mr-1">Search in</Label>
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
						<span className="text-status-critical text-xs">
							Select at least one table to search
						</span>
					) : null}
				</div>

				<div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-2">
							<Label htmlFor="query">Query</Label>
							{/* The engine chip is the signature control of this screen: it
							    names the engine, its index, and its timeout, and it changes
							    as you type — so the cost is visible before you commit. */}
							<span
								className={cn(
									'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px]',
									mode.color === null && 'bg-inset text-muted-foreground',
								)}
								style={mode.color === null ? undefined : tintStyle(mode.color)}
							>
								<ModeIcon
									aria-hidden
									className="size-3"
									style={mode.color ? { color: mode.color } : undefined}
								/>
								{mode.label}
								<span className="text-muted-foreground">·</span>
								{mode.index}
								<span className="text-muted-foreground">·</span>
								<GaugeIcon aria-hidden className="size-3" />
								{mode.timeout}
							</span>
						</div>
						<Textarea
							id="query"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								// The console shape invites Enter; without this it inserts a
								// newline into a field that is almost never multi-line.
								if (
									(event.metaKey || event.ctrlKey) &&
									event.key === 'Enter' &&
									canSearch
								) {
									event.preventDefault()
									runSearch()
								}
							}}
							placeholder={'{"email": "alice@example.com"}   ·   or:   alice'}
							aria-invalid={queryError !== null}
							aria-describedby="query-hint"
							className="min-h-[4.5rem] resize-y font-mono text-xs"
						/>
						<p
							id="query-hint"
							className={cn(
								'text-xs leading-relaxed',
								queryError ? 'text-destructive' : 'text-muted-foreground',
							)}
						>
							{queryError ?? mode.detail}
						</p>
					</div>

					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="operation">Operation</Label>
							<Select value={operation} onValueChange={setOperation}>
								<SelectTrigger id="operation" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ANY_OPERATION}>Any operation</SelectItem>
									{SEARCHABLE_OPERATIONS.map((op) => (
										<SelectItem key={op} value={op}>
											{op}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{/* TRUNCATE is recorded by a statement-level trigger but the
							    search API rejects it as a filter value. Saying so beats
							    leaving a hole in the list. */}
							<span className="text-muted-foreground text-[11px]">
								TRUNCATE is recorded but cannot be filtered.
							</span>
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
											{value} per page
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>

				<div className="flex flex-wrap items-end gap-3 px-4 py-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="from">From</Label>
						<Input
							id="from"
							type="datetime-local"
							value={dateFrom}
							onChange={(event) => setDateFrom(event.target.value)}
							className="w-full font-mono text-xs sm:w-52"
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
							className="w-full font-mono text-xs sm:w-52"
						/>
					</div>

					<Button
						onClick={runSearch}
						disabled={!canSearch}
						className="w-full sm:ml-auto sm:w-auto"
					>
						{pending ? (
							'Searching…'
						) : (
							<>
								<SearchIcon />
								Search
								<kbd className="bg-primary-foreground/15 ml-1 rounded px-1 py-0.5 font-mono text-[10px]">
									⌘⏎
								</kbd>
							</>
						)}
					</Button>
					{rangeError ? (
						<p className="text-destructive basis-full pb-1 text-xs">
							{rangeError}
						</p>
					) : null}
				</div>
			</div>

			{error ? <Callout title="Search failed">{error}</Callout> : null}

			{results === null ? (
				<EmptyState title="No search run yet">
					Pick the tables to look in and press Search. Leave the query empty to
					list the most recent changes across all of them.
				</EmptyState>
			) : results.length === 0 ? (
				<EmptyState title="No entries matched">
					{queryMode === 'containment' ? (
						<p className="mb-2">
							Containment matches whole values — try{' '}
							<code className="font-mono text-xs">{'{"status":"active"}'}</code>{' '}
							rather than a partial one, or drop the braces to search as plain
							text.
						</p>
					) : null}
					{/* Archived rows are soft-deleted first and filtered out of every
					    read, so "missing" history is often archival, not absence. */}
					<p>
						Entries that have been archived and soft-deleted are excluded from
						every search — those live in S3, not the database.
					</p>
				</EmptyState>
			) : (
				<Panel>
					<EntryTable entries={results} onInspect={setInspected} />
					<PanelFooter>
						<span className="text-muted-foreground font-mono text-[11px]">
							{results.length} {results.length === 1 ? 'entry' : 'entries'}
							{hasMore ? ' loaded' : ''}
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
						) : (
							<span className="text-muted-foreground/60 font-mono text-[11px]">
								end of results
							</span>
						)}
					</PanelFooter>
				</Panel>
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
