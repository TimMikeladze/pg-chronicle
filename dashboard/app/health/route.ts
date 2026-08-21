import { registryConfigured, registryHealthy } from '@/lib/registry'

/**
 * The platform probe (Fly, Kubernetes, Vercel).
 *
 * It reports on the registry — the one database this deployment cannot work
 * without — and deliberately not on the managed connections. A dashboard whose
 * process is healthy should not be restarted because someone added a connection
 * to a database that happens to be down; that connection's own health is
 * reported in the UI and at `/api/db/<connection>/health`.
 */
export async function GET(): Promise<Response> {
	if (!registryConfigured()) {
		return Response.json(
			{
				status: 'error',
				reason: 'PG_CHRONICLE_DASHBOARD_DATABASE_URL is not set',
			},
			{ status: 503 },
		)
	}

	const healthy = await registryHealthy()
	return Response.json(
		{ status: healthy ? 'ok' : 'error' },
		{ status: healthy ? 200 : 503 },
	)
}

export const dynamic = 'force-dynamic'
