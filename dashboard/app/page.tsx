import { DatabaseIcon, SearchIcon } from 'lucide-react'
import Link from 'next/link'

import { NotConfigured } from '@/components/not-configured'
import { RecentActivity } from '@/components/recent-activity'
import { RecordJump } from '@/components/record-jump'
import { RunArchivalButton } from '@/components/run-archival-button'
import { HeroFigure, StatTile } from '@/components/stat-tile'
import { ArchivalStatusBadge, HealthBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { readConfig } from '@/lib/config'
import { compactNumber, exactNumber, relativeTime } from '@/lib/format'
import {
	ApiError,
	getDetailedHealth,
	getHealth,
	getStats,
	searchHistory,
} from '@/lib/pg-history-server'
import type {
	ArchivalStatsRow,
	AuditEntryWire,
	DetailedHealth,
} from '@/lib/types'

// Operational state, by definition — never serve a build-time snapshot.
export const dynamic = 'force-dynamic'

/**
 * The archiver endpoints exist only when PG_HISTORY_S3_BUCKET is set, and can
 * fail independently of the rest of the API. A failure here must degrade the
 * panel, not the page.
 */
async function loadArchiver(enabled: boolean): Promise<{
	stats: ArchivalStatsRow[]
	health: DetailedHealth | null
	error: string | null
}> {
	if (!enabled) return { stats: [], health: null, error: null }
	try {
		const [stats, health] = await Promise.all([getStats(), getDetailedHealth()])
		return { stats: stats.stats, health, error: null }
	} catch (error) {
		return {
			stats: [],
			health: null,
			error: error instanceof Error ? error.message : 'Unknown error',
		}
	}
}

const RECENT_LIMIT = 8

/**
 * Search is concurrency-capped server-side, so a busy instance can 429 here.
 * The failure has to be distinguishable from an empty result — rendering
 * "no changes recorded yet" for a rate-limited request would state the
 * opposite of the truth.
 */
async function loadRecent(
	tables: string[],
): Promise<{ entries: AuditEntryWire[]; error: string | null }> {
	try {
		const result = await searchHistory({ tables, limit: RECENT_LIMIT })
		return { entries: result.data, error: null }
	} catch (error) {
		return {
			entries: [],
			error:
				error instanceof ApiError && error.code === 'RATE_LIMITED'
					? 'Rate limited — pg-history caps concurrent searches. Recent activity will reappear once load drops.'
					: 'Could not load recent activity.',
		}
	}
}

export default async function OverviewPage() {
	const config = readConfig()
	if (config.tables.length === 0) return <NotConfigured />

	const [health, archiver, recent] = await Promise.all([
		getHealth(),
		loadArchiver(config.archiverEnabled),
		loadRecent(config.tables),
	])

	const totals = archiver.stats.reduce(
		(acc, row) => ({
			archive: acc.archive + row.recordsPendingArchive,
			soft: acc.soft + row.recordsPendingSoftDelete,
			hard: acc.hard + row.recordsPendingHardDelete,
		}),
		{ archive: 0, soft: 0, hard: 0 },
	)

	const oldest = archiver.stats
		.map((row) => row.oldestUnarchivedRecord)
		.filter((value): value is string => value !== null)
		.sort()[0]

	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-ink font-display text-xl font-semibold">
						Overview
					</h1>
					<p className="text-muted-foreground mt-1 text-sm">
						{config.tables.length} audited{' '}
						{config.tables.length === 1 ? 'table' : 'tables'} ·{' '}
						<span className="font-mono">{config.tables.join(', ')}</span>
					</p>
				</div>
				<div className="flex items-center gap-2">
					<HealthBadge status={health?.status ?? 'error'} />
					<Button asChild variant="outline">
						<Link href="/search">
							<SearchIcon />
							Explore history
						</Link>
					</Button>
				</div>
			</div>

			{config.archiverEnabled ? (
				<>
					<HeroFigure
						label="Records pending archive"
						value={compactNumber(totals.archive)}
						hint={
							oldest
								? `Oldest unarchived record ${relativeTime(oldest)}`
								: 'Nothing waiting to be archived'
						}
						action={
							<RunArchivalButton available={config.archiveTriggerAvailable} />
						}
					/>

					<div className="grid gap-4 sm:grid-cols-3">
						<StatTile
							label="Pending soft delete"
							value={compactNumber(totals.soft)}
							hint="Archived to S3, awaiting the grace period"
						/>
						<StatTile
							label="Pending hard delete"
							value={compactNumber(totals.hard)}
							hint="Past the grace period, next run removes them"
						/>
						<StatTile
							label="Last archival"
							value={
								<span className="text-2xl">
									{relativeTime(archiver.health?.archival.lastCompletedAt)}
								</span>
							}
							hint={
								archiver.health ? (
									<span className="flex items-center gap-2">
										<ArchivalStatusBadge
											status={archiver.health.archival.status}
										/>
										{archiver.health.archival.attempts > 0
											? `${archiver.health.archival.attempts} retries since last success`
											: null}
									</span>
								) : null
							}
						/>
					</div>

					{archiver.error ? (
						<Card>
							<CardHeader>
								<CardTitle>Archiver status unavailable</CardTitle>
								<CardDescription>{archiver.error}</CardDescription>
							</CardHeader>
						</Card>
					) : null}

					{archiver.health?.archival.lastError ? (
						<div
							className="rounded-lg border p-4 text-sm"
							style={{
								borderColor:
									'color-mix(in srgb, var(--status-critical) 45%, transparent)',
								backgroundColor:
									'color-mix(in srgb, var(--status-critical) 8%, transparent)',
							}}
						>
							<p className="text-ink font-medium">Last archival error</p>
							<p className="text-muted-foreground mt-1 font-mono text-xs break-words">
								{archiver.health.archival.lastError}
							</p>
						</div>
					) : null}

					{archiver.stats.length > 0 ? (
						<Card className="gap-0 py-0">
							<CardHeader className="py-5">
								<CardTitle>Archival backlog by table</CardTitle>
								<CardDescription>
									Counts come from the archiver&rsquo;s own stats table, updated
									on each run.
								</CardDescription>
							</CardHeader>
							<CardContent className="px-0 pb-2">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="pl-6">Table</TableHead>
											<TableHead className="text-right">Archive</TableHead>
											<TableHead className="text-right">Soft delete</TableHead>
											<TableHead className="text-right">Hard delete</TableHead>
											<TableHead>Oldest unarchived</TableHead>
											<TableHead className="pr-6">Updated</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{archiver.stats.map((row) => (
											<TableRow key={row.tableName}>
												<TableCell className="pl-6 font-mono">
													{row.tableName}
												</TableCell>
												<TableCell className="tabular text-right">
													{exactNumber(row.recordsPendingArchive)}
												</TableCell>
												<TableCell className="tabular text-right">
													{exactNumber(row.recordsPendingSoftDelete)}
												</TableCell>
												<TableCell className="tabular text-right">
													{exactNumber(row.recordsPendingHardDelete)}
												</TableCell>
												<TableCell className="text-muted-foreground">
													{row.oldestUnarchivedRecord
														? relativeTime(row.oldestUnarchivedRecord)
														: '—'}
												</TableCell>
												<TableCell className="text-muted-foreground pr-6">
													{relativeTime(row.lastUpdated)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					) : null}
				</>
			) : (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<DatabaseIcon className="size-4" />
							Archival not configured
						</CardTitle>
						<CardDescription>
							Set <code className="font-mono">PG_HISTORY_S3_BUCKET</code> to
							enable S3 archival. Without it the audit log grows unbounded and
							the stats, detailed-health, and archive endpoints are not
							registered.
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			<Card className="gap-0 py-0">
				<CardHeader className="py-5">
					<CardTitle>Recent activity</CardTitle>
					<CardDescription>
						The latest changes across every audited table.
					</CardDescription>
					<CardAction>
						<Button asChild variant="ghost" size="sm">
							<Link href="/search">View all</Link>
						</Button>
					</CardAction>
				</CardHeader>
				<CardContent className="px-0 pb-2">
					<RecentActivity entries={recent.entries} error={recent.error} />
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Jump to a record</CardTitle>
					<CardDescription>
						Open the full change timeline for one row by primary key.
					</CardDescription>
					<CardAction>
						<Button asChild variant="ghost" size="sm">
							<Link href="/search">Search instead</Link>
						</Button>
					</CardAction>
				</CardHeader>
				<CardContent>
					<RecordJump tables={config.tables} />
				</CardContent>
			</Card>
		</div>
	)
}
