import { ArrowRightIcon } from 'lucide-react'
import Link from 'next/link'

import { NotConfigured } from '@/components/not-configured'
import { RecentActivity } from '@/components/recent-activity'
import { RecordJump } from '@/components/record-jump'
import { Panel, PanelFooter, Section } from '@/components/section'
import { Callout } from '@/components/status'
import { Button } from '@/components/ui/button'
import { readConfig } from '@/lib/config'
import { ApiError, searchHistory } from '@/lib/pghistory-server'
import { cachedProbe } from '@/lib/probe-cache'
import type { AuditEntryWire } from '@/lib/types'

// Operational state, by definition — never serve a build-time snapshot.
export const dynamic = 'force-dynamic'

const RECENT_LIMIT = 15
/** See lib/probe-cache: the API caps concurrent searches at 4 process-wide. */
const PROBE_TTL_MS = 5_000

/**
 * Search is concurrency-capped server-side, so a busy instance can 429 here.
 * The failure has to be distinguishable from an empty result — rendering
 * "no changes recorded yet" for a rate-limited request would state the
 * opposite of the truth.
 */
function loadRecent(
	tables: string[],
): Promise<{ entries: AuditEntryWire[]; error: string | null }> {
	return cachedProbe(
		`recent:${tables.join(',')}`,
		PROBE_TTL_MS,
		async () => {
			try {
				const result = await searchHistory({ tables, limit: RECENT_LIMIT })
				return { entries: result.data, error: null as string | null }
			} catch (error) {
				return {
					entries: [] as AuditEntryWire[],
					error:
						error instanceof ApiError && error.code === 'RATE_LIMITED'
							? 'Rate limited — pghistory caps concurrent searches. Recent activity reappears once load drops.'
							: 'Could not load recent activity.',
				}
			}
		},
		(value) => value.error !== null,
	)
}

/**
 * The overview answers two questions and nothing else: what just changed, and
 * how do I get to the row I came here about.
 *
 * Health lives in the nav bar, the audited-table list lives in the nav bar's
 * scope switcher, and archival has its own page — all three were previously
 * restated here, which made the landing page a status board for infrastructure
 * rather than a way into the audit trail.
 */
export default async function OverviewPage() {
	const config = readConfig()
	if (config.tables.length === 0) return <NotConfigured />

	const recent = await loadRecent(config.tables)

	return (
		<div className="flex flex-col gap-8">
			<Section
				title="Open a record"
				description="Every change to one row, newest to oldest, with the values that moved."
			>
				<RecordJump tables={config.tables} />
			</Section>

			<Section
				title="Recent activity"
				description="The latest changes across every audited table."
				action={
					<Button asChild variant="ghost" size="sm">
						<Link href="/search">
							Search the trail
							<ArrowRightIcon />
						</Link>
					</Button>
				}
			>
				{recent.error ? (
					<Callout tone="warning" title="Recent activity unavailable">
						{recent.error}
					</Callout>
				) : (
					<Panel>
						<RecentActivity entries={recent.entries} />
						{recent.entries.length > 0 ? (
							<PanelFooter>
								<span className="text-muted-foreground font-mono text-[11px]">
									{recent.entries.length} most recent
								</span>
								<Button asChild variant="ghost" size="sm">
									<Link href="/tables">Browse by table</Link>
								</Button>
							</PanelFooter>
						) : null}
					</Panel>
				)}
			</Section>
		</div>
	)
}
