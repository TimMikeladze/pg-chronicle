/**
 * The real pg-history REST API, mounted at /api.
 *
 * The dashboard itself does NOT go through this route — it calls the same
 * handlers in-process (see lib/pg-history-server.ts). This mount exists so the
 * deployment is a complete pg-history server for everything else: cron
 * schedulers hitting POST /api/archive, scripts, and other services.
 *
 * Note that the public GET /health probe lives outside /api and is therefore
 * served by app/health/route.ts instead, not by this catch-all.
 *
 * Required env: PG_HISTORY_DATABASE_URL, PG_HISTORY_TABLES, PG_HISTORY_JWT_SECRET.
 */
export { GET, OPTIONS, POST } from 'pg-history/next'

// The pool and the audit triggers are per-instance state; a static render would
// capture a build-time response.
export const dynamic = 'force-dynamic'
