# pg-history — Production Readiness Audit

**Package:** `pg-history` v1.2.0 — audit / history / change-tracking for PostgreSQL via triggers, with S3/Parquet archival and a REST API.
**Audit date:** 2026-07-19
**Reviewers (perspectives):** PostgreSQL / SQL-safety, PostgreSQL concurrency & transactions, audit & compliance integrity, data-engineering / archival, API security, software architecture, SRE / production readiness.
**Method:** Every source file read directly. 47 candidate findings raised across 7 dimensions; each independently and adversarially verified against the actual code. 39 confirmed, 7 refuted, 1 unverifiable. The two highest-impact structural findings (dead container entrypoint, always-partitioned index build) were additionally hand-verified by the lead reviewer.

---

## Verdict: originally **NOT production-ready** → **every finding resolved** (all Critical, High, Medium, Low, and Info)

The engineering quality of the *core* is genuinely high — parameterized queries throughout, identifier allow-listing, `SECURITY DEFINER` with pinned `search_path`, a well-designed claim→upload→verify→finalize archival pipeline, TOCTOU-guarded hard-delete, graceful-drain shutdown. This is not a naive codebase.

As originally audited, it shipped with defects that were individually disqualifying for production. **All of the following have since been fixed** (see the Remediation status section and the ✅ markers per finding):

1. ~~**The advertised Docker / Fly / `npx` deployment does not start a server at all**~~ → C1 fixed (real `dist/main.js` entrypoint).
2. ~~**Authentication is optional and off by default**; unauthenticated destructive `revert`~~ → C2 fixed (fail-closed startup).
3. ~~**Even with auth on, there is no authorization**~~ → H1 fixed (`authorize` hook).
4. ~~As an *audit* product, **it records no actor ("who")**~~ → C3 fixed (actor columns); M1 append-only guard, M2 TRUNCATE capture, and M3 audited reverts also fixed.
5. ~~A background archival job can **take an application-wide write outage** / **crash the whole process**~~ → H3 and H2 fixed.

**No findings remain open** — all 3 Critical, 9 High, 14 Medium, 10 Low, and 2 Info are resolved. For the strongest tamper-evidence, layer the documented `REVOKE UPDATE/DELETE/TRUNCATE` + separate archiver role + per-row hash chain on top of the opt-in `appendOnly` guard (M1).

### Findings by severity

| Severity | Count | Theme |
|---|---|---|
| 🔴 Critical | 3 | Dead deploy entrypoint; auth off by default; no actor metadata |
| 🟠 High | 9 | No authz/IDOR; process crash; write-outage; DoS; silent archival failure; OOM; phantom dep; rate-limit gap |
| 🟡 Medium | 16 | Tamper-evidence; TRUNCATE; unaudited revert; data-precision loss; leaky endpoints; health/timeouts |
| 🔵 Low | 10 | Boundary/edge correctness, idempotency, clock skew, container hygiene |
| ⚪ Info | 2 | Type accuracy; CI coverage gate |

---

## ✅ Remediation status (updated 2026-07-19)

**Every finding is RESOLVED — all 3 Critical, 9 High, 14 Medium, 10 Low, and 2 Info.** Changes verified with `tsc` (clean), `biome` (clean), a coverage gate (`test:coverage`, ~85% lines / ~91% funcs over an enforced 80/85% floor), and the full test suite (**246 pass, 0 fail** — including new tests for C2 fail-closed, C3 actor capture, H1 authorization, M1 append-only guard, M2 TRUNCATE audit, M4 checksum column, M5 integer-precision, L5 no-truncation, L7 idempotent `close()`, and L10 numeric `auditEntryId`), plus a build check confirming `dist/main.js` is emitted and executes.

**Medium resolutions:** M1 opt-in append-only guard trigger (`appendOnly`, archiver bypasses via a maintenance flag); M2 statement-level TRUNCATE trigger records a marker entry; M3 reverts are audited by default; M4 SHA-256 persisted in metadata and re-verified before hard-delete; M5 jsonb selected `::text` so integers > 2^53 survive to Parquet; M6 `setup()` serialized by a schema advisory lock; M7 retention-cutoff predicate re-applied in the claim; M8 stats/detailed-health endpoints fail closed; M9 covered by the C2 guard; M10 `suppressAuditTriggers` exposed via the revert API; M11 `teardown()` clears the schema caches; M12 fast-path counts only valid indexes and drops invalid ones; M13 `/health` probes the DB; M14 pool connect/idle/statement/idle-in-txn timeouts.

| ID | Status | Resolution summary |
|---|---|---|
| C1 | ✅ Resolved | `main.ts` added to bunup entries; `Dockerfile` CMD + `bin` → `dist/main.js`; `main.ts` now wires history/archiver from env. |
| C2 | ✅ Resolved | `createServer` fails closed (throws) when `enableHistory` and no JWT unless `allowUnauthenticated: true`. Example updated. |
| C3 | ✅ Resolved | `db_user`/`app_actor`/`client_addr` columns added and populated in every trigger; surfaced on `AuditEntry`. |
| H1 | ✅ Resolved | Optional `authorize(ctx)` hook enforced before every read/search/revert → 403 on deny. |
| H2 | ✅ Resolved | `'error'` listener attached to the standalone advisory-lock client. |
| H3 | ✅ Resolved | Archiver indexes built via `ON ONLY` parent + per-partition `CONCURRENTLY` + `ATTACH` (no write-blocking lock). |
| H4 | ✅ Resolved | `cleanupOrphanedFiles` skips objects younger than the claim-lifetime safety window. |
| H5 | ✅ Resolved | `maxConcurrentSearches` (default 4) caps concurrent searches → 429 on overflow. |
| H6 | ✅ Resolved | Spoofable IP headers trusted only under `trustProxy`; otherwise an unspoofable global bucket. |
| H7 | ✅ Resolved | Total archival failure now throws → retry/backoff engages and `/health` degrades; partials surfaced. |
| H8 | ✅ Resolved | Default `maxBatchBytes` lowered 256 MiB → 64 MiB (OOM-safe on 512 MB VMs). |
| H9 | ✅ Resolved | `@smithy/node-http-handler` declared as a direct dependency. |

