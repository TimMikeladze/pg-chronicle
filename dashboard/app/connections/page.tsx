import {
	ArrowRightIcon,
	DatabaseIcon,
	PencilIcon,
	TriangleAlertIcon,
} from 'lucide-react'
import Link from 'next/link'

import { DeleteConnectionButton } from '@/components/delete-connection-button'
import {
	NoConnections,
	RegistryNotConfigured,
} from '@/components/not-configured'
import { RelativeTime } from '@/components/relative-time'
import { Panel, PanelFooter, Section } from '@/components/section'
import { Callout } from '@/components/status'
import { Button } from '@/components/ui/button'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { listConnections, registryConfigured } from '@/lib/registry'

export const dynamic = 'force-dynamic'

/**
 * The databases this dashboard manages. This page is the configuration surface
 * that used to be a set of environment variables and a redeploy.
 */
export default async function ConnectionsPage() {
	if (!registryConfigured()) return <RegistryNotConfigured />

	let connections: Awaited<ReturnType<typeof listConnections>>
	try {
		connections = await listConnections()
	} catch (error) {
		return (
			<Callout title="Could not read the connection registry">
				{error instanceof Error
					? error.message
					: 'The registry is unreachable.'}
			</Callout>
		)
	}

	if (connections.length === 0) return <NoConnections />

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex flex-col gap-2">
					<h1 className="text-ink text-2xl font-semibold tracking-tight">
						Connections
					</h1>
					<p className="text-muted-foreground max-w-2xl text-[13px] leading-relaxed">
						Every database this dashboard audits. Connection strings and S3 keys
						are encrypted before they are stored and are never rendered back
						into this page.
					</p>
				</div>
				<Button asChild>
					<Link href="/connections/new">
						<DatabaseIcon />
						Add a connection
					</Link>
				</Button>
			</div>

			{connections.some((c) => c.sealed) ? (
				<Callout tone="warning" title="Some credentials cannot be decrypted">
					<code className="text-foreground font-mono text-xs">
						PG_CHRONICLE_JWT_SECRET
					</code>{' '}
					has changed since these connections were saved. Restore the previous
					value, or edit each one and re-enter its connection string to seal it
					under the current secret.
				</Callout>
			) : null}

			<Section title="Managed databases">
				<Panel>
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Name</TableHead>
								<TableHead>Target</TableHead>
								<TableHead>Tables</TableHead>
								<TableHead>Archival</TableHead>
								<TableHead className="whitespace-nowrap">Updated</TableHead>
								<TableHead className="pr-4" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{connections.map((connection) => (
								<TableRow key={connection.id}>
									<TableCell className="pl-4">
										{connection.sealed ? (
											<span className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px]">
												<TriangleAlertIcon
													className="size-3.5 shrink-0"
													style={{ color: 'var(--status-warning)' }}
												/>
												{connection.name}
											</span>
										) : (
											<Link
												href={`/c/${connection.id}`}
												className="decoration-border text-[13px] underline underline-offset-4 transition-colors hover:decoration-current"
											>
												{connection.name}
											</Link>
										)}
									</TableCell>
									<TableCell className="text-muted-foreground font-mono text-xs">
										{connection.sealed ? (
											<span className="italic">sealed</span>
										) : (
											(connection.target ?? '—')
										)}
									</TableCell>
									<TableCell className="text-muted-foreground font-mono text-xs">
										{connection.tables.join(', ')}
									</TableCell>
									<TableCell className="text-muted-foreground font-mono text-xs">
										{connection.archiveBucket ?? '—'}
									</TableCell>
									<TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
										<RelativeTime iso={connection.updatedAt} />
									</TableCell>
									<TableCell className="pr-4">
										<div className="flex items-center justify-end gap-1">
											<Button
												asChild
												variant="ghost"
												size="icon"
												title="Edit connection"
											>
												<Link href={`/connections/${connection.id}`}>
													<PencilIcon />
													<span className="sr-only">
														Edit {connection.name}
													</span>
												</Link>
											</Button>
											<DeleteConnectionButton
												id={connection.id}
												name={connection.name}
											/>
											{connection.sealed ? null : (
												<Button
													asChild
													variant="ghost"
													size="icon"
													title="Open audit trail"
												>
													<Link href={`/c/${connection.id}`}>
														<ArrowRightIcon />
														<span className="sr-only">
															Open {connection.name}
														</span>
													</Link>
												</Button>
											)}
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<PanelFooter>
						<span className="text-muted-foreground font-mono text-[11px]">
							{connections.length}{' '}
							{connections.length === 1 ? 'connection' : 'connections'}
						</span>
					</PanelFooter>
				</Panel>
			</Section>
		</div>
	)
}
