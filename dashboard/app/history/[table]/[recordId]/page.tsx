import { ArrowLeftIcon } from 'lucide-react'
import Link from 'next/link'

import { RecordTimeline } from '@/components/record-timeline'
import { Callout } from '@/components/status'
import { Button } from '@/components/ui/button'
import { readConfig } from '@/lib/config'
import { ApiError, getRecordHistory } from '@/lib/pg-history-server'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

export default async function RecordPage({
	params,
}: {
	params: Promise<{ table: string; recordId: string }>
}) {
	// Next gives these already percent-decoded.
	const { table, recordId } = await params
	const config = readConfig()

	/*
	 * Check the allowlist before calling: the API answers an unconfigured table
	 * with INVALID_TABLE, but naming the configured tables here is a far more
	 * useful dead end than an error banner.
	 */
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

	let page: Awaited<ReturnType<typeof getRecordHistory>> | null = null
	let error: string | null = null
	try {
		page = await getRecordHistory(table, recordId, {
			limit: PAGE_SIZE,
			order: 'desc',
		})
	} catch (caught) {
		error =
			caught instanceof ApiError
				? caught.message
				: 'Could not load this record’s history.'
	}

	return (
		<div className="flex flex-col gap-6">
			{/* Breadcrumb rather than a back button: this page is reached from
			    search, from a table's feed, and from a pasted URL, so a single
			    fixed "back" target would lie about where the reader came from. */}
			<nav className="text-muted-foreground flex flex-wrap items-center gap-2 font-mono text-xs">
				<Link
					href="/tables"
					className="hover:text-foreground transition-colors"
				>
					Tables
				</Link>
				<span aria-hidden className="text-border">
					/
				</span>
				<Link
					href={`/tables/${encodeURIComponent(table)}`}
					className="hover:text-foreground transition-colors"
				>
					{table}
				</Link>
				<span aria-hidden className="text-border">
					/
				</span>
				<span className="text-foreground break-all">{recordId}</span>
			</nav>

			<div className="flex min-w-0 flex-col gap-1.5">
				<h1 className="text-ink font-mono text-xl font-medium tracking-tight break-all">
					{recordId}
				</h1>
				<p className="text-muted-foreground text-[13px]">
					Every recorded change to this row, newest first.
				</p>
			</div>

			{error ? (
				<Callout title="Could not load this record">{error}</Callout>
			) : (
				<RecordTimeline
					table={table}
					recordId={recordId}
					initialEntries={page?.data ?? []}
					initialCursor={page?.nextCursor ?? null}
					initialHasMore={page?.hasMore ?? false}
				/>
			)}
		</div>
	)
}