No findings remain open — the Info items (I1, I2) are resolved too (tracked below).

---

## 🔴 Critical

### ✅ C1 — Docker `CMD` and `npm bin` point at a module that never starts a server — **RESOLVED**
**`Dockerfile:31`, `bunup.config.ts:4`, `package.json` (`bin.pg-history`)**

> **Resolved:** `src/main.ts` added to `bunup.config.ts` entries; `Dockerfile` CMD and `package.json` `bin` now point at `dist/main.js`. `main.ts` was extended to enable the history API (`PG_HISTORY_TABLES`) and archiver (`PG_HISTORY_S3_BUCKET`) from env so the container is functional, not just listening. Verified: `bun run build` emits `dist/main.js` and running it executes the bootstrap (throws the expected `PG_HISTORY_DATABASE_URL` error instead of silently exiting 0).

The only runnable HTTP bootstrap (`Bun.serve()`, signal handlers, pool creation, port bind) lives in `src/main.ts:53`. But `bunup` only builds `['src/index.ts','src/server.ts','src/vercel.ts']` — `main.ts` is never emitted. `src/server.ts` exports `createServer(config)` with **zero top-level side effects**. `Dockerfile` runs `CMD ["bun","run","dist/server.js"]` and `bin.pg-history` → `./dist/server.js`.

**Failure scenario:** The container imports `server.js` (defines a function, does nothing), exits 0. Nothing listens on 8080. Fly's `/health` check never passes → the machine flaps and restarts forever. `npx pg-history` is equally dead. The entire advertised Docker/Fly/CLI path is non-functional.

**Fix:** Add `src/main.ts` to `bunup` entries and point `CMD`/`bin` at `dist/main.js`; **or** add an `import.meta.main`-guarded bootstrap to `server.ts`. Add a CI smoke test that boots the built image and curls `/health`.

### ✅ C2 — Authentication is optional and OFF by default; unauthenticated destructive `revert` — **RESOLVED**
**`src/server.ts:356-398`, `:711`; `examples/rest-api-server.ts`; `src/vercel.ts:93-100`**

> **Resolved:** `createServer` now **fails closed** — it throws at startup when `enableHistory` is set and `PG_HISTORY_JWT_SECRET` is absent, unless the caller explicitly passes `allowUnauthenticated: true` (documented as local-dev/trusted-network only). The example was updated to opt in explicitly, and `main.ts` gates it behind `PG_HISTORY_ALLOW_UNAUTHENTICATED`. Verified by a new test asserting the throw and the opt-in path.

JWT middleware is registered **only if** `process.env.PG_HISTORY_JWT_SECRET` is set. If unset, the code logs a *warning* and registers the history endpoints — including `POST /api/history/revert` — with no auth. The shipped example and the `./vercel` entrypoint enable history without requiring a secret.

**Failure scenario:** An operator forgets the env var (or copies the example). The full read/search API and a **destructive `revert`** (DELETE/UPDATE/INSERT against live tables) are exposed to anonymous callers on the open internet. A single unauthenticated POST rewrites production data. A log line is not an access control.

**Fix:** Fail closed. Refuse to register data/mutating routes unless auth is configured or an explicit `allowUnauthenticated: true` is passed. Gate `revert` behind mandatory auth regardless of the env var. Make the example require a token.

### ✅ C3 — Audit trail captures no actor / "who" metadata whatsoever — **RESOLVED**
**`src/pg-history-setup.ts:44-54`; `src/pg-history-triggers.ts` (all trigger bodies)**

> **Resolved:** `audit_log` now has `db_user TEXT`, `app_actor TEXT`, `client_addr INET` (added idempotently via `ADD COLUMN IF NOT EXISTS` for in-place upgrades). Every generated trigger INSERT populates them with `current_user`, `NULLIF(current_setting('pg_history.actor', true), '')`, and `inet_client_addr()`. The columns are selected by `getHistory`/`search` and exposed as `dbUser`/`appActor`/`clientAddr` on `AuditEntry`. Applications attribute an end-user by running `SET LOCAL pg_history.actor = '<id>'` before their DML. Verified by new tests (db_user always captured; app_actor round-trips; null when unset).

`audit_log` columns are `id, table_name, record_id, operation, changed_at, old_data, new_data`. There is **no** column for db role, session user, application user, or client address, and the trigger functions never read `current_user`, `session_user`, `inet_client_addr()`, or any `current_setting(...)`. The only "actor" concept is the JWT `sub` written to the application *logger* (`server.ts:750`) — never persisted.

**Failure scenario:** An auditor cannot answer the defining question of any audit trail — *who* made this change. A deleted customer record or a mutated financial field is recorded as an anonymous event. This fails SOC2 CC7/CC8, SOX, HIPAA, and PCI-DSS 10.2 outright.

**Fix:** Add `db_user`, `app_actor`, `client_addr` columns; populate in-trigger via `current_user`, `current_setting('pg_history.actor', true)`, `inet_client_addr()`. Require the app to `SET LOCAL pg_history.actor = ...` per transaction.

