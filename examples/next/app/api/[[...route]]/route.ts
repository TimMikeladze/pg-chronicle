/**
 * Next.js App Router — catch-all route handler.
 *
 * Serves every pg-chronicle endpoint under /api:
 *   GET  /api/history/:table/:recordId
 *   POST /api/history/search
 *   POST /api/history/revert
 *   GET  /api/health/detailed   ┐ archiver only — these exist
 *   POST /api/archive           ┘ only when PG_CHRONICLE_S3_BUCKET is set
 *
 * The public GET /health probe lives outside /api, so it is NOT reachable
 * through this catch-all. Add app/health/route.ts if you need one.
 *
 * Deploy: copy this folder into your Next.js project, set the env vars below,
 * then `vercel deploy`. Cron scheduling is Vercel-specific (see vercel.json);
 * elsewhere, call POST /api/archive from your own scheduler.
 *
 * Required:
 *   PG_CHRONICLE_DATABASE_URL  - PostgreSQL connection string
 *   PG_CHRONICLE_TABLES        - Comma-separated table names (e.g. "users,orders")
 *   PG_CHRONICLE_JWT_SECRET    - This entry point enables the history API, including
 *                              the destructive POST /api/history/revert, so it
 *                              refuses to start without a secret.
 *                              PG_CHRONICLE_ALLOW_UNAUTHENTICATED is ignored here.
 *
 * Optional:
 *   CRON_SECRET              - Vercel Cron injects this. Accepted INSTEAD of a
 *                              JWT on /api/archive, /api/stats and
 *                              /api/health/detailed, so a scheduler and a
 *                              token-bearing client can both get in.
 *   PG_CHRONICLE_S3_BUCKET, _ENDPOINT, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _REGION
 *
 * OPTIONS is exported so CORS preflight works; without it Next answers 405 and
 * the browser blocks the real cross-origin request.
 *
 * Need an `authorize` hook, custom CORS, or your own pool? Those cannot come
 * from environment variables — use `createHandlers` instead:
 *
 *   import { createHandlers } from 'pg-chronicle/next'
 *   export const { GET, POST, OPTIONS } = createHandlers({ authorize: ... })
 */
export { GET, OPTIONS, POST } from 'pg-chronicle/next'
