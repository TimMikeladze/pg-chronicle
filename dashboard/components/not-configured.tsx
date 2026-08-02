import { TriangleAlertIcon } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Shown instead of an empty dashboard when PG_HISTORY_TABLES is missing. The
 * API would start and serve only /health in that state, so every panel below
 * would render as a blank — better to name the missing variable.
 */
export function NotConfigured() {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<TriangleAlertIcon
						className="size-4"
						style={{ color: 'var(--status-warning)' }}
					/>
					No audited tables configured
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4 text-sm">
				<p className="text-muted-foreground">
					<code className="bg-inset rounded px-1 py-0.5 font-mono text-xs">
						PG_HISTORY_TABLES
					</code>{' '}
					is what enables the history API. Without it the server starts but
					serves only <code className="font-mono text-xs">/health</code>, and
					there is nothing for this dashboard to show.
				</p>
				<pre className="bg-inset overflow-x-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">
					{`PG_HISTORY_DATABASE_URL=postgres://localhost:5432/mydb
PG_HISTORY_TABLES=users,orders
PG_HISTORY_JWT_SECRET=a-long-random-string`}
				</pre>
				<p className="text-muted-foreground">
					Set these in <code className="font-mono text-xs">.env.local</code> and
					restart. See <code className="font-mono text-xs">.env.example</code>{' '}
					for the optional archiver variables.
				</p>
			</CardContent>
		</Card>
	)
}