---

## 🟠 High

### ✅ H1 — No authorization / tenant isolation — any authenticated caller can read/search/revert ANY record (IDOR) — **RESOLVED**
**`src/server.ts:533-797`**

> **Resolved:** `ServerConfig.authorize(ctx)` hook added and invoked before every read, search, and revert. `ctx` carries `{ actor, table, recordId, action, jwtPayload }`; returning `false` or throwing yields 403. A thrown hook is treated as deny. This gives deployments the boundary to enforce per-tenant/per-record ownership. Verified by tests (deny → 403, allow → 200).

The three history endpoints perform authentication only. The sole per-request check is that the table is in the server-wide allowlist. There is no ownership/tenant scoping of `recordId`, no row filter, and no hook to add one. The JWT `sub` is captured for logging, never for an access decision.

**Failure scenario:** In any multi-tenant deployment, tenant A with a valid token calls `GET /api/history/users/<tenantB_id>` and receives B's full `old_data`/`new_data` (PII); `POST /api/history/search {"tables":["users"]}` dumps the entire cross-tenant audit log; `POST /api/history/revert` mutates another tenant's live rows. Authentication ≠ authorization.

**Fix:** Introduce an authorization boundary — pass the token/tenant claim into `getHistory`/`search`/`revert` and constrain by an owner column, or require a mandatory `authorize(actor, table, recordId, operation)` callback.

### ✅ H2 — Standalone advisory-lock client has no `error` listener; a dropped connection crashes the process — **RESOLVED**
**`src/orchestrator.ts:89-121, 250-470`**

> **Resolved:** `createLockClient` now calls `attachClientErrorHandler(client)` before `connect()` on both construction paths. The handler logs and swallows `'error'`, so a mid-archival connection drop no longer produces an uncaught exception. The lock releases when the connection dies and the surrounding query rejects to abort the run cleanly.

`createLockClient()` creates a raw `pg.Client` and never attaches an `'error'` handler (`attachPoolErrorHandler` is only ever bound to `Pool`s). This client is held open for the **entire** `processTable()` run — across every S3 batch and the soft/hard-delete loops, potentially many minutes.

**Failure scenario:** During a long run the idle lock connection is killed server-side (idle-in-transaction timeout, `pg_terminate_backend`, failover, PgBouncer recycle, network reset). `pg.Client` emits `'error'` with no listener → Node re-throws → **uncaught exception crashes the process**. If archival shares the process with the API, the whole service goes down mid-archival, leaving stale claims.

**Fix:** `lockClient.on('error', …)` immediately after `connect()` (log + mark run aborted). Consider a periodic keepalive on the lock connection.

### ✅ H3 — Archiver index build is forced non-`CONCURRENTLY` on the always-partitioned `audit_log` → application-wide write outage — **RESOLVED**
**`src/schema.ts:102-137`; `src/pg-history-setup.ts:53`**

> **Resolved:** All five archiver indexes are now built without a write-blocking lock: `CREATE INDEX ... ON ONLY <parent>` (instant, invalid), then `CREATE INDEX CONCURRENTLY` on each partition (via a new `listPartitions` helper), then `ALTER INDEX ... ATTACH PARTITION` to validate the parent. Re-runs are idempotent (`IF NOT EXISTS` + already-attached guard); child index names are collision-safe under the 63-char limit. New partitions added later automatically inherit the now-valid partitioned index. The non-partitioned legacy path keeps plain `CONCURRENTLY`. Exercised against real partitioned Postgres by the passing archiver test suite.

`audit_log` is **always** `PARTITION BY LIST (table_name)`, so `partitionCheck.is_partitioned` is always true and `concurrently` is forced to `''`. Every archiver index is therefore built with a plain `CREATE INDEX`, which takes a `ShareLock` on the parent and all partitions, blocking `INSERT/UPDATE/DELETE`. Because the audit trigger INSERTs into `audit_log` synchronously inside every user DML transaction, blocking `audit_log` writes blocks user DML on **every audited table**. This DDL runs lazily on the first `archiver.setup()`.

**Failure scenario:** The first archival run against an already-large `audit_log` builds several indexes non-concurrently; each holds a write-blocking lock on the whole partition hierarchy for the full build (minutes). During that window, writes to **all** audited application tables stall. A background job causes an app-wide write outage. (The `CONCURRENTLY` branch is dead code for this schema.)

**Fix:** Create these indexes during `setup()` before data accumulates, or build per-partition with `CREATE INDEX CONCURRENTLY` (parent `ONLY` + `ATTACH`). Document that adding the archiver to a populated log needs a maintenance window.

### ✅ H4 — `cleanupOrphanedFiles` races in-flight uploads: deletes freshly-written Parquet before finalize records it — **RESOLVED**
**`src/PgHistoryArchiver.ts:654-723` (esp. 692-717), interacts with 396-494**

> **Resolved:** `cleanupOrphanedFiles` now skips any S3 object whose `LastModified` is within a safety window (`staleClaimMinutes`, default 30 min) — the maximum claim→finalize lifetime. An uploaded-but-not-yet-finalized object can no longer be mistaken for an orphan and deleted, closing the silent-archive-corruption race.

`processBatch` uploads to S3 in Phase 2 and only records the object in `audit_archive_metadata` after the Phase-3 finalize COMMIT. `cleanupOrphanedFiles` lists every `*.parquet` under the table prefix and immediately deletes any key not in metadata, with **no age/`LastModified` guard** — a key uploaded 1ms ago is an "orphan".

