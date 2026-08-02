import { NotConfigured } from '@/components/not-configured'
import { SearchExplorer } from '@/components/search-explorer'
import { readConfig } from '@/lib/config'

export const dynamic = 'force-dynamic'

export default function SearchPage() {
	const config = readConfig()
	if (config.tables.length === 0) return <NotConfigured />

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h1 className="text-ink font-display text-xl font-semibold">Explore</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					Search every audited change across tables. Select a row to inspect the
					full before/after diff.
				</p>
			</div>
			<SearchExplorer tables={config.tables} />
		</div>
	)
}
