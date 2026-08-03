import { ApiError, getOpenApiSpec } from '@/lib/pghistory-server'

/**
 * Serves the pghistory OpenAPI document.
 *
 * The library registers `/openapi` behind the same JWT as `/api/*` (this entry
 * point never opts into `publicOpenApi`), so the browser cannot reach it
 * directly. This route fetches it with the dashboard's own token and returns
 * the spec — point Scalar, a client generator, or `curl` at it.
 *
 * `/openapi` renders the human-facing reference; this route is the machine
 * one. It inherits whatever protects the dashboard; do not expose the
 * dashboard publicly if the API shape is sensitive.
 */
export async function GET(): Promise<Response> {
	try {
		return Response.json(await getOpenApiSpec())
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