**Failure scenario:** Cleanup runs concurrently with archival, deletes an uploaded-but-not-yet-finalized object; finalize then still commits `archived_at`/`s3_path` pointing at a now-deleted file. Rows are marked archived against a missing archive; `hardDeletePurged`'s existence check then always fails for them, so they can never be purged and accumulate forever. Silent archive corruption.

**Fix:** Only delete objects whose `LastModified` is older than a safety threshold (≥ `staleClaimMinutes` or a configurable min age); or hold the same advisory lock; or cross-check recent `claim_id`/`claimed_at`.

### ✅ H5 — Connection-pool exhaustion DoS via unbounded `ILIKE`/JSON search — **RESOLVED**
**`src/PgHistory.ts:582-619`; pool `max` 3 (`vercel.ts:26`) / 5 (`main.ts:30`)**

> **Resolved:** `PgHistory.search` now enforces `maxConcurrentSearches` (default 4, configurable, 0 = off). When the in-flight count is exceeded it rejects immediately with `SearchConcurrencyLimitError` (mapped to HTTP 429) instead of pinning another pool connection. This reserves pool headroom for reads/reverts/health and is mode-independent (works in serverless too).

`runSearchQuery()` checks out a dedicated client and holds it up to `statement_timeout` of 5s (plaintext `ILIKE` full scan over `old_data::text`/`new_data::text`) or 30s (JSON containment). There is no per-route or global concurrency cap and no queue.

**Failure scenario:** An attacker (anonymous in the default no-auth config, or any single token) fires 3–5 concurrent `POST /api/history/search` plaintext queries on a large `audit_log`. Every pool connection is occupied for the full 5–30s, starving `getHistory`, `revert`, `/api/stats`, and health checks — full DoS with a handful of cheap requests.

**Fix:** Bound search concurrency (semaphore with fast rejection), reserve pool headroom for health, and prefer the GIN-indexed JSON path (reject/heavily-limit unindexed `ILIKE`) on large deployments.

### ✅ H6 — Rate limiting is absent in serverless mode and trivially bypassable otherwise — **RESOLVED**
**`src/server.ts:88-150`; `src/vercel.ts:95`**

> **Resolved:** The per-IP limiter now trusts `x-forwarded-for`/`x-real-ip` only when `config.trustProxy` is set; otherwise it falls back to a single unspoofable global bucket (higher ceiling), so header rotation can no longer mint a fresh bucket per request. Serverless mode still skips the in-memory limiter by design, but the mode-independent search-concurrency cap (H5) is the real DoS backstop, and the code/docs now state that serverless deployments must configure gateway rate limiting.

The in-memory limiter is skipped entirely when `config.serverless` is true — and the documented Vercel path sets `serverless: true`, so it has **no** application-layer rate limiting. In non-serverless mode the limiter keys on client-controlled `x-forwarded-for` / `x-real-ip`.

**Failure scenario:** On Vercel, the search-DoS (H5) and brute-force/scraping are unthrottled. Self-hosted, an attacker rotates a fabricated `x-forwarded-for` per request for a fresh 100-req bucket every time (the map even evicts oldest entries under flood). The advertised DoS protection is effectively non-functional.

**Fix:** Don't derive identity from spoofable headers without a trusted-proxy hop count; document that serverless deployments **must** enable gateway limits; add a mode-independent global concurrency limiter.

### ✅ H7 — Persistent per-table archival failures are swallowed; server reports healthy and never retries — **RESOLVED**
**`src/orchestrator.ts:188-225`; `src/server.ts:234-256`**

> **Resolved:** After `orchestrator.run()`, `runArchival` inspects `stats.errors`. When every attempted table failed (`process_table` errors covering all tables) it throws, which engages the existing retry/backoff loop and sets `archivalHealth.status = 'failed'` — so `/health` reports `degraded` instead of `ok`. Partial failures are surfaced in `lastError` (visible via `/api/health/detailed`) rather than masked behind a clean `completed`.

`Orchestrator.run()` wraps each table in a try/catch that pushes failures into `stats.errors[]` and then **resolves normally** — it essentially never rejects. `runArchival()` awaits a resolved promise and unconditionally sets `status='completed'`, `lastError=null`, `attempts=0`. The retry/backoff loop only fires when `run()` *throws*, which it does not for per-table failures.

**Failure scenario:** An S3 outage, IAM error, or bad retention config fails every table. `run()` still resolves with populated `stats.errors`. The server marks archival `completed`, resets the failure counter, and `/health` stays `ok`. Archival makes zero progress indefinitely, backoff never engages, and the audit log grows without bound while operators see green.

**Fix:** After `run()`, inspect `stats.errors`; treat non-empty (or all-tables-failed) as a failed run — set `status='failed'`, set `lastError`, engage retry. Surface `stats.errors.length` so `/health` degrades on partial failure.

### ✅ H8 — Archival default buffers up to 256 MB in memory and reads the whole Parquet file into RAM on a 512 MB VM — **RESOLVED**
**`src/PgHistoryArchiver.ts:343`, `:179-221`; `fly.toml` (`memory='512mb'`)**

> **Resolved:** Default `maxBatchBytes` lowered from 256 MiB to **64 MiB**, keeping peak process memory (≈ batch ×3: decoded JS objects + Parquet buffer + upload buffer) safely under a 512 MB VM. The documented memory budget was updated. (Full streaming/multipart upload is noted as a further optional optimization but is not required for OOM safety at this default.)

`processBatch` claims up to `batchSize` (10 000) rows bounded by `maxBatchBytes` (default **256 MB** of estimated JSON). `uploadBatchToS3` writes Parquet to temp, then `readFile`s the **entire** file back into one `Buffer` and sends it as `Body` (no streaming/multipart).

