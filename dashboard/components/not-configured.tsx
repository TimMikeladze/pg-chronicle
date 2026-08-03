import { TriangleAlertIcon } from 'lucide-react'

/**
 * Shown instead of an empty dashboard when PGHISTORY_TABLES is missing. The API
 * would start and serve only /health in that state, so every panel below would
 * render blank — better to name the missing variable and give the exact block
 * to paste.
 */
export function NotConfigured() {
	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-5 py-10">
			<div className="flex items-center gap-2">
				<TriangleAlertIcon
					className="size-4 shrink-0"
					style={{ color: 'var(--status-warning)' }}
				/>
				<h1 className="text-ink text-lg font-semibold tracking-tight">
					No audited tables configured
				</h1>
			</div>

			<p className="text-muted-foreground text-[13px] leading-relaxed">
				<code className="bg-inset text-foreground rounded border px-1.5 py-0.5 font-mono text-xs">
					PGHISTORY_TABLES
				</code>{' '}
				is what enables the history API. Without it the server starts but serves
				only <code className="text-foreground font-mono text-xs">/health</code>,
				and there is nothing for this dashboard to show.
			</p>

			<pre className="bg-inset overflow-x-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">
				{`PGHISTORY_DATABASE_URL=postgres://localhost:5432/mydb
PGHISTORY_TABLES=users,orders
PGHISTORY_JWT_SECRET=a-long-random-string`}
			</pre>

			<p className="text-muted-foreground text-[13px] leading-relaxed">
				Set these in{' '}
				<code className="text-foreground font-mono text-xs">.env.local</code>{' '}
				and restart. See{' '}
				<code className="text-foreground font-mono text-xs">.env.example</code>{' '}
				for the optional archiver variables.
			</p>
		</div>
	)
}
