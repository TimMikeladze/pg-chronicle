import { DatabaseIcon, TriangleAlertIcon } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

/**
 * The two states in which there is nothing to show, kept distinct because the
 * remedies are nothing alike: one is a deployment that was never given a place
 * to store its configuration, the other is a working deployment with no
 * databases added yet.
 */

/**
 * Shown when `PG_CHRONICLE_DASHBOARD_DATABASE_URL` is missing. This is the one
 * thing that cannot be configured from the UI — the registry is where the UI's
 * configuration lives, so it has to exist before anything else can.
 */
export function RegistryNotConfigured() {
	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-5 py-10">
			<div className="flex items-center gap-2">
				<TriangleAlertIcon
					className="size-4 shrink-0"
					style={{ color: 'var(--status-warning)' }}
				/>
				<h1 className="text-ink text-lg font-semibold tracking-tight">
					No registry database configured
				</h1>
			</div>

			<p className="text-muted-foreground text-[13px] leading-relaxed">
				The dashboard keeps its list of connections — which databases it
				manages, which tables in each are audited — in a Postgres database of
				its own. Point it at one and everything else is configured from this UI.
			</p>

			<pre className="bg-inset overflow-x-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">
				{`PG_CHRONICLE_DASHBOARD_DATABASE_URL=postgres://localhost:5432/dashboard
PG_CHRONICLE_JWT_SECRET=a-long-random-string
PG_CHRONICLE_DASHBOARD_PASSWORD=a-long-random-string`}
			</pre>

			<p className="text-muted-foreground text-[13px] leading-relaxed">
				Any Postgres will do, including one you already audit — the dashboard
				creates a single table there on first use. Set these in{' '}
				<code className="text-foreground font-mono text-xs">.env.local</code>{' '}
				and restart; see{' '}
				<code className="text-foreground font-mono text-xs">.env.example</code>{' '}
				for the optional variables.
			</p>
		</div>
	)
}

/** Shown when the registry is reachable but empty. */
export function NoConnections() {
	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-5 py-10">
			<div className="flex items-center gap-2">
				<DatabaseIcon className="text-muted-foreground size-4 shrink-0" />
				<h1 className="text-ink text-lg font-semibold tracking-tight">
					No databases added yet
				</h1>
			</div>

			<p className="text-muted-foreground text-[13px] leading-relaxed">
				Add a connection to start auditing. You need a Postgres connection
				string and the names of the tables to track — saving installs the audit
				triggers on those tables, and every change from that moment on is
				recorded.
			</p>

			<Button asChild className="self-start">
				<Link href="/connections/new">
					<DatabaseIcon />
					Add a connection
				</Link>
			</Button>
		</div>
	)
}