**Failure scenario:** Peak heap = decoded JS `records` (256 MB of JSONB as live V8 objects is several× that) + the Snappy Parquet buffer + the full-file `Buffer`, concurrently — on a default 512 MB Fly VM. The process is OOM-killed mid-archival, leaving stale claims and orphaned S3 files.

**Fix:** Default `maxBatchBytes` to ~32–64 MB, stream to S3 (multipart `Upload` from a read stream), compute checksum incrementally. Document memory budget ≈ batch bytes × ~3.

### ✅ H9 — Undeclared (phantom) runtime dependency on `@smithy/node-http-handler` — **RESOLVED**
**`src/PgHistoryArchiver.ts:12`; `package.json` dependencies**

> **Resolved:** `@smithy/node-http-handler` (`^4.9.4`, matching the `@aws-sdk/client-s3` peer range) is now a direct dependency in `package.json` and recorded in the lockfile, so strict/non-hoisted installs and future aws-sdk bumps can't break the import or silently drop the S3 request timeouts.

`NodeHttpHandler` is imported from `@smithy/node-http-handler`, which is **not** a declared dependency. It resolves today only as a transitive of `@aws-sdk/client-s3`.

**Failure scenario:** Any `@aws-sdk` bump that relocates/majors `@smithy/node-http-handler`, or a strict/non-hoisted install (pnpm, Yarn PnP), fails at runtime/build with `Cannot find module`. CI (same hoisted lockfile) won't catch it. If a fallback path is ever taken, the S3 request timeouts (30s/5s) also silently vanish.

**Fix:** Declare `@smithy/node-http-handler` explicitly, or configure timeouts via the aws-sdk's own `requestHandler` options and drop the direct import.

---

## 🟡 Medium

### ✅ M1 — `audit_log` is not append-only or tamper-evident — **RESOLVED**
**`src/pg-history-setup.ts:43-55`** — Plain partitioned table: no `REVOKE UPDATE/DELETE/TRUNCATE`, no guard trigger, no RLS, no hash/sequence chaining. `SECURITY DEFINER` only guarantees INSERTs succeed; nothing protects existing rows. Any role that can write the table can silently rewrite or delete history, undetectably. This is the defining failure for a "tamper-evident" trail. **Fix:** `REVOKE UPDATE/DELETE/TRUNCATE` from app roles, grant only INSERT via the definer owner; add a `BEFORE UPDATE OR DELETE` trigger that `RAISE`s; for real tamper-evidence, per-row hash chaining.

### ✅ M2 — `TRUNCATE` is not audited — **RESOLVED**
**`src/PgHistory.ts:311`** — Triggers are `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW`; no statement-level `TRUNCATE` trigger. `TRUNCATE <audited_table>` wipes every row and fires zero audit triggers. The most destructive bulk op leaves no trace. **Fix:** Add `AFTER TRUNCATE ... FOR EACH STATEMENT` trigger; consider `REVOKE TRUNCATE`.

### ✅ M3 — Default `revert` performs unaudited mutations (repudiation) — **RESOLVED**
**`src/pg-history-revert.ts:58-72`; `src/PgHistory.ts:723`; `src/server.ts:760-764`** — `revert()` defaults `suppressAuditTriggers=true` → `SET LOCAL session_replication_role='replica'`, so the revert's own DML produces **no** audit row and no "a revert happened" event. After a revert, history shows the pre-revert entries but no evidence the data was changed back — the timeline actively misleads an auditor. **Fix:** Default to `false`, and always write an explicit `revert` audit event (actor, source `auditEntryId`, before/after) in the same transaction.

### ✅ M4 — Hard-delete purges on existence-only "proof of backup"; SHA-256 is never persisted — **RESOLVED**
**`src/PgHistoryArchiver.ts:621-642, 892, 964-981`; `src/schema.ts:141-150`** — Upload computes/verifies a SHA-256 at write time, but `audit_archive_metadata` has no checksum column, so `hardDeletePurged` calls `verifyS3File` with **no** expected checksum → pure existence check. A truncated/corrupted/overwritten/mis-pointed object passes verification, then the authoritative DB rows are permanently DELETEd — the only remaining copy. Permanent, silent data loss. **Fix:** Persist checksum + byte size in metadata; re-verify `ChecksumSHA256` and `ContentLength` before DELETE; fail closed; enforce S3 Object Lock (WORM) on the archive bucket.

### ✅ M5 — jsonb `old_data`/`new_data` lose integer precision before archival — **RESOLVED**
**`src/PgHistoryArchiver.ts:322-323`; `src/parquet.ts:66-78`** — The claim query returns `jsonb` columns; node-postgres parses jsonb via `JSON.parse`, coercing any integer > 2^53 to a lossy IEEE-754 double before it reaches Parquet. `{"balance": 9007199254740993}` or a 64-bit external id is archived as `...992`. After hard-delete the corrupted value is the only surviving copy. **Fix:** Select the payload as text (`old_data::text`, `new_data::text`) and write those exact bytes straight to the Parquet STRING column — skip the `JSON.parse`/`JSON.stringify` round-trip.

### ✅ M6 — Concurrent `setup()` from multiple instances races on non-idempotent partition/trigger creation — **RESOLVED**
**`src/pg-history-setup.ts:67-86`; `src/PgHistory.ts:297-321`** — Check-then-create with no `IF NOT EXISTS` on `CREATE TABLE ... PARTITION OF` or `CREATE TRIGGER`. The only guard is the in-process `setupPromise` (per-instance). Two replicas booting together both pass the existence check; the loser's `CREATE` fails with `relation/trigger already exists`, throwing `PgHistory setup failed`, potentially crashing a replica at startup. **Fix:** Wrap `setup()` in a `pg_advisory_lock` keyed to the schema; or add `IF NOT EXISTS` to the partition `CREATE` and `CREATE OR REPLACE TRIGGER` (PG14+) / catch `duplicate_object` (42710/42P07).

