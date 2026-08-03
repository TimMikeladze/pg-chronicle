/**
 * Next.js App Router — catch-all route handler.
 *
 * Serves every pghistory endpoint under /api:
 *   GET  /api/history/:table/:recordId
 *   POST /api/history/search
 *   POST /api/history/revert
 *   GET  /api/health/detailed   ┐ archiver only — these exist
 *   POST /api/archive           ┘ only when PGHISTORY_S3_BUCKET is set
 *
 * The public GET /health probe lives outside /api, so it is NOT reachable
 * through this catch-all. Add app/health/route.ts if you need one.
 *
 * Deploy: copy this folder into your Next.js project, set the env vars below,
 * then `vercel deploy`. Cron scheduling is Vercel-specific (see vercel.json);
 * elsewhere, call POST /api/archive from your own scheduler.
 *
 * Required:
 *   PGHISTORY_DATABASE_URL  - PostgreSQL connection string
 *   PGHISTORY_TABLES        - Comma-separated table names (e.g. "users,orders")
 *   PGHISTORY_JWT_SECRET    - This entry point enables the history API, including
 *                              the destructive POST /api/history/revert, so it
 *                              refuses to start without a secret.
 *                              PGHISTORY_ALLOW_UNAUTHENTICATED is ignored here.
 *
 * Optional:
 *   CRON_SECRET              - Vercel Cron injects this; required for /api/archive
 *   PGHISTORY_S3_BUCKET, _ENDPOINT, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _REGION
 */
export { GET, POST } from 'pghistory/next'
