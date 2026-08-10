# Node.js consumer example

Installs the built `pg-history` tarball into a plain Node.js project and exercises
every published entrypoint, so a broken `bun run build` fails here instead of in a
user's app.

What it checks:

1. ESM `import` of `pg-history` and `pg-history/next`
2. CommonJS `require('pg-history')` (the `exports.require` branch)
3. The `pg-history` CLI bin runs under Node (shebang + `--help`)
4. A live audit-trail round trip: setup, INSERT/UPDATE/DELETE, history query, teardown

## Run

```bash
docker compose up -d          # from the repo root, or set DATABASE_URL
cd examples/node
npm install                   # re-run after `bun run build` to pick up new dist
npm start
```

`DATABASE_URL` defaults to `postgres://postgres:postgres@localhost:5432/postgres`.
The script creates a throwaway database and drops it when it finishes.