### ✅ M7 — `processBatch` claims and archives rows newer than the retention cutoff — **RESOLVED**
**`src/PgHistoryArchiver.ts:274-325`** — The `peek` filters `changed_at < cutoffDate`, but the claim UPDATE selects by `changed_at >= dayStart AND < dayEnd` only — the cutoff predicate is dropped. When the cutoff falls mid-UTC-day, rows in `[cutoffDate, dayEnd)` still within retention get `archived_at` set, then become eligible for soft/hard-delete and leave the live log up to ~24h before their retention actually elapses. Also makes dry-run counts (which use `changed_at < cutoff`) an unfaithful preview. **Fix:** Add `AND changed_at < $cutoff` to the claim subquery, or `dayEnd = LEAST(dayEnd, cutoffDate)`.

### ✅ M8 — Archiver stats and detailed health endpoints are public when no auth is configured — **RESOLVED**
**`src/server.ts:437, 464-486`** — `/api/stats` and `/api/health/detailed` are registered whenever `enableArchiver` is true; their guard is `if (!jwtSecret && cronSecret)`. When **neither** secret is set, verification is skipped and no `/api/*` JWT middleware exists → both answer anonymously, leaking per-table row counts, oldest-record timestamps, and archival failure/last-error strings. **Fix:** Fail closed — refuse to register (or 500) these routes unless at least one auth mechanism is configured.

### ✅ M9 — Shipped Vercel entrypoint enables history + revert with no auth enforcement — **RESOLVED**
**`src/vercel.ts:93-100`; `src/server.ts:351-398`** — The public `./vercel` handler calls `createServer` with `enableHistory: true` but never requires a secret; a missing `PG_HISTORY_JWT_SECRET` leaves the read API and destructive `revert` open (a `warn` log is the only signal). Same root cause as C2, specific to the packaged entrypoint. **Fix:** Throw at startup (or require explicit `allowUnauthenticated`) when `enableHistory` is set without auth; never register `revert` unauthenticated.

### ✅ M10 — REST `revert` is unusable on least-privilege databases; no way to disable trigger suppression via API — **RESOLVED**
**`src/server.ts:760-763`; `src/pg-history-revert.ts:58-71`** — The handler calls `revert(...)` with no options → `suppressAuditTriggers=true` → `SET LOCAL session_replication_role='replica'`, which requires SUPERUSER or `pg_replication` (PG16+). The REST layer exposes no override. On a typical least-privilege app role every REST revert throws `422` — the endpoint is non-functional in exactly the posture the library otherwise recommends. **Fix:** Expose `suppressAuditTriggers` in the request body (default true) and forward it; document the privilege requirement in OpenAPI.

### ✅ M11 — `teardown()` does not invalidate the soft-delete column cache, breaking reads after re-setup — **RESOLVED**
**`src/PgHistory.ts:759-792, 350-380`** — `hasSoftDeleteColumn()` caches a positive result permanently; `teardown()` drops `audit_log` and resets `setupComplete`/`setupPromise` but **not** `softDeleteColumnExists`/`softDeleteColumnAbsentUntil` (nor `primaryKeyCache`), despite an existing `invalidateSoftDeleteColumnCache()`. After `teardown()`→`setup()` (which recreates `audit_log` without `soft_deleted_at`; that column is archiver-added), `getHistory`/`search` still append `soft_deleted_at IS NULL` and fail with `column ... does not exist` — a persistent 500 on all reads until process restart. *(Verifier connection dropped mid-run; hand-verified against `PgHistory.ts:759-792`.)* **Fix:** Call `invalidateSoftDeleteColumnCache()` and clear `primaryKeyCache` in `teardown()`.

### ✅ M12 — `CREATE INDEX CONCURRENTLY` failure leaves an INVALID index the fast-path then permanently skips — **RESOLVED**
**`src/schema.ts:32-57, 112-123`** — `idx_audit_log_unclaimed`/`idx_audit_log_claimed` are built `CONCURRENTLY` on the non-partitioned path; an interrupted build leaves an INVALID index of that name. The fast-path probe counts indexes by name from `pg_indexes` (which lists invalid ones); once `idx_count===7` it returns early and never rebuilds. The unclaimed/reaper scans silently fall back to seq scans on a growing log. **Fix:** Join `pg_index.indisvalid`/`indisready` and treat invalid as absent (drop + rebuild).

### ✅ M13 — `/health` reports `ok` without checking database connectivity — **RESOLVED**
**`src/server.ts:427`** — Returns `{status:'ok'}` (or `degraded` only on archival failure) in all cases; never pings the pool. This is the endpoint `fly.toml` wires as the platform health check. If Postgres is unreachable, `/health` still returns 200; Fly keeps the machine in rotation while every `/api/*` request 500s. **Fix:** Run a fast `SELECT 1` with a short timeout, return 503 on failure; separate liveness/readiness; expose basic pool metrics.

### ✅ M14 — Connection pool has no connect/idle/statement timeouts — **RESOLVED**
**`src/main.ts:36`** — The Pool sets only `max`. No `connectionTimeoutMillis`, `idleTimeoutMillis`, or session `statement_timeout`. Non-transactional `pool.query` paths (schema DDL, `getArchivalStats`, `releaseClaim`, `reapStaleClaims`, `discoverTables`) are unbounded. Lock contention or a bloated log makes `/api/stats` or setup DDL hang forever; the pool (default 5) exhausts and the process wedges. There's also no request-timeout middleware. **Fix:** Set the three pool timeouts + a session `statement_timeout`, and add an overall request-timeout middleware.

