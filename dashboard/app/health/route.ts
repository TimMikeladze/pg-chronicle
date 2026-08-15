import { getHealth } from '@/lib/pg-chronicle-server'

/**
 * pg-chronicle serves its public probe at /health, outside the /api catch-all.
 * Re-exposing it here keeps platform health checks (Fly, Kubernetes, Vercel)
 * pointed at the same bounded `SELECT 1` the library performs, including its
 * 503 on an unreachable database.
 */
export async function GET(): Promise<Response> {
	const health = await getHealth()
	if (!health) {
		return Response.json({ status: 'error' }, { status: 503 })
	}
	return Response.json(health, {
		status: health.status === 'error' ? 503 : 200,
	})
}

export const dynamic = 'force-dynamic'
