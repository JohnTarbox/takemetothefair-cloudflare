# MCP write-authority invariants (K25)

> **Status:** load-bearing. This table enumerates the guarantees the MCP write
> surface relies on. It is the gate for the **calendar-module v2 write surface**
> (drag-to-edit, click-to-create) per the calendar module's S2-8 dependency: no
> v2 write path may ship that can bypass one of these.
>
> **Executable counterpart:** `mcp-server/__tests__/mcp-write-invariants.test.ts`.
> Invariants 1–5 each have a `describe` block there. If a block goes red, the
> "How it's enforced" cell for that invariant is no longer true — treat it as a
> release blocker, not a flaky test. **Invariant 6 (K40) is a forward/design
> invariant** — the EH3 P1 backfill embodies it, but it has no executable block
> yet (the commit path is flag-gated off in prod); see its section for the
> obligation the executable test must pin once the gate opens.

The MCP server is a second write authority over the same D1 database the main
app owns (see `CLAUDE.md` → "Runtime & Worker Topology"). Because two artifacts
mutate the same rows, the guarantees a single app would get for free (you read
back what you just wrote; a create is idempotent under retry) have to be stated
and tested explicitly. These six are the ones we've been bitten by or that v2
will stress.

---

## Summary

| #   | Invariant                                                                                                                                                                                                                                                                    | How it's enforced                                                                                                                                                                                                                                                                 | Enforcement site                                                                                                                                                                                        | Test            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | **Wrong-echo under concurrency** — a `create_*`/`update_*` tool returns the row it actually wrote, never a "global most-recent" row                                                                                                                                          | Pre-fetch the target by its id (updates) or capture the inserted id at insert time (creates), then echo _that_ object — never a post-write `SELECT … ORDER BY created_at DESC LIMIT 1`                                                                                            | `admin.ts` `update_event_status` (pre-fetch by `event_id`, echo pre-fetched row); `admin.ts` `update_event` (new values built from params); `admin-create-or-link-vendor.ts` (echo captured `vendorId`) | invariant 1     |
| 2   | **Idempotent `event_days` IDs** — repeated `create_event_day` for the same `(event_id, date)` does not fork a duplicate occurrence                                                                                                                                           | Natural-key `(event_id, date)` existence check → idempotent no-op; otherwise a **deterministic** row id keyed on `(event_id, date)` + `ON CONFLICT DO NOTHING` as the race backstop                                                                                               | `admin.ts` `create_event_day`                                                                                                                                                                           | invariant 2     |
| 3   | **Citations on tracked-field event mutations** — when `update_event` changes a tracked field _and_ provenance is supplied, a citation row is written and the prior active one is superseded                                                                                  | Tracked-field allow-list (`CITATION_DENORM_FIELD_MAP`) gates citation inserts; auto-supersede of the prior `active` row for the same `(event, field, year)`                                                                                                                       | `admin-citations.ts` (`DENORM_FIELD_MAP`); `admin.ts` `update_event` citation block                                                                                                                     | invariant 3     |
| 4   | **Date anchor: noon-UTC, never midnight** — every write that anchors a timestamp-typed event date lands at `12:00Z`, not `00:00Z`                                                                                                                                            | `normalizeEventDate()` shifts bare `YYYY-MM-DD` / explicit-midnight inputs to noon UTC                                                                                                                                                                                            | `packages/utils/src/event-dates.ts`; called by `admin.ts` `update_event` and `vendor.ts` `suggest_event`                                                                                                | invariant 4     |
| 5   | **Merge preview before mutation** — `merge_events` (and any future merge tool) can produce a preview without committing                                                                                                                                                      | `preview: true` routes to `/api/admin/duplicates/preview` (relationship counts + warnings) and returns before the committing `/api/admin/duplicates/merge` call                                                                                                                   | `admin-event-lifecycle.ts` `merge_events`                                                                                                                                                               | invariant 5     |
| 6   | **Single-writer / idempotent / read-back-verified bulk mutations** — a bulk mutation over rows with UNIQUE identity columns runs as one coordinated writer, is re-runnable as a skip-if-exists no-op, and is verified by reading rows back rather than trusting write-counts | Commit is double-gated (an explicit `dry_run:false` **and** an env flag); the read set is filtered to still-unlinked rows so a re-run only touches what's left; groups whose series already exists are skipped; a UNIQUE-collision pre-check runs in the dry-run before any write | `app/api/admin/series/backfill/route.ts` `commitBackfill`; `lib/series/commit-selection.ts` `selectCommittableGroups`; `lib/series/group-events.ts` (`canonicalCollisions` pre-check)                   | _pending_ (K40) |

---

## 1 — Wrong-echo under concurrency

**Guarantee.** A write tool's response describes the row it just wrote. It must
not run a "give me the latest row" query after the write, because a concurrent
write from the main app (or another MCP session) can slip in between and shadow
the response — the caller then believes it edited row B when it edited row A.

