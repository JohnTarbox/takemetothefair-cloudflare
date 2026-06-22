# EH3 P3 — Tools layer: scoping

**Status:** scoping (no code yet) · **Date:** 2026-06-21 · builds on P0/P1/P2.
P3 is the **behavior** phase: the MCP/admin tools that consume the series identity
P1 establishes and P2 renders. Source-of-truth surfaces confirmed by code read
(2026-06-21).

## The shape: `create_occurrence` is the foundation

Three of the five P3 items converge on a single new primitive — **create a dated
occurrence under a series, never mutating a past one**:

- the `merge_events` year-guard offers "link as two occurrences" instead of merging
  → needs `create_occurrence`;
- discovery match-to-series creates the right edition under a matched series
  → needs `create_occurrence`;
- the K27 yearly rollover _is_ "create next year's edition" → should route through
  `create_occurrence` so the edition is series-linked.

So **build `create_occurrence` first**; the rest are thin callers + guards.

## P3.1 — `create_occurrence` (the primitive)

New admin MCP tool + insert path. Mirrors the **K27 rollover** insert
(`mcp-server/src/event-rollover.ts:rolloverEventIfRecurring`, lines 86–254) and the
`create_event_day` tool pattern (`admin.ts`), but keyed on a series:

- **Input:** `series_id`, `year`, optional per-occurrence overrides (`start_date`,
  `end_date`, `venue_id`, `name`, …). Defaults inherit from the `event_series` row.
- **Insert** an `events` row with **`series_id` set**, `status`/`lifecycle_status =
TENTATIVE`, `dates_confirmed = false`, `flagged_for_review = 1`, inheriting
  venue/promoter/recurrence/description/image/categories/tags/audience from the
  series. Optional `rolled_from_event_id` for provenance.
- **Idempotency:** year-bucketed — refuse if an occurrence already exists for
  `(series_id, year)` (reuse the rollover's `events.start_date` year-range check,
  lines 112–134). Returns `{ created: false, reason: "occurrence_exists" }`.
- **Slug:** `resolveUniqueEventSlug` + `createSlug`/`appendSlugSegment` (the
  suggest_event path); the occurrence keeps its own `…-<year>` slug, which P2's
  routing canonicalizes to `/events/<series>/<year>` and P2.6's 301 redirects.
- **Audit:** `admin_actions(action='event.occurrence_created')`.

**Pure, testable core (build first):**

- `inheritSeriesDefaults(series, overrides)` → the occurrence field map (the
  inherit-vs-override decision), unit-tested like the other src/lib/series helpers.
- `occurrenceIdempotencyKey` / the year-bucket predicate.

Reuses: `normalizeEventDate` (K25), `resolveUniqueEventSlug` (WS2a),
`crypto.randomUUID`, the `db.insert(events)` shape from suggest_event.

## P3.2 — `merge_events` year-guard

Guard belongs in the **merge route** (`src/app/api/admin/duplicates/merge/route.ts`),
right after both event snapshots load (~line 38) and before `executeMerge` (~line 58)
— the existing `primaryId !== duplicateId` check (lines 54–56) is the sibling.

- Load both `start_date` years. If **both present and differ**, REFUSE the merge with
  a structured error: "these are different editions (2025 vs 2026); link them as
  occurrences of one series, not a merge." (Same-year or unknown-year → today's
  behavior, merge proceeds.)
- The error payload points the operator to `create_occurrence` / a link path. The
  comparison itself is a tiny **pure function** (`differentEditionYears(a, b)`) — test
  it; the route just calls it.
