# EH3 P1 — Series backfill: scoping (data-grounded)

**Status:** scoping (no code) · **Date:** 2026-06-21 · builds on
`docs/eh3-scoping.md` + `docs/MMATF-EventOccurrence-Model-Redesign-2026-06-21.md`.
P0 (the `event_series` table + nullable `events.series_id`) shipped + prod-verified
in PR #535 / drizzle/0127.

P1 = **populate** the schema: create `event_series` rows and set `events.series_id`
on existing events. This is the phase the scoping doc flagged as "all the risk" —
backfill = `findDuplicate` run in reverse, where a _false merge fuses two real
series and corrupts a roster_. The job of this doc is to size that risk against the
**actual prod corpus** and define a conservative, reversible, operator-audited plan.

## The corpus reality (prod D1, 2026-06-21) — and why it de-risks P1

Numbers pulled live, not from the spec's older snapshot:

| Metric                      | Value                    | Implication                                              |
| --------------------------- | ------------------------ | -------------------------------------------------------- |
| Total events                | **1,647** (was ~1,300)   | Corpus grew; plan must scale to it                       |
| `merged_into` tombstones    | 33                       | Excluded from grouping; handled separately (below)       |
| `series_id` already set     | 0                        | P0 is clean; nothing to reconcile                        |
| `-YYYY`-suffixed slugs      | **1,034 (63%)**          | The K34 occurrence pattern — primary grouping signal     |
| Events with NULL venue      | 29                       | Statewide/multi-location; venue-key grouping won't apply |
| Events with vendor links    | **94** / **2,644 links** | Vendor data concentrated (matches spec exactly)          |
| `event_slug_history` rows   | 297                      | Secondary grouping hint + the existing 301 machinery     |
| `recurrence_rule` populated | 6                        | Recurrence is not a reliable grouping signal yet         |

**Grouping by `(slug-stem, venue_id)`** — where slug-stem strips a trailing `-YYYY`:

| Result                                          | Value                                                   |
| ----------------------------------------------- | ------------------------------------------------------- |
| Distinct groups                                 | 1,588                                                   |
| **Multi-occurrence groups (true series today)** | **26** (covering 52 events)                             |
| Singletons (one occurrence so far)              | 1,562                                                   |
| Max group size                                  | **2**                                                   |
| Name-only grouping cross-check                  | 24 (≈ matches → no large hidden cohort from slug drift) |

### The reframe this forces

**P1 is mostly identity-establishment, not duplicate-collapse.** Only **52 events**
actually cluster into multi-year series today; 1,562 are a series' _first/only
occurrence so far_. The site is young — most recurring events haven't recurred in
the data yet. So P1's payoff is **not** "collapse 1,000 duplicates"; it is:

1. Give every event a **stable, year-agnostic series identity** now, so that
2. **P3 discovery match-to-series** attaches _next_ year's occurrence to the existing
   series instead of spawning a fresh disconnected `…-<year>` row (the K34 loop).

Without P1, the 1,034 suffixed slugs keep accreting unlinked siblings every
discovery cycle. P1 draws the line before that compounds.

## Risk, precisely sized

A **fuse** (two real series merged into one) is the only high-stakes failure. It can
only happen inside a multi-occurrence group, and only matters where a vendor roster
is attached. Cross-referencing vendor links against grouping:

- **Only 7 of the 94 vendor-bearing events have a sibling** (are multi-occurrence).
- Of those 7, **3 carry essentially all the weight** (870 of the links):

| Slug                                    | Year | Vendor links | Series stem                      |
| --------------------------------------- | ---- | ------------ | -------------------------------- |
| `newport-international-boat-show-2025`  | 2025 | **383**      | newport-international-boat-show  |
| `new-england-boat-show-2026`            | 2026 | **322**      | new-england-boat-show            |
| `norwalk-boat-show-2025`                | 2025 | **165**      | norwalk-boat-show                |
| `top-o-maine-trade-show-2026`           | 2026 | 4            | top-o-maine-trade-show           |
| `hampton-beach-seafood-festival-2026`   | 2026 | 1            | hampton-beach-seafood-festival   |
| `suburban-boston-spring-home-show-2026` | 2026 | 1            | suburban-boston-spring-home-show |
| `western-new-england-home-show-2026`    | 2026 | 1            | western-new-england-home-show    |

