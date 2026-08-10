import { NotConfigured } from '@/components/not-configured'
import { RelativeTime } from '@/components/relative-time'
import { RunArchivalButton } from '@/components/run-archival-button'
import { Panel, PanelFooter, Section } from '@/components/section'
import { HeroFigure, StatRow, StatTile } from '@/components/stat-tile'
import { ArchivalStatusBadge, Callout } from '@/components/status'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { readConfig } from '@/lib/config'
import { compactNumber, exactNumber } from '@/lib/format'
import { getDetailedHealth, getStats } from '@/lib/pg-history-server'
import type { ArchivalStatsRow, DetailedHealth } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * The archiver's own page. It was previously two thirds of the overview, which
 * buried the audit trail itself under infrastructure state that most visits do
 * not care about. It also covers the two endpoints nothing else surfaces:
 * /api/stats per table and /api/health/detailed.
 */
async function load(enabled: boolean): Promise<{
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

export default async function ArchivalPage() {
	const config = readConfig()
	if (config.tables.length === 0) return <NotConfigured />

	const { stats, health, error } = await load(config.archiverEnabled)

	const totals = stats.reduce(
		(acc, row) => ({
			archive: acc.archive + row.recordsPendingArchive,
			soft: acc.soft + row.recordsPendingSoftDelete,
			hard: acc.hard + row.recordsPendingHardDelete,
		}),
		{ archive: 0, soft: 0, hard: 0 },
	)

	const oldest = stats
		.map((row) => row.oldestUnarchivedRecord)
		.filter((value): value is string => value !== null)
		.sort()[0]

	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col gap-2">
				<h1 className="text-ink text-2xl font-semibold tracking-tight">
					Archival
				</h1>
				<p className="text-muted-foreground max-w-2xl text-[13px] leading-relaxed">
					Old entries are written to S3 as Parquet, soft-deleted, then purged
					once past the grace period. Soft-deleted entries are excluded from
					every read in this dashboard — history that has been archived is not
					missing, it is in S3.
				</p>
			</div>

			{!config.archiverEnabled ? (
				<Callout tone="neutral" title="Archival is not configured">
					Set{' '}
					<code className="text-foreground font-mono text-xs">
						PG_HISTORY_S3_BUCKET
					</code>{' '}
					to enable it. Without it the audit log grows unbounded, and the stats,
					detailed-health, and archive endpoints are not registered at all.
				</Callout>
			) : (
				<>
					<HeroFigure
						label="Records pending archive"
						value={compactNumber(totals.archive)}
						hint={
							oldest ? (
								<>
									Oldest unarchived record <RelativeTime iso={oldest} />
								</>
							) : (
								'Nothing waiting to be archived'
							)
						}
						action={<RunArchivalButton />}
					/>

					<StatRow>
						<StatTile
							label="Pending soft delete"
							value={compactNumber(totals.soft)}
							hint="Written to S3, awaiting the grace period"
						/>
						<StatTile
							label="Pending hard delete"
							value={compactNumber(totals.hard)}
							hint="Past the grace period — the next run removes them"
						/>
						<StatTile
							label="Last run"
							value={
								<RelativeTime
									iso={health?.archival.lastCompletedAt}
									className="text-xl"
								/>
							}
							hint={
								health ? (
									<span className="flex flex-wrap items-center gap-2">
										<ArchivalStatusBadge status={health.archival.status} />
										{health.archival.attempts > 0
											? `${health.archival.attempts} retries since last success`
											: null}
									</span>
								) : null
							}
						/>
					</StatRow>

					{error ? (
						<Callout tone="warning" title="Archiver status unavailable">
							{error}
						</Callout>
					) : null}

					{health?.archival.lastError ? (
						<Callout title="Last archival error">
							<span className="font-mono text-xs">
								{health.archival.lastError}
							</span>
						</Callout>
					) : null}

					{stats.length > 0 ? (
						<Section
							title="Backlog by table"
							description="Counts come from the archiver’s own stats table, refreshed on each run."
						>
							<Panel>
								<Table>
									<TableHeader>
										<TableRow className="hover:bg-transparent">
											<TableHead className="pl-4">Table</TableHead>
											<TableHead className="text-right">Archive</TableHead>
											<TableHead className="text-right">Soft delete</TableHead>
											<TableHead className="text-right">Hard delete</TableHead>
											<TableHead>Oldest unarchived</TableHead>
											<TableHead className="pr-4">Updated</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{stats.map((row) => (
											<TableRow key={row.tableName}>
												<TableCell className="pl-4 font-mono text-xs">
													{row.tableName}
												</TableCell>
												<TableCell className="tabular text-right font-mono text-xs">
													{exactNumber(row.recordsPendingArchive)}
												</TableCell>
												<TableCell className="tabular text-right font-mono text-xs">
													{exactNumber(row.recordsPendingSoftDelete)}
												</TableCell>
												<TableCell className="tabular text-right font-mono text-xs">
													{exactNumber(row.recordsPendingHardDelete)}
												</TableCell>
												<TableCell className="text-muted-foreground font-mono text-xs">
													{row.oldestUnarchivedRecord ? (
														<RelativeTime iso={row.oldestUnarchivedRecord} />
													) : (
														'—'
													)}
												</TableCell>
												<TableCell className="text-muted-foreground pr-4 font-mono text-xs">
													<RelativeTime iso={row.lastUpdated} />
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
								<PanelFooter>
									<span className="text-muted-foreground font-mono text-[11px]">
										{stats.length} {stats.length === 1 ? 'table' : 'tables'}
									</span>
								</PanelFooter>
							</Panel>
						</Section>
					) : null}
				</>
			)}
		</div>
	)
}