**Canonical bugs.** The `update_event_status` wrong-echo and the K19
`create_vendor` echo bug. Both echoed a most-recent row rather than the targeted
/ inserted one.

**How it's enforced.**

- **Updates** pre-fetch the target by the id in the request, mutate it, then echo
  the _pre-fetched_ object (`admin.ts` `update_event_status`). `update_event`
  similarly builds its echoed "new values" from the request params, not a
  post-update SELECT.
- **Creates** capture the generated id at insert time and echo _that_
  (`admin-create-or-link-vendor.ts` echoes the captured `vendorId`).

**Test.** Seed a _newer_ decoy row, then target/create a different row; assert
the echo (and the row actually mutated) is the targeted/created one, not the
decoy. A `ORDER BY created_at DESC` regression would surface the decoy.

**v2 obligation.** Calendar drag-to-edit and click-to-create must echo by
captured/looked-up id. Never `SELECT … ORDER BY created_at DESC` to build a
response.

## 2 — Idempotent `event_days` IDs

**Guarantee.** Creating the same occurrence twice yields one row. The calendar
v2 click-to-create surface will double-fire / retry, and the daily-discovery and
recurrence-backfill paths can re-run over an event that already has its days.

**History.** Before K25, `create_event_day` minted an unconditional
`crypto.randomUUID()` with no conflict guard, so every repeat forked a duplicate
occurrence. K25 closed this.

**How it's enforced.** `create_event_day` now:

1. Checks for an existing row on the natural key `(event_id, date)` and returns
   an idempotent no-op (`created: false, already_exists: true`) when found —
   regardless of how the existing row's id was minted. Editing a day is
   `update_event_day`'s job, not a second create.
2. For a genuinely new day, derives the row id **deterministically** from
   `(event_id, date)` and inserts with `ON CONFLICT DO NOTHING`, so two
   concurrent first-time creates collapse to one row at the DB layer instead of
   racing past the existence check.

`event_days.date` is a `text` `YYYY-MM-DD` column (not a timestamp), so invariant
4 does not apply to it — there is no timezone ambiguity in a plain date string.

> **Pre-existing duplicates** (rows created before this guard) are a separate
> one-time cleanup; idempotency here is a forward guarantee.

**Test.** Two `create_event_day` calls with the same `(event_id, date)` (and
_different_ hours) → second is a no-op echoing the first id; exactly one row;
first write's hours preserved. Distinct dates still create distinct rows.

## 3 — Citations on tracked-field event mutations

**Guarantee.** Structural/numeric event fields carry provenance. When
`update_event` changes a **tracked** field and a `citation` is supplied, a
citation row is written and the prior `active` citation for that
`(event, field, year)` bucket is superseded.

**Precise semantics (read before building v2).** The system records provenance
_when it is given_; it does **not** fabricate a citation when none is supplied.
That conditional is the invariant. The tracked-field set is the allow-list
`CITATION_DENORM_FIELD_MAP` (`admin-citations.ts`): the numeric fields
(`estimated_attendance`, fee/ticket cents, `application_deadline`) plus the
structural fields added 2026-05-31 (`start_date`, `end_date`, `venue_id`,
`name`). An update to a field _not_ on the list never writes a citation.

**How it's enforced.** `update_event`'s citation block iterates the requested
fields, skips any not in `CITATION_DENORM_FIELD_MAP`, supersedes the prior
`active` row for the same `(event, field, year)`, then inserts the new `active`
citation (with `supersedesCitationId` set).

**Test.** Two tracked-field updates with citations → exactly one `active`
(newest) + one `superseded`. A tracked-field update with **no** citation → zero
citation rows (pins the conditional).

**v2 obligation.** A v2 write path that edits tracked fields must thread the
`citation` arg through; it must not invent its own citation-less write path that
silently bypasses the allow-list.

## 4 — Date anchor: noon-UTC, never midnight

**Guarantee.** Every write that anchors a _timestamp-typed_ event date stores
`12:00:00Z`. Midnight UTC (`00:00:00Z`) renders as the **previous calendar day**
in US (EDT/EST) zones — the K14/K16 off-by-one family.

**How it's enforced.** `normalizeEventDate()` (`packages/utils/src/event-dates.ts`)
maps a bare `YYYY-MM-DD` (or an explicit-midnight-UTC input) to noon UTC and
returns `null` for unparseable input. It is the single canonical anchor, shared
by both deploy artifacts:

- `admin.ts` `update_event` routes `start_date` / `end_date` through it.
- `vendor.ts` `suggest_event` routes `start_date` / `end_date` through it (K25 —
  previously used raw `new Date(str)`, which is the midnight bug).

> Supersedes the older "date-only fields anchored at midnight UTC" convention
> (datetime architecture note, 2026-05-01). Noon UTC is the current canonical
> anchor.

**Test.** `update_event` and `suggest_event` with a bare `2026-09-15` → stored
`startDate` is the 15th at `12:00Z` (not the 14th, not midnight).

