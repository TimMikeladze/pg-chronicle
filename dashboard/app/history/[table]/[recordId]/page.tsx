import { ArrowLeftIcon } from 'lucide-react'
import Link from 'next/link'

import { RecordTimeline } from '@/components/record-timeline'
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
			<div className="flex flex-col gap-4">
				<h1 className="text-ink font-display text-xl font-semibold">
					Table not audited
				</h1>
				<p className="text-muted-foreground text-sm">
					<span className="font-mono">{table}</span> is not in{' '}
					<code className="font-mono text-xs">PG_HISTORY_TABLES</code>.
					Currently audited:{' '}
					<span className="font-mono">
						{config.tables.join(', ') || 'none'}
					</span>
					.
				</p>
				<Button asChild variant="outline" className="self-start">
					<Link href="/">
						<ArrowLeftIcon />
						Back to overview
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
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-ink font-display text-xl font-semibold">
						<span className="font-mono">{table}</span>
					</h1>
					<p className="text-muted-foreground mt-1 font-mono text-sm break-all">
						{recordId}
					</p>
				</div>
				<Button asChild variant="outline">
					<Link href="/search">
						<ArrowLeftIcon />
						Back to explore
					</Link>
				</Button>
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
