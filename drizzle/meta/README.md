# drizzle/meta — reconciled baseline (OPE-21, 2026-07-01)

This directory holds drizzle-kit's migration journal + schema snapshots. It is used
**only by local tooling** (`npm run db:generate`, `drizzle-kit studio`). The deploy and
CI paths apply migrations with `wrangler d1 migrations apply`, which reads the `*.sql`
files directly and **never** reads this directory.

## Why there is a single snapshot for 139 migrations

The meta chain had drifted badly: the journal was frozen around migration `0022` (17
entries, only 4 snapshots) while hand-authored migrations advanced to `0139` — so
`drizzle-kit generate` diffed the live schema against a stale ~`0012` snapshot and stopped
on an interactive "created or renamed?" prompt for 100+ columns. `db:generate` was
effectively unusable, which is why every recent migration was hand-authored.

OPE-21 reconciled this to a **single baseline** that reflects the current schema:

- `_journal.json` — one entry at `idx: 139`, tag `0139_ope31_producer_no_public_list`
  (the last applied migration at reconciliation time).
- `0139_snapshot.json` — a full, accurate snapshot of the current schema source
  (`packages/db-schema/src/index.ts`), generated fresh by drizzle-kit.

drizzle-kit numbers the next migration as `max(idx)+1`, so the next `db:generate` produces
`0140_*.sql` — no collision with the existing `0000`–`0139` files, and it matches the
repo's hand-numbering convention.

## Result

`npm run db:generate` now runs cleanly ("No schema changes, nothing to migrate") and is
idempotent. When you change `packages/db-schema/src/index.ts`, `db:generate` emits a
correctly-numbered `0140+` migration whose snapshot chains from `0139_snapshot.json`.

Historical per-migration snapshots (`0000`–`0138`) were intentionally **not**
reconstructed — they cannot be derived from the current schema source, the deploy path
does not use them, and `generate` only reads the latest snapshot. If you ever need true
historical snapshots, that is a separate, deliberate effort.
