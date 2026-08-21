# pg-chronicle dashboard

A Next.js + shadcn/ui dashboard for browsing, searching, and reverting the
PostgreSQL audit trail, served by the pg-chronicle REST API.

It is a **single deployment** that manages **many databases**: the same app
mounts a real pg-chronicle API per connection under `/api/db/<connection>` and
renders the UI. Nothing else needs to be running.

```bash
cp .env.example .env.local   # three variables — see below
bun install
ln -sfn ../.. node_modules/pg-chronicle   # develop against the repo, not npm
bun run dev                  # builds the parent package, then starts Next
```

Open <http://localhost:3000> and add a connection.

## Databases are added in the UI, not the environment

The environment configures the dashboard. Everything about a *database being
audited* — its connection string, which tables to track, whether it archives to
S3 and on what retention — is entered at `/connections` and stored in the
registry. Adding a database is a form, not a redeploy.

| Variable | Why it cannot be a UI setting |
|---|---|
| `PG_CHRONICLE_DASHBOARD_DATABASE_URL` | It *is* where the UI's settings live. Any Postgres will do, including one you already audit; the dashboard creates a single `pg_chronicle_dashboard_connections` table there on first use. |
| `PG_CHRONICLE_JWT_SECRET` | Signs the API tokens the dashboard mints, and derives the key that encrypts stored credentials. Storing it in the thing it protects would be circular. |
| `PG_CHRONICLE_DASHBOARD_PASSWORD` | Gates the UI. A password you could change from behind the gate is not a gate. |

The rest of `.env.example` is optional: `CRON_SECRET` for scheduled archival,
and knobs for session lifetime, actor name, JWT algorithm and pool size.

### Stored credentials are encrypted

Connection strings and S3 secret keys are sealed with AES-256-GCM before they
are written, under a key derived from `PG_CHRONICLE_JWT_SECRET` with domain
separation, and are never rendered back into the page — the UI shows only
`host:port/database`. A dump of the registry is therefore not a dump of every
audited database's password.

Each ciphertext carries an 8-character fingerprint of the key that sealed it.
Rotating `PG_CHRONICLE_JWT_SECRET` is legible rather than mysterious: affected
connections are listed as **sealed**, and their edit page asks for the
credentials again instead of failing with a decrypt error.

### Saving a connection installs the triggers

The form connects and runs the same initialisation a request would — which is
what installs the audit triggers on the tables listed — *before* writing
anything to the registry. A wrong password, an unreachable host or a table that
does not exist is reported on the form. Nothing half-configured is saved.

Removing a connection unlinks it from the dashboard only. The triggers stay
installed and every recorded change stays in the database.

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
registers the daily archival cron at `/api/cron/archive`.

CI runs this app as its own job (`dashboard` in `.github/workflows/ci.yml`):
typecheck plus a production build, with no database service, since every page
is `force-dynamic` and the build never opens a connection. Linting is already
covered by the root job's repo-wide `biome check .`.

## Screens

Every view of an audit trail is scoped to one connection and says so in its
URL, so a pasted link always opens the database the sender was looking at.

| Route | What it does |
|---|---|
| `/` | Redirects to the only connection, or to the list when there are several |
| `/connections` | Every managed database; add, edit, remove |
| `/connections/new`, `/connections/[id]` | The connection form |
| `/c/[conn]` | Recent activity across that connection's tables, jump-to-record |
| `/c/[conn]/search` | JSONB containment or ILIKE text search with operation / date-range / table filters, cursor pagination, per-entry diff |
| `/c/[conn]/tables` | Every audited table with its last change, actor and archival backlog |
| `/c/[conn]/tables/[table]` | One table's recent activity |
| `/c/[conn]/history/[table]/[recordId]` | One record's full timeline, oldest/newest ordering, per-entry revert |
| `/c/[conn]/archival` | Archival status, backlog and on-demand runs (only when that connection has archival configured) |
| `/c/[conn]/openapi` | The API reference, rendered from the OpenAPI document with Scalar |
| `/c/[conn]/openapi.json` | The OpenAPI document itself, fetched with the dashboard's own token (the library JWT-gates it) — point a client generator at this |
| `/api/db/[conn]/*` | The pg-chronicle REST API for one connection — for scripts and other services |
| `/api/cron/archive` | Runs archival for every connection that has it configured; `Bearer $CRON_SECRET` |
| `/health` | Registry reachability (bounded `SELECT 1`, 503 when it is unreachable) |

### The REST API, per connection

The library registers `/health` and `/openapi` at the root and everything else
under `/api`; the mount drops that prefix so callers write the connection
instead:

```
GET  /api/db/production/history/users/42
POST /api/db/production/history/search
POST /api/db/production/history/revert
GET  /api/db/production/stats
GET  /api/db/production/health/detailed
POST /api/db/production/archive
GET  /api/db/production/health
GET  /api/db/production/openapi
```

Naming a connection in the path grants nothing — an unknown name is a 404 and a
known one still needs the same JWT the library has always required.

### Scheduled archival walks every connection

`vercel.json` points a daily cron at `GET /api/cron/archive`, which reads the
registry and runs archival for each connection that has it configured,
sequentially — each run's memory ceiling is set per run, and running several at
once would multiply a bound chosen to fit the instance. A connection that fails
does not stop the rest, and the response is a 500 if any did, so a broken
nightly archival cannot sit unnoticed in the cron log.

The route is **fail-closed**: without `CRON_SECRET` it is disabled entirely and
answers 503. Unlike the library's own `/api/archive` there is no JWT
alternative — it deletes rows across every managed database, and a browser
session is not a credential for that. Per-connection on-demand runs stay
available from the Archival page.

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
`jose` and dispatches a synthetic `Request` into that connection's own Hono app
— in-process, a direct function call: no network hop, no CORS, one connection
pool per connection, and identical auth, validation, and error semantics to any
external caller.

`lib/connection-runtime.ts` builds one pg-chronicle server per connection with
`createServer` (rather than the library's env-driven `pg-chronicle/next` entry
point, which is exactly the single-database constraint this dashboard removes)
and caches it. The cache is keyed by the registry row's contents, so editing a
connection takes effect on the next request rather than the next cold start,
and bounded at 8 with LRU eviction so a large registry cannot open unbounded
pools on a warm instance.

Every server action names the connection it acts on; there is no ambient
"current database". The id is resolved against the registry server-side, and a
request naming an unknown connection is refused rather than falling back to a
default — on a tool whose most consequential action is `revert`, guessing is not
an option.

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
scoping, pass an `authorize` hook to the `createServer` call in
`lib/connection-runtime.ts`.

## Two API behaviours worth knowing

**Search and history cursors are not interchangeable.** `search()` always
paginates descending (`id < cursor`); `getHistory()` honours the requested
order. Feeding one to the other returns a silently empty page. They carry
distinct branded types in `lib/types.ts` and never share a variable.

**`CRON_SECRET` and the dashboard's JWT coexist.** On a connection's
`/archive`, `/stats` and `/health/detailed` the cron secret is an *alternative*
credential: a caller presents `Bearer <CRON_SECRET>`, the dashboard presents its
own token, and both are accepted. (Earlier versions demanded both at once, which
made the route uncallable and greyed out the "Run archival" button whenever
`CRON_SECRET` was set.) The dashboard's own `/api/cron/archive` is stricter and
takes the cron secret only.

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
- Saving a connection runs `setup()` on its database, installing triggers and
  the partitioned `audit_log` — the same behaviour as `examples/next`, moved
  from the first request to the moment the operator is watching.
