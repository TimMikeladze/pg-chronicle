import { ArrowLeftIcon, SearchIcon } from 'lucide-react'
import Link from 'next/link'

import { EntryTable } from '@/components/entry-table'
import { RecordJump } from '@/components/record-jump'
import { RelativeTime } from '@/components/relative-time'
import { EmptyState, Panel, PanelFooter, Section } from '@/components/section'
import { StatRow, StatTile } from '@/components/stat-tile'
import { Callout } from '@/components/status'
import { Button } from '@/components/ui/button'
import { readConfig } from '@/lib/config'
import { exactNumber } from '@/lib/format'
import { ApiError, getStats, searchHistory } from '@/lib/pg-history-server'
import { cachedProbe } from '@/lib/probe-cache'
import type { ArchivalStatsRow, AuditEntryWire, Operation } from '@/lib/types'

export const dynamic = 'force-dynamic'

const FEED_LIMIT = 25
/** See lib/probe-cache: the API caps concurrent searches at 4 process-wide. */
const PROBE_TTL_MS = 5_000

/**
 * One table's page. It answers what the overview cannot: what does this table's
 * traffic look like, how much of its history is queued for archival, and where
 * do I go from here.
 *
 * The operation mix is computed from the loaded page rather than claimed as a
 * global total — there is no count endpoint, and labelling a sample as a total
 * would be a lie the UI cannot back up.
 */
function loadFeed(table: string): Promise<{
	entries: AuditEntryWire[]
	error: string | null
}> {
	return cachedProbe(
		`feed:${table}`,
		PROBE_TTL_MS,
		async () => {
			try {
				const result = await searchHistory({
					tables: [table],
					limit: FEED_LIMIT,
				})
				return { entries: result.data, error: null as string | null }
			} catch (error) {
				return {
					entries: [] as AuditEntryWire[],
					error:
						error instanceof ApiError && error.code === 'RATE_LIMITED'
							? 'Rate limited — pg-history caps concurrent searches. Retry in a moment.'
							: 'Could not read this table’s history.',
				}
			}
		},
		(value) => value.error !== null,
	)
}

