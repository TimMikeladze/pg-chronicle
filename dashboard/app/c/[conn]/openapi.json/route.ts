import { ApiError, getOpenApiSpec } from '@/lib/pg-chronicle-server'
import { getConnection } from '@/lib/registry'

/**
 * Serves one connection's pg-chronicle OpenAPI document.
 *
 * The library registers `/openapi` behind the same JWT as the rest of the API
 * (this deployment never opts into `publicOpenApi`), so a browser cannot reach
 * it directly. This route fetches it with the dashboard's own token and returns
 * the spec — point Scalar, a client generator, or `curl` at it.
 *
 * `/c/<connection>/openapi` renders the human-facing reference; this route is
 * the machine one. It inherits whatever protects the dashboard; do not expose
 * the dashboard publicly if the API shape is sensitive.
 */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ conn: string }> },
): Promise<Response> {
	const { conn } = await params
	try {
		const connection = await getConnection(conn)
		if (!connection) {
			return Response.json(
				{
					error: {
						code: 'NOT_FOUND',
						message: `No connection named "${conn}".`,
					},
				},
				{ status: 404 },
			)
		}
		return Response.json(await getOpenApiSpec(connection))
	} catch (error) {
		if (error instanceof ApiError) {
			return Response.json(
				{ error: { code: error.code, message: error.message } },
				{ status: error.status },
			)
		}
		return Response.json(
			{
				error: {
					code: 'NOT_CONFIGURED',
					message: 'The OpenAPI document is not available.',
				},
			},
			{ status: 500 },
		)
	}
}

export const dynamic = 'force-dynamic'
