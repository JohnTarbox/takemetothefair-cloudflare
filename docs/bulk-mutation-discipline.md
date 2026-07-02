# Bulk Mutation Discipline

Playbook for **bulk / batch mutations against D1** — backfills, data-moving
migrations, one-shot rewrites (`rebuild_content_links`, `backfill_event_series`),
and any job that writes many rows in one pass. Distilled from the **EH3 P1 series
backfill (2026-06-22)** (`docs/eh3-p1-backfill-scoping.md`), where a bulk mutation
against a UNIQUE-constrained identity column (`event_series.parent_series_id`)
risked row duplication on a partial-success rerun and aborted downstream steps when
a retry hit an already-written row before its reference was updated.

**Any PR that ships a bulk mutation should cite this doc** so the discipline
compounds instead of being re-derived each time.

The four rules: **single-writer · idempotent · read-back-verified · rollback-planned.**

---

## 1. Single-writer

Run a bulk mutation from **one** writer, not a fan-out.

- Prefer a **single Worker invocation** (a cron handler, a one-shot admin route, or
  a migration) over dispatching the same job across queue consumers. On this stack
  the MCP Worker is the only queue consumer, but a queue with `max_concurrency > 1`
  (or a retried message) can still run the same batch twice — see the
  `indexnow-pings` queue's structural `max_concurrency=1` guard in
  `mcp-server/wrangler.toml` for the pattern.
- If you genuinely need concurrency, **chunk with a lock/lease**: claim a range
  (e.g. `WHERE id > :cursor LIMIT :n` with a claimed-at stamp), process, advance the
  cursor. The `rebuild_content_links` route (`/api/admin/content-links/rebuild`) is
  the reference: cursor-resumable, 50 rows/batch, one writer at a time.
- **D1 bound-parameter cap is 100.** Wide multi-row `INSERT`/`IN (...)` must chunk
  under it: ~90 ids for a single-column `inArray`, and `floor(100 / colsPerRow)`
  rows for multi-column inserts (content-links inserts chunk at **12 rows × 8 cols
  = 96 params**; `resolveContentLinkTargetIds` chunks lookups at **90**). Exceeding
  the cap fails the whole statement, which on a retry becomes a partial-success
  landmine.

## 2. Idempotent

Every step must be **safe to re-run** — a partial-success rerun is the normal case
(deploys retry, workflows resume, an operator re-clicks).

- Use **`INSERT … ON CONFLICT DO NOTHING`** or explicit **upsert** semantics against
  the row identity. Never assume a bulk insert runs exactly once.
- Prefer **check-then-write keyed on a stable identity**, not on order or on "did the
  previous run finish." For year-bucketed / occurrence work, key on the natural
  bucket (see `createOccurrenceForSeries`'s year-bucketed idempotency) so a re-run
  updates in place instead of duplicating.
- Guard **UNIQUE-constrained identity columns** (the EH3 `parent_series_id` shape)
  explicitly: resolve-or-create, don't blind-insert. A blind insert that hits the
  UNIQUE constraint aborts the transaction and can strand the downstream
  reference-update step.
- Target the affected rows with a **precise predicate**, not a gate-flag flipped in
  bulk — prefer the targeted-migration pattern (the `0137` backfill) over a
  broad `UPDATE … WHERE flag = 0`.

## 3. Read-back verified

After writing, **query the mutated rows and assert the intended end-state** before
declaring success. Do not trust the write's return value or the absence of an error.

- Re-`SELECT` the affected set and assert the count and the field values you intended
  (e.g. "N series now have a non-null `parent_series_id`, and each points at a live
  parent"). This is the write-side twin of the analyst-side readback discipline.
- For migrations, add the assertion to the migration/verification step or a canary
  query; for admin jobs, return the post-write counts in the response so a human sees
  them. `rebuild_content_links` returns inserted/updated/orphan counts for exactly
  this reason.
- A silent no-op (0 rows changed when you expected N) is a **failure**, not a pass —
  log/return it loudly rather than swallowing it.

## 4. Rollback-planned

Ship the **undo** in the **same commit/PR** as the do.

- Every bulk mutation lands with a **compensating query** authored alongside it — an
  inverse `UPDATE`/`DELETE` or a documented restore path — so recovery doesn't have
  to be invented under incident pressure.
- For a data-moving migration, either write the down-path or explicitly document why
  it's irreversible and what the manual recovery is. (Hand-authored migrations are
  fine here; `db:generate` was fixed in OPE-21 but the numbering + reconciliation
  rules still apply — new columns must be mirrored in
  `mcp-server/__tests__/setup-db.ts`.)
- Keep the compensating query **runnable from the same access path** as the forward
  one (prod D1 reads via `wrangler --remote` are blocked by the auto-mode classifier;
  use the Cloudflare Developer-Platform MCP `d1_database_query` tool instead).

---

## Pre-ship checklist

Before merging a PR that ships a bulk mutation, confirm:

1. **Single-writer** — one writer, or chunked with a lock/lease; every multi-row
   statement is under the 100 bound-param cap.
2. **Idempotent** — re-running the job produces the same end-state (ON CONFLICT /
   upsert / check-then-write on a stable identity; UNIQUE columns resolved, not
   blind-inserted).
3. **Read-back verified** — a post-write assertion (count + state) that fails loudly
   on a silent no-op.
4. **Rollback-planned** — a compensating query in the same PR (or a documented
   irreversibility + manual recovery).
5. **Cites this doc** in the PR description.

## Source

- EH3 P1 series backfill, 2026-06-22 — `docs/eh3-p1-backfill-scoping.md`
- Pairs with the analyst-side readback discipline (`verify-db-readback-for-subagent-batches`)
  — same principle on the judgment-half surface.
