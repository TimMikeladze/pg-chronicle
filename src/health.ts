import type { Server } from 'bun'
import type { OrchestratorStats } from './types'

export interface HealthServerOptions {
	port: number
}

export class HealthServer {
	private server: Server<unknown> | null = null
	private startTime: Date = new Date()
	private lastRun: OrchestratorStats | null = null

	constructor(private options: HealthServerOptions) {}

	start(): void {
		this.server = Bun.serve({
			port: this.options.port,
			fetch: (req) => this.handleRequest(req),
		})
		console.log(`Health check server listening on port ${this.options.port}`)
	}

	updateLastRun(stats: OrchestratorStats): void {
		this.lastRun = stats
	}

	private handleRequest(req: Request): Response {
		const url = new URL(req.url)

		if (url.pathname === '/health') {
			return Response.json({
				status: 'ok',
				timestamp: new Date().toISOString(),
				uptime_seconds: Math.floor(
					(Date.now() - this.startTime.getTime()) / 1000,
				),
				last_run: this.lastRun
					? {
							tables_processed: this.lastRun.tables.length,
							records_archived: this.lastRun.totalRecordsArchived,
							records_deleted:
								this.lastRun.totalRecordsSoftDeleted +
								this.lastRun.totalRecordsHardDeleted,
							errors: this.lastRun.errors.length,
							duration_ms: this.lastRun.durationMs,
						}
					: null,
			})
		}

		if (url.pathname === '/readiness') {
			// TODO: Actually check DB and S3 connectivity
			return Response.json({ status: 'ready' }, { status: 200 })
		}

		return Response.json({ error: 'Not found' }, { status: 404 })
	}

	stop(): void {
		if (this.server) {
			this.server.stop()
			this.server = null
		}
	}
}
