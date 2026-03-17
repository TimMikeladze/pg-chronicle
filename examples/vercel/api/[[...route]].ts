/**
 * Vercel API Route — catch-all handler
 *
 * This single file handles ALL pg-history endpoints:
 *   GET  /api/health
 *   GET  /api/history/:table/:recordId
 *   POST /api/history/search
 *   POST /api/history/revert
 *   POST /api/archive  ← called by Vercel Cron
 *
 * Deploy:
 *   1. Copy this folder into your Vercel project
 *   2. Set environment variables (see below)
 *   3. Deploy with `vercel deploy`
 *
 * Environment variables needed:
 *   PG_HISTORY_DATABASE_URL  - PostgreSQL connection string
 *   PG_HISTORY_TABLES        - Comma-separated table names (e.g. "users,orders")
 *   PG_HISTORY_JWT_SECRET    - JWT secret for /api/* auth (optional)
 *   CRON_SECRET              - Vercel auto-injects this for cron auth
 *
 * For S3 archival (optional):
 *   PG_HISTORY_S3_BUCKET
 *   PG_HISTORY_S3_ENDPOINT
 *   PG_HISTORY_S3_ACCESS_KEY_ID
 *   PG_HISTORY_S3_SECRET_ACCESS_KEY
 *   PG_HISTORY_S3_REGION
 */
export { GET, POST } from 'pg-history/vercel'
