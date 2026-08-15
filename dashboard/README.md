# pg-chronicle dashboard

A Next.js + shadcn/ui dashboard for browsing, searching, and reverting the
PostgreSQL audit trail, served by the pg-chronicle REST API.

It is a **single deployment**: the same app mounts the real pg-chronicle API at
`/api` and renders the UI. Nothing else needs to be running.

```bash
cp .env.example .env.local   # fill in DATABASE_URL, TABLES, JWT_SECRET, DASHBOARD_PASSWORD
bun install
ln -sfn ../.. node_modules/pg-chronicle   # develop against the repo, not npm
bun run dev                  # builds the parent package, then starts Next
```

Open <http://localhost:3000>.

## How it resolves `pg-chronicle`

Two ways, and the difference matters when you change something here.

**In this repo**, `node_modules/pg-chronicle` is a symlink to the repo root, so
the app consumes the library you are editing through its own `exports` map
(`pg-chronicle`, `pg-chronicle/next`). Those entry points resolve to `dist/`, which
is gitignored — which is why `dev`, `build` and `tsc` each build the root
package first. `bun install` replaces the symlink with the npm package, so
re-run the `ln -sfn` above after installing (CI does exactly this).

**Deployed on its own**, `pg-chronicle` is an ordinary npm dependency and this
directory is self-contained: that is what makes the README's one-click Vercel
button work, since the clone flow builds only this folder. `next.config.ts`
picks the tracing root by looking for the parent package, and `vercel.json`
registers the daily archival cron.

CI runs this app as its own job (`dashboard` in `.github/workflows/ci.yml`):
typecheck plus a production build, with no database service, since every page
is `force-dynamic` and the build never opens a connection. Linting is already
covered by the root job's repo-wide `biome check .`.

## Screens

| Route | What it does |
|---|---|
| `/` | Health, archival backlog, recent activity across all tables, jump-to-record |
| `/search` | JSONB containment or ILIKE text search with operation / date-range / table filters, cursor pagination, per-entry diff |
| `/tables` | Every audited table with its last change, actor and archival backlog |
| `/tables/[table]` | One table's recent activity |
| `/history/[table]/[recordId]` | One record's full timeline, oldest/newest ordering, per-entry revert |
| `/archival` | Archival status, backlog and on-demand runs (only when `PG_CHRONICLE_S3_BUCKET` is set) |
| `/api/*` | The pg-chronicle REST API itself — for cron, scripts, and other services |
| `/health` | The library's public probe (bounded `SELECT 1`, 503 when the DB is unreachable) |
| `/openapi` | The API reference, rendered from the OpenAPI document with Scalar |
| `/openapi.json` | The OpenAPI document itself, fetched with the dashboard's own token (the library JWT-gates it) — point a client generator at this |

### Search has two modes

`query` is dispatched by shape, exactly as `PgChronicle.buildSearchConditions`
does it: a value that starts with `{` and ends with `}` is parsed as a **JSONB
containment** document and hits the GIN index; anything else is an **ILIKE
substring scan** over the serialized row. The UI shows which mode is active and
only JSON-validates the containment form — validating everything as JSON would
make text search unreachable. Queries are bounded at 500 characters.

### Revert options

`suppressAuditTriggers` is exposed as an opt-in checkbox. It is off by default
because recording the revert is the repudiation defense, and suppressing it
needs SUPERUSER or the `pg_replication` role (PostgreSQL 16+).

Note that the audit row written for a revert is attributed to the **database
role**. pg-chronicle logs the JWT `sub` on its own log line but never writes it to
`app_actor`, so the audit trail alone does not say which operator reverted —
correlate with the server log.

### Archived history disappears from reads

Both `getHistory` and `search` filter out soft-deleted rows, so once the
archiver has run, that history is in S3 and no longer visible here. The empty
states say so rather than implying the changes never happened.

## How it talks to the API

The dashboard never issues a token to the browser. Server components and server
actions call `lib/pg-chronicle-server.ts`, which mints a 60-second HS256 JWT with
`jose` and invokes the very same route handlers mounted at `/api` — in-process,
with a synthetic `Request`. `hono/vercel`'s `handle()` is just `app.fetch(req)`,
so this is a direct function call: no network hop, no CORS, one connection pool,
and identical auth, validation, and error semantics to any external caller.

