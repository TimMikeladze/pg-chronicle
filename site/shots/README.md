# Dashboard screenshots

`site/public/shots/*.png` are real captures of the dashboard in this repo, not
mockups — the landing page hero shows them, the social card crops one, and the
root [`README.md`](../../README.md) embeds them over raw.githubusercontent.com
(so renaming or deleting one breaks the README and the npm page too). Each
screen exists in both themes because the page shows whichever matches the
visitor's, so a light screenshot never lands on a dark page.

| Shot | Screen | Why it is there |
| --- | --- | --- |
| `timeline` | `/history/users/usr_8f2a1c` | The hero default and the card's crop: one row's changes, what each set and unset, who did it, and the revert |
| `explore` | `/search` | Reach — every audited table at once, colour-coded by operation |
| `tables` | `/tables` | What is audited, its last change and its archival backlog |

## Regenerating

Everything is scripted, so the shots can be reproduced rather than restored:

```bash
# 1. A throwaway database, seeded with a history worth photographing.
createdb pg_history_shots
bun run site/shots/seed.ts 'postgres://postgres:postgres@localhost:5432/pg_history_shots'

# 2. The dashboard, pointed at it. Leave this running.
cd dashboard
PG_HISTORY_DATABASE_URL='postgres://postgres:postgres@localhost:5432/pg_history_shots' \
PG_HISTORY_TABLES='users,orders,invoices,api_keys' \
  bun run dev --port 3111

# 3. The captures, straight into site/public/shots/.
bun run site/shots/capture.ts
```

`capture.ts` drives the Chrome already installed on the machine through
puppeteer-core (`CHROME_PATH` overrides it), so nothing downloads a second
browser. It sets the theme before first paint, expands the timeline's collapsed
diffs, runs the Explore search, and hides Next's dev-mode badge — a screenshot
of a collapsed diff or an empty result panel shows the chrome of the product
without showing the product.

Shots are captured at 1400x900 at 2x. That is exactly twice the size the hero
displays them at; capturing wider would shrink the dashboard's own type into
mush on the page.

## The seed is the story

`seed.ts` is not filler. It is one account's history — a signup, a support
correction, an upgrade, a nightly job suspending the account, a human putting it
back — because the shots have to show a trail that reads like something that
really happened. It writes through the library with `pg_history.actor` set in
each transaction, exactly as an application would, then backdates the entries so
the relative times down the page differ.

It drops and recreates its four tables and the audit log on every run, so
re-running is idempotent. Point it at a scratch database, never at anything
real.
