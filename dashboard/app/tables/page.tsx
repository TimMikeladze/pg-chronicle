import { ArrowRightIcon } from 'lucide-react'
import Link from 'next/link'

import { NotConfigured } from '@/components/not-configured'
import { RelativeTime } from '@/components/relative-time'
import { Panel, PanelFooter, Section } from '@/components/section'
import { Callout, OperationBadge } from '@/components/status'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { readConfig } from '@/lib/config'
import { exactNumber } from '@/lib/format'
import { getStats, searchHistory } from '@/lib/pg-history-server'
import { cachedProbe } from '@/lib/probe-cache'
import type { ArchivalStatsRow, AuditEntryWire } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * There is no "count entries per table" endpoint, so a table's activity is
 * derived from the newest entries the search API returns.
 *
 * This is ONE query across every audited table, not one per table. `search`
 * caps concurrency at 4 by default and rejects the excess with 429, so fanning
 * out per table would make this page fail on any deployment auditing five or
 * more — the rows would silently render as "unavailable" under normal load.
 *
 * The tradeoff: a table whose last write is older than the newest LOOKBACK
 * entries overall shows as "no recent activity" rather than a date. That is
 * stated in the column rather than papered over, and the table's own page
 * still shows its real history.
 */
const LOOKBACK = 250

/**
 * Feeds are navigational — a few seconds of staleness on a "last change"
 * column is invisible, whereas spending one of the API's four search slots per
 * page view is not.
 */
const PROBE_TTL_MS = 5_000

type Probe = { latest: Map<string, AuditEntryWire>; error: boolean }

/**
 * There is no "count entries per table" endpoint, so a table's activity is
 * derived from the newest entries the search API returns — ONE query across
 * every audited table, not one per table. Fanning out per table would exceed
 * the concurrency cap on any deployment auditing five or more.
 *
 * The tradeoff: a table whose last write is older than the newest LOOKBACK
 * entries overall has no date to show. That is stated in the column rather
 * than papered over, and the table's own page still shows its real history.
 */
function loadLatestByTable(tables: string[]): Promise<Probe> {
	return cachedProbe<Probe>(
		`tables:${tables.join(',')}`,
		PROBE_TTL_MS,
		async () => {
			try {
				const result = await searchHistory({ tables, limit: LOOKBACK })
				const latest = new Map<string, AuditEntryWire>()
				// Results arrive newest-first, so the first sighting of a table is
				// its most recent entry.
				for (const entry of result.data) {
					if (!latest.has(entry.tableName)) latest.set(entry.tableName, entry)
				}
				return { latest, error: false }
			} catch {
				return { latest: new Map(), error: true }
			}
		},
		(value) => value.error,
	)
}

export default async function TablesPage() {
	const config = readConfig()
	if (config.tables.length === 0) return <NotConfigured />

	// Archival counts are per-table and only exist when the archiver is on.
	const [activity, archival] = await Promise.all([
		loadLatestByTable(config.tables),
		config.archiverEnabled
			? getStats()
					.then((s) => s.stats)
					.catch((): ArchivalStatsRow[] => [])
			: Promise.resolve<ArchivalStatsRow[]>([]),
	])

	const archivalByTable = new Map(archival.map((row) => [row.tableName, row]))

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="text-ink text-2xl font-semibold tracking-tight">
					Tables
				</h1>
				<p className="text-muted-foreground max-w-2xl text-[13px] leading-relaxed">
					Every table with an audit trigger installed. A table appears here
					because it is listed in{' '}
					<code className="text-foreground font-mono text-xs">
						PG_HISTORY_TABLES
					</code>{' '}
					— the API refuses to read or search any table that is not.
				</p>
			</div>

			{activity.error ? (
				<Callout tone="warning" title="Recent activity unavailable">
					The search API did not answer, so the last-change columns are blank.
					Every table listed below is still audited — open one to read its
					history directly.
				</Callout>
			) : null}

			<Section title="Audited tables">
				<Panel>
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="w-[1%] pl-4">Table</TableHead>
								<TableHead className="w-[1%] whitespace-nowrap">
									Last change
								</TableHead>
								<TableHead className="w-[1%]">Operation</TableHead>
								<TableHead className="w-[1%] whitespace-nowrap">
									Actor
								</TableHead>
								{config.archiverEnabled ? (
									<>
										<TableHead className="w-[1%] text-right whitespace-nowrap">
											Pending archive
										</TableHead>
										<TableHead className="w-[1%] text-right whitespace-nowrap">
											Pending purge
										</TableHead>
									</>
								) : null}
								<TableHead className="w-[1%] pr-4" />
								<TableHead className="w-auto" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{config.tables.map((table) => {
								const stats = archivalByTable.get(table)
								const latest = activity.latest.get(table)
								return (
									<TableRow key={table}>
										<TableCell className="pl-4 font-mono text-xs">
											<Link
												href={`/tables/${encodeURIComponent(table)}`}
												className="decoration-border underline underline-offset-4 transition-colors hover:decoration-current"
											>
												{table}
											</Link>
										</TableCell>
										<TableCell>
											{latest ? (
												<RelativeTime
													iso={latest.changedAt}
													className="text-muted-foreground font-mono text-xs whitespace-nowrap"
												/>
											) : (
												<span className="text-muted-foreground/60 text-xs italic">
													{activity.error
														? 'unavailable'
														: `not in last ${LOOKBACK}`}
												</span>
											)}
										</TableCell>
										<TableCell>
											{latest ? (
												<OperationBadge operation={latest.operation} />
											) : null}
										</TableCell>
										<TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
											{latest?.appActor ?? latest?.dbUser ?? '—'}
										</TableCell>
										{config.archiverEnabled ? (
											<>
												<TableCell className="tabular text-right font-mono text-xs">
													{stats
														? exactNumber(stats.recordsPendingArchive)
														: '—'}
												</TableCell>
												<TableCell className="tabular text-right font-mono text-xs">
													{stats
														? exactNumber(
																stats.recordsPendingSoftDelete +
																	stats.recordsPendingHardDelete,
															)
														: '—'}
												</TableCell>
											</>
										) : null}
										<TableCell className="pr-4 text-right">
											<Link
												href={`/tables/${encodeURIComponent(table)}`}
												className="text-muted-foreground hover:text-foreground inline-flex items-center"
												aria-label={`Open ${table}`}
											>
												<ArrowRightIcon className="size-3.5" />
											</Link>
										</TableCell>
										<TableCell />
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
					<PanelFooter>
						<span className="text-muted-foreground font-mono text-[11px]">
							{config.tables.length}{' '}
							{config.tables.length === 1 ? 'table' : 'tables'} audited
						</span>
					</PanelFooter>
				</Panel>
			</Section>
		</div>
	)
}