- The MCP `merge_events` tool surfaces the structured refusal (it already relays the
  route's error JSON). Its **preview** path (`/api/admin/duplicates/preview`) should
  also _warn_ on a year mismatch so it's visible before the operator commits.

**Why safe:** purely additive refusal — it can only _prevent_ a merge that today would
silently fuse two years' rosters (the original 548-link incident class). Needs its own
tests (a behavior change to a shipped tool).

## P3.3 — discovery match-to-series

Per John's locked Q4 policy. Today `suggest_event` (`mcp-server/src/tools/vendor.ts`)
and `/api/suggest-event/submit` run the 4-stage `findDuplicate`
(`src/lib/duplicates/find-duplicate.ts`: exact_url → venue_date → city_state_date →
similar_name_date) and, on a hit, surface `warnings.possible_duplicates`.

P3 extends the **post-match** branch:

- If the matched existing event has a **`series_id`** and the incoming event is a
  _different year_ (a new edition) → route to **`create_occurrence(series_id, year)`**,
  but keep the **existing discovery review gate** (TENTATIVE / `flagged_for_review`),
  never auto-publish.
- If the match is **ambiguous** (stem collision, multiple candidate series, or
  vendor-bearing) → stage as today (standalone candidate, no series link) for operator
  triage.
- If the matched event has `rolled_from_event_id` set, surface that it's an auto-rolled
  edition so the operator can attach to the real series root.

The routing decision (`series-link | occurrence | stage`) is a **pure function** over
the `findDuplicate` result + the incoming year — test it; the tool acts on it.

## P3.4 — `get_vendor_events` by-year

`get_vendor_events` (`mcp-server/src/tools/public.ts:1029–1139`) returns a flat list.
Additive, backwards-compatible:

- Add `events.series_id` to the SELECT.
- Add an optional grouped view: `by_series: { <series_id>: [occurrences…] }` tagged by
  year (reuse the P2.5a `groupVendorShows` pure helper — already shipped + tested).
- Keep the flat `events` array unchanged so existing callers don't break.

## P3.5 — K27 rollover absorption

`rolloverEventIfRecurring` (OCCURRED → next-year TENTATIVE edition) currently does
**not** set `series_id` (it predates EH3) — so today it mints _shadow_ siblings, not
series occurrences. Absorb it:

- Route the rollover's create through **`create_occurrence`** (passing the source's
  `series_id` + `rolled_from_event_id = source.id`), so a rolled edition is **series-
  linked** by construction.
- Collapse the two year-bucketed idempotency checks into one (the rollover's lines
  112–134 vs create_occurrence's).
- Keep the OCCURRED-transition **trigger** (it's the right signal); only the create
  mechanism changes.

**Low risk / good timing:** K27 is **seed-held** (the 18 annual `recurrence_rule`s
aren't seeded yet, per John's hold), so the auto-rollover is near-inert today — P3 can
replace its mechanism before it ever creates a real edition. Once P3.5 ships, the K27
hold can lift.

## Build sequence

| Step     | Scope                                                                      | Depends on                |
| -------- | -------------------------------------------------------------------------- | ------------------------- |
| **P3.1** | `create_occurrence` (+ pure `inheritSeriesDefaults` / idempotency, tested) | —                         |
| **P3.2** | `merge_events` year-guard (pure `differentEditionYears`)                   | P3.1 (for the link offer) |
| **P3.3** | discovery match-to-series (pure routing decision)                          | P3.1                      |
| **P3.4** | `get_vendor_events` by-year (reuses `groupVendorShows`)                    | — (independent)           |
| **P3.5** | K27 rollover → `create_occurrence`; lift the seed hold                     | P3.1                      |

All buildable now (they operate on a `series_id`, valid whenever one exists), but only
_exercised_ after the P1 backfill creates series — same build-ahead posture as P2.
P3.4 is independent and could ship first as a warm-up.

## Open decisions for John

1. **K27 absorption (P3.5):** route the existing auto-rollover trigger through
   `create_occurrence` (recommended — keeps the automation, makes it series-aware), or
   remove auto-rollover entirely in favor of explicit `create_occurrence` calls?
2. **merge year-guard (P3.2):** hard-refuse a cross-year merge (recommended), or
   warn-but-allow with an explicit `force` flag?
3. **`create_occurrence` dates:** when `start_date` is omitted, compute the next date
   from the series `recurrence_rule` (RRULE), or require explicit dates (TENTATIVE
   skeleton, operator fills in)? Recommend **require/skeleton** first; RRULE date-compute
   as a later enhancement.

## Non-goals (P4)

- Reconcile prior mutated/merged rows (spec §7); retire K33/K34 as obviated/subsumed.
