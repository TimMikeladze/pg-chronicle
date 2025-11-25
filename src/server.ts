import { Hono } from 'hono'
import type { JwtVariables } from 'hono/jwt'
import { jwt } from 'hono/jwt'
import { openAPIRouteHandler } from 'hono-openapi'
import type { Pool } from 'pg'
import { getArchivalStats } from './schema'
import type { ConfigFile } from './types'

type Variables = JwtVariables

export function createServer(pool: Pool, config: ConfigFile) {
	const app = new Hono<{ Variables: Variables }>()

	// Conditionally apply JWT auth if JWT_SECRET is set
	const jwtSecret = process.env.JWT_SECRET
	if (jwtSecret) {
		console.log('JWT authentication enabled')
		app.use('/api/*', (c, next) => {
			const jwtMiddleware = jwt({
				secret: jwtSecret,
			})
			return jwtMiddleware(c, next)
		})
	}

	// Health check endpoint (no auth required)
	app.get('/health', (c) => {
		return c.json({ status: 'ok' })
	})

	// Archival stats endpoint (fast - no audit_log scan)
	app.get('/api/stats', async (c) => {
		const stats = await getArchivalStats(pool)
		return c.json({ stats })
	})

	// OpenAPI documentation endpoint (no auth required)
	app.get(
		'/openapi',
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'pg-history Archiver API',
					version: '1.0.0',
					description: 'API for managing audit log archival',
				},
				servers: [
					{
						url: `http://localhost:${config.healthPort || 3001}`,
						description: 'Local Server',
					},
				],
			},
		}),
	)

	return app
}
