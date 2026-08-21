import { ArrowRightIcon } from 'lucide-react'
import Link from 'next/link'

import { RecentActivity } from '@/components/recent-activity'
import { RecordJump } from '@/components/record-jump'
import { Panel, PanelFooter, Section } from '@/components/section'
import { Callout } from '@/components/status'
import { Button } from '@/components/ui/button'
import { currentConnection } from '@/lib/current-connection'
import { ApiError, searchHistory } from '@/lib/pg-chronicle-server'
import { cachedProbe } from '@/lib/probe-cache'
import type { Connection } from '@/lib/registry'
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
	connection: Connection,
): Promise<{ entries: AuditEntryWire[]; error: string | null }> {
	return cachedProbe(
		`recent:${connection.id}:${connection.tables.join(',')}`,
		PROBE_TTL_MS,
		async () => {
			try {
				const result = await searchHistory(connection, {
					tables: connection.tables,
					limit: RECENT_LIMIT,
				})
				return { entries: result.data, error: null as string | null }
			} catch (error) {
				return {
					entries: [] as AuditEntryWire[],
					error:
						error instanceof ApiError && error.code === 'RATE_LIMITED'
							? 'Rate limited — pg-chronicle caps concurrent searches. Recent activity reappears once load drops.'
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
export default async function OverviewPage({
	params,
}: {
	params: Promise<{ conn: string }>
}) {
	const { conn } = await params
	const connection = await currentConnection(conn)
	const prefix = `/c/${encodeURIComponent(connection.id)}`

	// The form refuses to save a connection with no tables, so this is only
	// reachable if the registry row was edited by hand. Say where to fix it
	// rather than rendering an unexplained empty page.
	if (connection.tables.length === 0) {
		return (
			<Callout tone="warning" title="No audited tables">
				This connection lists no tables, so the API serves only its health
				probe.{' '}
				<Link
					href={`/connections/${encodeURIComponent(connection.id)}`}
					className="text-foreground underline underline-offset-4"
				>
					Edit the connection
				</Link>{' '}
				to add them.
			</Callout>
		)
	}

	const recent = await loadRecent(connection)

	return (
		<div className="flex flex-col gap-8">
			<Section
				title="Open a record"
				description="Every change to one row, newest to oldest, with the values that moved."
			>
				<RecordJump tables={connection.tables} />
			</Section>

			<Section
				title="Recent activity"
				description="The latest changes across every audited table."
				action={
					<Button asChild variant="ghost" size="sm">
						<Link href={`${prefix}/search`}>
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
									<Link href={`${prefix}/tables`}>Browse by table</Link>
								</Button>
							</PanelFooter>
						) : null}
					</Panel>
				)}
			</Section>
		</div>
	)
}