The JWT `sub` carries `PG_CHRONICLE_DASHBOARD_ACTOR`, which pg-chronicle logs as the
actor on every revert — that log line is the only record of who used the
dashboard, so set it to something identifiable.

### The UI is password-gated

Loading a page here means being able to read every audited record and revert
any of them, and the app authenticates itself to the API — so the gate has to be
in front of the pages. `middleware.ts` requires a session cookie, minted by
exchanging `PG_CHRONICLE_DASHBOARD_PASSWORD` at `/login`.

- **Production fails closed.** With no password set, the middleware serves a 503
  explaining what to configure instead of rendering the UI.
- **Development runs open**, so local work needs no ceremony.
- **`PG_CHRONICLE_DASHBOARD_ALLOW_ANONYMOUS=true`** is the explicit opt-out for a
  deployment already behind an access proxy that authenticates every request.
- Sessions last `PG_CHRONICLE_DASHBOARD_SESSION_TTL_HOURS` (default 12). The
  cookie is signed with a key derived from the password, so rotating the
  password invalidates every session. That is also the *only* revocation there
  is: with one shared password there are no individual sessions to revoke, and
  signing out clears the browser's cookie but cannot invalidate a copy someone
  else already took. Treat the cookie as a bearer token with a 12-hour life.
- Failed logins are throttled. Each failure doubles the response delay up to 5s,
  and a client the platform gives us an address for is locked out for 15 minutes
  after five failures. A client we *cannot* identify is only ever delayed, never
  locked — a global lockout would let an attacker deny you your own dashboard
  by failing five times. State is per process, so across serverless instances
  this is a large constant factor rather than a hard cap: use a long random
  password.
- `/api/*` is **not** cookie-gated: it is the real REST API behind its own JWT
  and cron secret, and schedulers call it.

### Authorization is still yours to write

Authentication is not authorization. The password says *someone* may come in; it
says nothing about which rows they may touch. Past the gate the dashboard's
self-minted token reaches every record of every configured table. For per-tenant
scoping, mount the API with an `authorize` hook via `createHandlers` from
`pg-chronicle/next` instead of re-exporting the default handlers.

## Two API behaviours worth knowing

**Search and history cursors are not interchangeable.** `search()` always
paginates descending (`id < cursor`); `getHistory()` honours the requested
order. Feeding one to the other returns a silently empty page. They carry
distinct branded types in `lib/types.ts` and never share a variable.

**`CRON_SECRET` and the dashboard's JWT coexist.** On `/api/archive`,
`/api/stats` and `/api/health/detailed` the cron secret is an *alternative*
credential: the scheduler presents `Bearer <CRON_SECRET>`, the dashboard
presents its own token, and both are accepted. (Earlier versions demanded both
at once, which made the route uncallable and greyed out the "Run archival"
button whenever `CRON_SECRET` was set.)

## Design

Colors, type, and surfaces come from `site/src/style.css` so the dashboard and
the marketing site read as one product: ink on warm paper in light, true black
in dark, monochrome accent. The only hues in the UI are four reserved status
steps (good / warning / serious / critical), and every one of them is paired
with an icon and a text label — operation badges spell `INSERT` / `UPDATE` /
`DELETE`, and diff rows carry `+` / `−` / `✎` glyphs — so nothing depends on
color perception alone. Status hue is carried by the icon, border, and tint;
label text always keeps full foreground contrast.

## Notes

- `next.config.ts` marks `pg-chronicle` as a server external. `serverExternalPackages`
  alone misses it because the `file:..` link resolves outside `node_modules`,
  and webpack would otherwise walk into `hono-openapi` and report a missing
  optional `zod/v4/core`.
- Every page is `force-dynamic`. This is operational state; a build-time
  snapshot would be wrong.
- The first request runs `setup()`, installing triggers and the partitioned
  `audit_log` — the same behaviour as `examples/next`.
