import { TriangleAlertIcon } from 'lucide-react'

import { ApiReference } from '@/components/api-reference'
import { currentConnection } from '@/lib/current-connection'
import { getOpenApiSpec } from '@/lib/pg-chronicle-server'

export const dynamic = 'force-dynamic'

export const metadata = {
	title: 'API reference · pg-chronicle',
	description: 'The pg-chronicle HTTP API, rendered from its OpenAPI document.',
}

export default async function OpenApiPage({
	params,
}: {
	params: Promise<{ conn: string }>
}) {
	const { conn } = await params
	const connection = await currentConnection(conn)
	const prefix = `/c/${encodeURIComponent(connection.id)}`

	let spec: Record<string, unknown>
	try {
		spec = await getOpenApiSpec(connection)
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
					The OpenAPI document could not be read from{' '}
					<span className="text-foreground">{connection.name}</span>. Check that
					the database is reachable — the health badge in the bar reports the
					same connection.
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
					Every endpoint the history API exposes for{' '}
					<span className="text-foreground">{connection.name}</span>, generated
					from its OpenAPI document. The raw document is at{' '}
					<a
						href={`${prefix}/openapi.json`}
						className="text-foreground underline underline-offset-4"
					>
						{prefix}/openapi.json
					</a>
					, and the live endpoints are served under{' '}
					<code className="text-foreground font-mono text-xs">
						/api/db/{connection.id}
					</code>
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
