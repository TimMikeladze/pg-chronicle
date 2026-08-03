import { TriangleAlertIcon } from 'lucide-react'

import { ApiReference } from '@/components/api-reference'
import { NotConfigured } from '@/components/not-configured'
import { readConfig } from '@/lib/config'
import { getOpenApiSpec } from '@/lib/pghistory-server'

export const dynamic = 'force-dynamic'

export const metadata = {
	title: 'API reference · pghistory',
	description: 'The pghistory HTTP API, rendered from its OpenAPI document.',
}

export default async function OpenApiPage() {
	// Without audited tables the API serves only /health, so there is no
	// document worth rendering — say why, as every other page does.
	const config = readConfig()
	if (config.tables.length === 0) return <NotConfigured />

	let spec: Record<string, unknown>
	try {
		spec = await getOpenApiSpec()
	} catch {
		return (
			<div className="mx-auto flex max-w-2xl flex-col gap-3 py-10">
				<div className="flex items-center gap-2">
					<TriangleAlertIcon
						className="size-4 shrink-0"
						style={{ color: 'var(--status-critical)' }}
					/>
					<h1 className="text-ink text-lg font-semibold tracking-tight">
						API reference unavailable
					</h1>
				</div>
				<p className="text-muted-foreground text-[13px] leading-relaxed">
					The OpenAPI document could not be read from the API. Check that the
					dashboard is configured and the database is reachable — the{' '}
					<code className="text-foreground font-mono text-xs">Overview</code>{' '}
					page reports the same connection.
				</p>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="text-ink text-2xl font-semibold tracking-tight">
					API reference
				</h1>
				<p className="text-muted-foreground max-w-2xl text-[13px] leading-relaxed">
					Every endpoint the history API exposes, generated from its OpenAPI
					document. The raw document is at{' '}
					<a
						href="/openapi.json"
						className="text-foreground underline underline-offset-4"
					>
						/openapi.json
					</a>
					.
				</p>
			</div>

			{/* Scalar ships its own sidebar and column rules; the surrounding card
			    chrome the other pages use would compete with them. */}
			<div className="scalar-host">
				<ApiReference spec={spec} />
			</div>
		</div>
	)
}