**v2 obligation.** Any v2 write that accepts a date must pass it through
`normalizeEventDate` before storing to a timestamp column.

## 5 — Merge preview before mutation

**Guarantee.** A destructive merge can be previewed without committing.
`merge_events` is irreversible-ish (it tombstones the duplicate, rewrites slugs,
transfers FK children, writes slug-history); an operator/agent must be able to
see the consequences first.

**How it's enforced.** `merge_events` (`admin-event-lifecycle.ts`) takes a
`preview?: boolean`. With `preview: true` it POSTs to
`/api/admin/duplicates/preview` (relationship counts + warnings: different
promoter, different venue, overlapping vendors) and returns **before** any
mutation. The committing call (`preview` omitted/false) POSTs to
`/api/admin/duplicates/merge`. It also refuses `keeper == duplicate` before any
network call.

**Test.** `preview: true` hits `…/preview` and never `…/merge`; the default path
hits `…/merge`; a self-merge is rejected with no fetch at all.

**v2 obligation.** Any future merge/bulk-mutation tool must offer a preview that
makes zero mutations, and the preview path must be provably distinct from the
commit path.

## 6 — Single-writer / idempotent / read-back-verified bulk mutations

**Guarantee.** A bulk mutation over rows that carry a UNIQUE identity column
(the EH3 `event_series` backfill: `event_series.canonical_slug` is UNIQUE) must
be safe to launch and safe to re-launch. Concretely it must be: **single-writer**
(one coordinated pass, not N racing partial writers), **idempotent** (a second
run is a skip-if-exists no-op, not a duplicate-forking second insert), and
**read-back-verified** (success is judged by reading the rows back, not by
trusting the count of statements the driver claims it ran).

**Why this is its own invariant.** Invariants 1–5 each guard a single-row tool
call. A bulk backfill is a different hazard class: it runs against thousands of
rows in chunked `db.batch()` calls (D1 caps a batch), it is the kind of thing an
operator re-runs after a partial failure, and a UNIQUE column means a careless
re-insert doesn't silently duplicate — it **throws** mid-batch and leaves the
mutation half-applied. The lesson (K40, from the EH3 series backfill) is that
the three properties above are what make a half-applied bulk write recoverable.

**How it's enforced** (`app/api/admin/series/backfill/route.ts`):

- **Single-writer.** The commit path is double-gated: `dry_run` defaults `true`
  (you must send `dry_run:false`), and the env flag `EH3_P1_BACKFILL_ENABLED`
  must be `"true"` or the commit returns `423 Locked` and writes nothing. The
  backfill is one server-side pass; there is no concurrent partial-writer mode.
- **Idempotent.** The commit read set is filtered to `events.series_id IS NULL`,
  so a re-run only ever considers rows not yet linked. `selectCommittableGroups`
  (`lib/series/commit-selection.ts`) additionally **skips** any group whose
  `canonical_slug` already exists in `event_series`. A re-run after a partial
  apply therefore resumes exactly where it left off instead of re-inserting.
- **Collision pre-check (read before write).** The dry-run surfaces
  `canonical_collisions` — slug clashes a commit would trip the UNIQUE constraint
  on — so they are resolved **before** the committing pass, not discovered
  mid-batch.
- **Reversible by manifest.** The single `admin_actions(action='event.series.backfill')`
  row's payload IS the undo manifest (created series ids + linked member ids +
  tombstone links); the commit mutates no slugs/dates/vendors, so undo is
  "NULL the members' `series_id` and DELETE the created series rows."

**The gap this invariant names.** The backfill is single-writer and idempotent
today, but it currently judges success by the **manifest it built**, not by a
**read-back** of the committed rows. The read-back-verify half of K40 is the
forward obligation: before reporting success, re-select the affected identity
columns and assert the rows landed (count + key match), so a batch that the
driver reported as applied but that a UNIQUE throw rolled back cannot be reported
as a clean commit.

**Test (pending).** When `EH3_P1_BACKFILL_ENABLED` ships on, the executable
block must pin: (a) a commit followed by an immediate second commit links zero
additional members (idempotent re-run); (b) a pre-seeded conflicting
`canonical_slug` is reported as a `canonical_collision` in the dry-run and is
**skipped** (not thrown) by the commit; (c) the reported `committed_series` /
`linked_members` counts match a fresh read-back `SELECT`, not just the in-memory
manifest.

**v2 obligation.** Any bulk-mutation surface (calendar v2 bulk edits, the EH3
`create_occurrence` rollover absorption, recurrence backfills) must run
single-writer, re-run as a skip-if-exists no-op, and verify by read-back. A bulk
path that trusts driver write-counts over a read-back does not satisfy this
invariant.

---

## What this table is _not_

- It is not the full IDOR/authorization matrix — see `docs/security-idor-matrix.md`.
- It does not claim every MCP write is citation-gated or idempotent; it states
  the **specific** guarantees above and the exact tools that carry them. New
  write tools should either satisfy the relevant invariants or explicitly
  document why they're exempt.