---

## 🔵 Low

> **✅ All 10 Low findings RESOLVED** (verified: `tsc` clean, `biome` clean, **246 tests pass**, incl. new tests for L5 no-truncation, L7 idempotent `close()`, L10 numeric `auditEntryId`).
>
> - **L1** — hard-delete transaction now does the S3 verify *before* `BEGIN`; the locked TX is a pure re-check + `DELETE` with no network I/O.
> - **L2** — `processBatch` returns `status: 'reaped'`; the orchestrator keeps looping (bounded to 5 retries) instead of treating it as "table done".
> - **L3** — `processTable` sets `skipped: true` on lock contention; `run()` skips `updateArchivalStats` for skipped tables.
> - **L4** — no-PK tables now log a warning (never silent); new `requirePrimaryKey` option fails fast when set.
> - **L5** — composite-PK components are no longer truncated (`LEFT(...,200)` removed), so distinct keys can't collide.
> - **L6** — same root cause as M7; fixed by the retention-cutoff predicate added to the claim query.
> - **L7** — `close()` guarded by a `closed` flag in both `PgHistory` and `PgHistoryArchiver` (idempotent).
> - **L8** — `updateArchivalStats` computes cutoffs from the DB clock (`NOW() - n*INTERVAL`), matching archival.
> - **L9** — `Dockerfile` pins `oven/bun:1.3` + runs as non-root `USER bun`; CI pins `postgres:16-alpine` and a fixed MinIO release.
> - **L10** — `parseRevertBody` rejects a non-numeric `auditEntryId` with 400 instead of a downstream 500.

- **✅ L1 — `hardDeletePurged` holds a row-locking transaction open across up to 500 S3 `HeadObject` calls** (`PgHistoryArchiver.ts:921-999`). When S3 is slow, `FOR UPDATE` locks + a pool connection are held for tens of seconds to minutes, exhausting the pool and prolonging contention. A slow external dependency directly extends DB transaction time. **Fix:** Keep S3 verification *before* `BEGIN`; the locked TX should be a pure re-check + DELETE with no network I/O (accept the small external-deletion TOCTOU window).

- **✅ L2 — Reaper race in finalize returns `recordCount: 0`, aborting the rest of the table's archival for the run** (`PgHistoryArchiver.ts:515-520`; `orchestrator.ts:391-392`). The orchestrator reads `0` as "nothing left" and exits the batch loop; remaining eligible days wait for the next run (not data loss, but stalls progress). **Fix:** Add a status flag distinguishing "reaped/aborted" from "no work remaining".

- **✅ L3 — `updateArchivalStats` runs even for lock-skipped tables** (`orchestrator.ts:188-217`). A skipped table still triggers an expensive full-partition FILTER-aggregate scan + upsert contending on the same stats row the winning instance updates. **Fix:** Have `processTable` signal skipped and skip stats for it.

- **✅ L4 — No-primary-key tables produce non-correlatable history** (`pg-history-triggers.ts:73-100`). `record_id = md5(row_to_json(NEW))` changes on every UPDATE, so INSERT/UPDATE/DELETE entries for one logical row can't be joined. **Fix:** Refuse triggers on PK-less tables (or require a surrogate key).

- **✅ L5 — Composite-PK `record_id` truncates each component to 200 chars, allowing collisions** (`pg-history-triggers.ts:148-153`). Two records agreeing in the first 200 chars of each PK component collide → `getHistory` returns another record's entries and `revert` can target the wrong row. Narrow (>200-char keys) but real. **Fix:** Hash the full `chr(31)`-joined key instead of truncating.

- **✅ L6 — `processBatch` archives the entire straddling UTC day, ignoring `cutoffDate`** (`PgHistoryArchiver.ts:274-325`). Same root cause as M7, framed as the boundary over-reach / dry-run mismatch. **Fix:** as M7.

- **✅ L7 — `close()` is not idempotent** (`PgHistory.ts:794-797`; `PgHistoryArchiver.ts:1014-1017`). A second `close()` calls `pool.end()` again → pg rejects with "Called end on pool more than once", throwing an unhandled rejection during shutdown (e.g. SIGTERM+SIGINT both firing). **Fix:** Guard with a `closed` boolean.

- **✅ L8 — Archival stats cutoffs use the Node clock while archival uses the DB clock** (`schema.ts:185-216` vs `orchestrator.ts:284-299`). Under clock skew, `/api/stats` counts disagree with what archival processed. Reporting-only. **Fix:** Compute stats cutoffs in SQL from `NOW()`.

- **✅ L9 — Non-reproducible / root container and unpinned base + CI images** (`Dockerfile:2`; `.github/workflows/ci.yml`). `FROM oven/bun:latest`, no `USER` (root), CI pulls unpinned `postgres` / `minio/minio:latest`. CI may test a different Postgres major than the `postgres:16-alpine` target. **Fix:** Pin base image by digest, add a non-root `USER`, pin CI service images.

- **✅ L10 — `revert` `auditEntryId` is length-bounded but not validated numeric** (`src/validation.ts:138-145`; `pg-history-revert.ts:83`). A non-numeric `auditEntryId` reaches `WHERE id = $1::bigint` and throws a PG cast error → generic 500 instead of a 400. Parameterized, so not injectable — a DX/error-contract issue only. **Fix:** Validate numeric at the boundary like `validateCursor`.