export default async function TablePage({
	params,
}: {
	params: Promise<{ table: string }>
}) {
	const { table } = await params
	const config = readConfig()

	// The API answers an unconfigured table with INVALID_TABLE; naming the
	// configured set here is a far more useful dead end than an error banner.
	if (!config.tables.includes(table)) {
		return (
			<div className="mx-auto flex max-w-2xl flex-col gap-4 py-10">
				<h1 className="text-ink text-lg font-semibold tracking-tight">
					Table not audited
				</h1>
				<p className="text-muted-foreground text-[13px] leading-relaxed">
					<span className="text-foreground font-mono">{table}</span> is not in{' '}
					<code className="text-foreground font-mono text-xs">
						PG_HISTORY_TABLES
					</code>
					. Currently audited:{' '}
					<span className="text-foreground font-mono">
						{config.tables.join(', ') || 'none'}
					</span>
					.
				</p>
				<Button asChild variant="outline" className="self-start">
					<Link href="/tables">
						<ArrowLeftIcon />
						All tables
					</Link>
				</Button>
			</div>
		)
	}

	const [feed, archival] = await Promise.all([
		loadFeed(table),
		config.archiverEnabled
			? getStats()
					.then((s) => s.stats.find((row) => row.tableName === table) ?? null)
					.catch((): ArchivalStatsRow | null => null)
			: Promise.resolve<ArchivalStatsRow | null>(null),
	])

	const mix = feed.entries.reduce<Record<string, number>>((acc, entry) => {
		acc[entry.operation] = (acc[entry.operation] ?? 0) + 1
		return acc
	}, {})
	const mixOrder: Operation[] = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']

	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex flex-col gap-1.5">
					<h1 className="text-ink font-mono text-2xl font-medium tracking-tight">
						{table}
					</h1>
					<p className="text-muted-foreground text-[13px]">
						Audit trail for every row in this table.
					</p>
				</div>
				<Button asChild variant="outline" size="sm">
					<Link href={`/search?table=${encodeURIComponent(table)}`}>
						<SearchIcon />
						Search this table
					</Link>
				</Button>
			</div>

			<StatRow columns={config.archiverEnabled ? 4 : 2}>
				<StatTile
					label="Recent entries"
					value={exactNumber(feed.entries.length)}
					hint={
						feed.entries.length === FEED_LIMIT
							? `Newest ${FEED_LIMIT} — the trail is longer`
							: 'Every entry currently in the database'
					}
				/>
				<StatTile
					label="Last change"
					value={
						feed.entries[0] ? (
							<RelativeTime
								iso={feed.entries[0].changedAt}
								className="text-xl"
							/>
						) : (
							'—'
						)
					}
					hint={
						feed.entries[0]
							? (feed.entries[0].appActor ??
								(feed.entries[0].dbUser
									? `${feed.entries[0].dbUser} (role)`
									: 'unattributed'))
							: 'No entries recorded yet'
					}
				/>
				{config.archiverEnabled ? (
					<>
						<StatTile
							label="Pending archive"
							value={
								archival ? exactNumber(archival.recordsPendingArchive) : '—'
							}
							hint={
								archival?.oldestUnarchivedRecord ? (
									<>
										Oldest{' '}
										<RelativeTime iso={archival.oldestUnarchivedRecord} />
									</>
								) : (
									'Nothing waiting to be archived'
								)
							}
						/>
						<StatTile
							label="Pending purge"
							value={
								archival
									? exactNumber(
											archival.recordsPendingSoftDelete +
												archival.recordsPendingHardDelete,
										)
									: '—'
							}
							hint="Archived to S3, awaiting or past the grace period"
						/>
					</>
				) : null}
			</StatRow>

			{/* The mix is explicitly labelled as a sample of the loaded page — the
			    API exposes no aggregate, and an unqualified figure would imply one. */}
			{feed.entries.length > 0 ? (
				<Section
					title="Operation mix"
					description={`Across the ${feed.entries.length} most recent ${feed.entries.length === 1 ? 'entry' : 'entries'} — a sample, not a lifetime total.`}
				>
					<div className="flex flex-wrap gap-2">
						{mixOrder
							.filter((op) => mix[op])
							.map((op) => (
								<span
									key={op}
									className="bg-card inline-flex items-center gap-2 rounded-lg border px-3 py-2"
								>
									<span
										aria-hidden
										className="size-2 rounded-full"
										style={{ backgroundColor: `var(--op-${op.toLowerCase()})` }}
									/>
									<span className="font-mono text-xs">{op}</span>
									<span className="text-ink font-mono text-sm font-medium">
										{mix[op]}
									</span>
								</span>
							))}
					</div>
				</Section>
			) : null}

			<Section
				title="Open a record"
				description="Every change to one row, with the values that moved."
			>
				<RecordJump tables={config.tables} fixedTable={table} />
			</Section>

			<Section
				title="Recent changes"
				description="The newest entries for this table."
			>
				{feed.error ? (
					<Callout tone="warning" title="Could not read this table">
						{feed.error}
					</Callout>
				) : feed.entries.length === 0 ? (
					<EmptyState title="No entries for this table">
						Triggers capture writes from the moment{' '}
						<code className="text-foreground font-mono text-xs">setup()</code>{' '}
						ran. Rows written before that have no history, and archived entries
						are filtered out of every read.
					</EmptyState>
				) : (
					<Panel>
						{/* The table column is dropped: every row here is this table. */}
						<EntryTable entries={feed.entries} columns={{ table: false }} />
						<PanelFooter>
							<span className="text-muted-foreground font-mono text-[11px]">
								{feed.entries.length}{' '}
								{feed.entries.length === 1 ? 'entry' : 'entries'}
							</span>
							<Button asChild variant="ghost" size="sm">
								<Link href={`/search?table=${encodeURIComponent(table)}`}>
									Search all entries
								</Link>
							</Button>
						</PanelFooter>
					</Panel>
				)}
			</Section>
		</div>
	)
}
