# pghistory dashboard

A Next.js + shadcn/ui dashboard for browsing, searching, and reverting the
PostgreSQL audit trail, served by the pghistory REST API.

It is a **single deployment**: the same app mounts the real pghistory API at
`/api` and renders the UI. Nothing else needs to be running.

```bash
cp .env.example .env.local   # fill in DATABASE_URL, TABLES, JWT_SECRET
bun install
bun run dev                  # builds the parent package, then starts Next
```

Open <http://localhost:3000>. `dev`, `build`, and `tsc` each build the root
`pghistory` package first, because the dashboard consumes it through its
published `exports` map (`pghistory`, `pghistory/next`) via a `file:..` link
— without `dist/`, even the typecheck cannot resolve `pghistory/next`.

CI runs this app as its own job (`dashboard` in `.github/workflows/ci.yml`):
typecheck plus a production build, with no database service, since every page
is `force-dynamic` and the build never opens a connection. Linting is already
covered by the root job's repo-wide `biome check .`.

## Screens

| Route | What it does |
|---|---|
| `/` | Health, archival backlog, recent activity across all tables, jump-to-record |
| `/search` | JSONB containment search with operation / date-range / table filters, cursor pagination, per-entry diff |
| `/history/[table]/[recordId]` | One record's full timeline, oldest/newest ordering, per-entry revert |
| `/api/*` | The pghistory REST API itself — for cron, scripts, and other services |
| `/health` | The library's public probe (bounded `SELECT 1`, 503 when the DB is unreachable) |
| `/openapi` | The API reference, rendered from the OpenAPI document with Scalar |
| `/openapi.json` | The OpenAPI document itself, fetched with the dashboard's own token (the library JWT-gates it) — point a client generator at this |

### Search has two modes

`query` is dispatched by shape, exactly as `PgHistory.buildSearchConditions`
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
role**. pghistory logs the JWT `sub` on its own log line but never writes it to
`app_actor`, so the audit trail alone does not say which operator reverted —
correlate with the server log.

### Archived history disappears from reads

Both `getHistory` and `search` filter out soft-deleted rows, so once the
archiver has run, that history is in S3 and no longer visible here. The empty
states say so rather than implying the changes never happened.

## How it talks to the API

The dashboard never issues a token to the browser. Server components and server
actions call `lib/pghistory-server.ts`, which mints a 60-second HS256 JWT with
`jose` and invokes the very same route handlers mounted at `/api` — in-process,
with a synthetic `Request`. `hono/vercel`'s `handle()` is just `app.fetch(req)`,
so this is a direct function call: no network hop, no CORS, one connection pool,
and identical auth, validation, and error semantics to any external caller.

The JWT `sub` carries `PGHISTORY_DASHBOARD_ACTOR`, which pghistory logs as the
actor on every revert — that log line is the only record of who used the
dashboard, so set it to something identifiable.

### Authorization is still yours to write

Authentication is not authorization. Any valid token can reach every record of
every configured table unless you supply an `authorize` hook. The dashboard runs
with a token it minted itself, so **it has blanket access by design** — put it
behind your own SSO / network boundary. Do not expose it publicly.

## Two API behaviours worth knowing

**Search and history cursors are not interchangeable.** `search()` always
paginates descending (`id < cursor`); `getHistory()` honours the requested
order. Feeding one to the other returns a silently empty page. They carry
distinct branded types in `lib/types.ts` and never share a variable.

**`CRON_SECRET` disables the "Run archival" button.** With it set,
`POST /api/archive` requires the Authorization header to be exactly
`Bearer <CRON_SECRET>`, but the `/api/*` JWT middleware rejects anything that
is not a valid token before the handler runs — one header cannot be both. Since
this entry point always runs with a JWT secret, setting `CRON_SECRET` makes
on-demand archival scheduler-only. The button explains this rather than failing
with a 401.

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

- `next.config.ts` marks `pghistory` as a server external. `serverExternalPackages`
  alone misses it because the `file:..` link resolves outside `node_modules`,
  and webpack would otherwise walk into `hono-openapi` and report a missing
  optional `zod/v4/core`.
- Every page is `force-dynamic`. This is operational state; a build-time
  snapshot would be wrong.
- The first request runs `setup()`, installing triggers and the partitioned
  `audit_log` — the same behaviour as `examples/next`.