**So the entire manual-confirmation burden the scoping doc warned about ("hand-confirm
the 94 vendor-bearing") collapses to 7 events — really 3.** The other 87 vendor-bearing
events are single-occurrence: each becomes its own brand-new series, where a fuse is
_structurally impossible_ (no sibling to fuse with). This is the single biggest
finding for P1 planning.

## Grouping algorithm (conservative; misses are cheap, fuses are not)

**Primary key: `(slug-stem, venue_id)` exact match.** Slug-stem = slug with a trailing
`-YYYY` removed. Rationale: slugs are already canonicalized by `createSlug()` and
deduped, so an identical stem + identical venue is a near-certain same-series signal.

- **Misses** (a true series split into two singletons because the name was refined
  across years, drifting the slug) are **low-stakes**: the two land as separate 1:1
  series; a later `merge_events`/link-as-occurrences (P3) reunites them. No data lost.
- **Fuses** (two different real events sharing a stem+venue) are what we guard against —
  and stem+venue exact match makes them vanishingly rare. The 7 vendor cases get
  human eyes regardless.

**Secondary pass (vendor set only):** for the 94 vendor-bearing events, also run
`normalizeName()` (the canonical matcher from `src/lib/duplicates/normalize-name.ts`)
to catch a slug-drift miss that would strand a roster on its own island. Surfaces
candidates for review; never auto-fuses a vendor event.

**Same-year stem-mates need triage.** A few groups have two members in the _same_
year (e.g. `fryeburg-fair` ×2 in 2026). Same stem + same venue + same year is usually
a **true duplicate to `merge_events`**, not a multi-year series. P1 flags these for
dup-vs-distinct review rather than blindly co-linking — co-linking a genuine duplicate
into one series hides a dedup that should have collapsed it.

## `canonical_slug` selection

Verified available for every group:

- If the group has a **clean un-suffixed member** (`has_clean_unsuffixed_slug=1`, the
  majority), adopt that slug as `canonical_slug`.
- If **all members are `-YYYY`-suffixed** (8 of the 26, incl. newport/norwalk), the
  **bare stem is free** (no event holds it) → use the stem directly.

Either way `canonical_slug` is collision-free. Brand it `Slug` via `createSlug()` /
`unsafeSlug()` at the boundary (CLAUDE.md #120 convention).

## Series default-metadata seeding

Each new `event_series` row copies defaults from the **richest member** of its group
(prefer the un-suffixed/most-complete row; tiebreak by `completeness_score`): `name`,
`venue_id`, `promoter_id`, `recurrence_rule`, `description`, `image_url`, `categories`,
`tags`, `primary_audience`, `public_access`. Occurrences keep their own per-year values
(P0 already allows override); the series row is just the default home.

## Tombstone handling (33)

- **2 cross-year tombstones** = the documented Newport/Norwalk pair. The keeper (2026)
  and the tombstone (2025) are two occurrences of one series → link **both** to the
  series. (Vendor links already moved back to the 2025 rows per John's §8.4 interim
  remediation — verified: tombstones now carry 0 vendor links.)
- **31 same-year tombstones** = ordinary dedup merges; link each to its keeper's series
  (or leave `series_id` NULL if the keeper is a one-off). They stay tombstones; slug
  redirects already handle their URLs.

## NULL-venue events (29)

Venue-key grouping can't apply. Group by `normalizeName()` alone (with operator
spot-check), or mint a 1:1 series each. Low stakes — none are in the vendor-bearing set.

## The "mint a series for every event?" decision (§8.2)

John's §8.2 locked **"the full ~1,300 events get `series_id` + occurrence rows, not
just the 94."** Read literally that means **every non-tombstone event gets a series**,
including the 1,562 singletons (a 1:1 series, `canonical_slug` = its stem, ready to
accept future occurrences). That is the recommendation here — it makes the model
uniform (every event is an occurrence of _some_ series) and is exactly what makes P3
discovery-match work for events that have only occurred once.

→ **LOCKED: mint-all** (John, 2026-06-21) — ~1,588 series, including 1:1 series for the
1,562 singletons. The schema (P0) supports either policy; this was a backfill-policy
choice, not a schema change (P0's `series_id` is nullable specifically to keep it open).

## Delivery mechanism — dry-run-first, audited, reversible

Mirror the **EH1 backfill precedent** (operator-audited, executed against prod via the
CF MCP D1 tool with `admin_actions` rows), not a blind migration:

1. **Propose (dry-run):** a script/endpoint computes the grouping and writes a
   **proposal** the operator can read — `{stem, canonical_slug, members[], vendor_links,
same_year_flag, source_of_defaults}` — **without writing** `event_series`/`series_id`.
   Gate vendor-bearing groups (the 7) behind an explicit `--confirm` list.
2. **Commit:** insert `event_series` rows + set `series_id` in batched writes, one
   `admin_actions(action='event.series.backfill')` row per series for the audit trail.
3. **Reversible:** because `series_id` is nullable and series rows are new, undo =
   `UPDATE events SET series_id=NULL WHERE series_id IN (…); DELETE FROM event_series
WHERE id IN (…)`. No occurrence data is mutated (no slug/date/vendor changes in P1),
   so rollback is total and clean. Capture the proposal JSON as the undo manifest.

**Suggested shape:** an admin endpoint `POST /api/admin/series/backfill` (`dry_run`
default true) + a thin MCP tool `backfill_event_series` wrapping it over
`X-Internal-Key`, matching how the dedup-sweep / merge tooling is exposed.

## Explicit non-goals for P1 (these are P2/P3)

- **No slug changes, no routing, no 301s, no canonical/SEO, no schema.org.** P1 only
  sets `series_id` + creates `event_series` rows. The `/events/<series-slug>/<year>`
  restructure (Option A) and the 301s are **P2**. Keeping P1 purely data-layer is what
  makes it reversible and shippable independent of the visible surface.
- **No `merge_events` year-guard, no discovery match-to-series, no `create_occurrence`.**
  Those are **P3** tools that _consume_ the series identity P1 establishes.

## Decisions — LOCKED 2026-06-21 (John)

1. **Mint-all** (per §8.2). Create a series for every non-tombstone event, including a
   1:1 series for each of the 1,562 singletons (`canonical_slug` = its stem). Uniform
   model; single-occurrence series are ready for P3 discovery to attach future years.
2. **Same-year stem-mates → flag for `merge_events` review.** Same stem + same venue +
   same year is treated as a likely true duplicate and surfaced for dedup, NOT co-linked
   into one series. Avoids masking a merge that should collapse the two rows.
3. **Delivery = admin endpoint + MCP tool.** `POST /api/admin/series/backfill` (dry-run
   default) + a `backfill_event_series` MCP wrapper over `X-Internal-Key`, matching the
   dedup-sweep / merge tooling pattern. Reusable and auditable.

## Build sketch (once decisions land)

- `src/lib/series/group-events.ts` — pure grouping (stem+venue, normalizeName secondary,
  same-year flagging). Unit-testable like `diversify-by-category` / `featured-rotation`.
- `src/app/api/admin/series/backfill/route.ts` — dry-run proposal + commit, `admin_actions`.
- `mcp-server/src/tools/...` — `backfill_event_series` wrapper.
- Tests: grouping fixtures incl. the 7 vendor cases + same-year + NULL-venue + the
  8 all-suffixed canonical_slug cases.
- Sequencing gate (unchanged from eh3-scoping.md): run after REL4 quiet + I1 auto-merge
  gate opens; ideally before the next discovery cycle re-triggers K34.
