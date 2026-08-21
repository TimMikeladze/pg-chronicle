import { SearchExplorer } from '@/components/search-explorer'
import { currentConnection } from '@/lib/current-connection'

export const dynamic = 'force-dynamic'

export default async function SearchPage({
	params,
	searchParams,
}: {
	params: Promise<{ conn: string }>
	searchParams: Promise<{ table?: string }>
}) {
	const { conn } = await params
	const connection = await currentConnection(conn)

	// Arriving from a table's page preselects it, so "Search this table" lands
	// scoped rather than dumping the reader back into every table at once.
	const { table } = await searchParams

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="text-ink text-2xl font-semibold tracking-tight">
					Explore
				</h1>
				<p className="text-muted-foreground max-w-2xl text-[13px] leading-relaxed">
					Query every audited change across{' '}
					<span className="text-foreground">{connection.name}</span>. Select a
					row to inspect the full before/after diff, its provenance, and to
					revert it.
				</p>
			</div>
			<SearchExplorer tables={connection.tables} initialTable={table} />
		</div>
	)
}