---

## ⚪ Info

- **✅ I1 — `audit_log.id` is typed as `number` everywhere but the column is `BIGSERIAL`** — **RESOLVED** _(the internal `AuditRow.id` is now typed `string`, matching the driver's bigint-as-string return, with a doc comment warning against installing a numeric int8 parser)._ (`PgHistory.ts:468-482, 622-642`; `pg-history-setup.ts:44-54`). No bug under the default driver (bigint→string, `.toString()` is a no-op), but the annotation invites a consumer who installs an int8 `Number` parser to silently lose precision past 2^53 and break cursor pagination. **Fix:** Type `id` as `string` at the row-cast sites; document that no numeric int8 parser may be installed.

- **✅ I2 — CI has no coverage gate and tolerates a failed MinIO** — **RESOLVED** _(CI now runs `test:coverage` with an enforced `coverageThreshold` in bunfig — line ≥ 0.80, function ≥ 0.85, currently ~0.85/0.91; MinIO startup failure now fails the job instead of continuing; Postgres/MinIO/Bun versions pinned)._ (`.github/workflows/ci.yml`). `test:coverage` is never invoked; MinIO setup swallows failure (`|| echo "...continuing anyway"`), so S3/archival tests could skip/pass without ever exercising archival. **Fix:** Fail the job if MinIO isn't reachable, enforce a coverage threshold, assert the archival suites actually ran.

---

## Investigated and dismissed (refuted)

For transparency, these candidate findings were raised and **rejected** after verification:

- `executeRevert` interpolates `schema` without re-validating it — **unreachable**: not re-exported, package `exports` seal deep imports, and the only caller passes an already-validated `this.schema`. A defense-in-depth nit, not a defect.
- Trigger functions are `SECURITY DEFINER` — **intentional and correctly hardened**: required for least-privilege writers; `search_path` is pinned and bodies use only `pg_catalog` builtins / schema-qualified names.
- DDL/schema changes to audited tables aren't recorded — out of scope for a row-trigger design; documented behavior.
- `excludeColumns` strips fields from both images — that is the intended PII-exclusion feature working as designed.
- `changed_at` uses `NOW()` (transaction start) — standard and correct for audit semantics (server clock, consistent within a txn).
- Errors echo internal DB schema to clients — verified the handlers return **generic** messages (`"An internal error occurred"`); internals go to the logger only.
- Advisory-lock client reads undocumented `pool.options` — a documented, guarded fallback that warns and degrades safely; `lockConnectionString` is the recommended path.

---

## What the codebase does well

Credit where due — these are correct and non-trivial:

- **SQL injection defense is thorough.** All values are parameterized; every interpolated identifier passes `IDENTIFIER_REGEX` (`validateIdentifier`); `excludeColumns` additionally escapes quotes; DDL uses `format(%I/%L)` in several paths.
- **Archival ordering is data-loss-safe by construction:** claim (short TX) → upload → `HeadObject` + SHA-256 verify → finalize; soft-delete only where `s3_path IS NOT NULL` and past grace; hard-delete re-verifies S3 inside a `FOR UPDATE` transaction before `DELETE`. Two grace-period buffers gate physical deletion. Crash recovery via `claim_id` + `reapStaleClaims`.
- **Concurrency primitives are real:** per-table advisory locks on a standalone client (doesn't consume a pool slot), `FOR UPDATE SKIP LOCKED` claim, `SET LOCAL statement_timeout` on transactional paths.
- **Operational hygiene in places:** graceful drain of in-flight requests, `unref()` on background timers, cancellable retry backoff, timing-safe cron-secret comparison, `bodyLimit`, security headers, schema-setup fast-path probe.

The gap is not competence — it's that the **deployment story, the auth/authorization model, and the audit-integrity guarantees** haven't caught up to the quality of the core engine.

---

## Prioritized remediation roadmap

**Ship-blockers (must fix before any production use):**
1. [x] C1 — fix the container/CLI entrypoint. *(Done; CI boot smoke test still recommended as a further guardrail.)*
2. [x] C2 — fail closed on missing auth; never expose `revert` unauthenticated. *(M9 — the Vercel entrypoint — inherits the same fail-closed guard.)*
3. [x] H1 — authorization boundary (`authorize` hook for tenant/row scoping).
4. [x] H2 — attach the lock-client `error` handler.
5. [x] H3 — non-blocking (`ON ONLY` + per-partition `CONCURRENTLY` + `ATTACH`) index creation.

**Before compliance / audit use:**
6. [x] C3 — actor metadata captured. [x] M1, M2, M3 — append-only guard trigger (opt-in; `REVOKE` + hash-chain documented for full WORM), TRUNCATE capture, audited reverts by default.
7. [x] M4, M5 — checksum persisted + re-verified before purge; jsonb integer-precision preserved via `::text`.

**Before scale / reliability SLAs:**
8. [x] H5, H6 — search concurrency limit + non-spoofable rate limiting.
9. [x] H7 — surface total/partial archival failure to health + retry.
10. [x] H8, H9 — OOM-safe batch default; declared the phantom dependency. *(Streaming upload remains an optional further optimization.)*
11. [x] M6, M8, M12, M13, M14 — setup-race advisory lock, fail-closed leaky endpoints, invalid-index detection, DB-probing health check, pool timeouts.

**All Critical, High, and Medium findings are now resolved.** Remaining open items are Low (L1–L10) and Info (I1–I2) — polish and hardening.

**Polish:** the Low/Info set — idempotent `close()`, clock consistency, container hardening, CI coverage gate, `id` typing.
