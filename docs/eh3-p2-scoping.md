# EH3 P2 — Visible series landing + occurrence URLs + SEO: scoping

**Status:** scoping (no code yet) · **Date:** 2026-06-21 · builds on P0 (drizzle/0127),
P1 (`docs/eh3-p1-backfill-scoping.md` — grouping/commit shipped, gated).

P2 is the **first visible** phase: a series landing page, per-year occurrence URLs,
canonical/SEO + 301s, and schema.org `EventSeries`/`superEvent`. It implements URL
**Option A** (locked §8.3): `/events/<series-slug>` is the year-agnostic landing;
`/events/<series-slug>/<year>` is the per-year occurrence, **individually indexable /
self-canonical permanently** (no canonical-up after a year ends).

## Hard dependency: P2 visible behavior needs series rows (P1 backfill)

Every visible P2 surface keys off `event_series` rows + `events.series_id`, which the
**gated P1 backfill** populates. Until the backfill runs (operator gate: REL4-quiet +
I1), there are zero series, so P2 must **degrade to exactly today's behavior**:

- `/events/<slug>` with no matching series → render the event detail page, unchanged.
- No 301s fire (nothing in `event_slug_history` points series-ward yet).
- Sitemap emits no series URLs (none exist).

This lets P2 **ship safely before the backfill** — it's inert until series exist — but
the _301 of legacy `…-<year>` slugs_ must wait for backfill (it would 301 to series
pages that don't exist). Split P2 accordingly (below).

## Surface-by-surface plan (grounded in the code)

### 1. Routing — shared `/events/` namespace, `[slug]` resolves series-or-event

`src/app/events/[slug]/page.tsx` (the event detail, `getEvent()` + `generateMetadata()`,
`revalidate = 300`) gains a **series branch**:

```
getEvent(slug):
  1. event_series WHERE canonical_slug = slug  → render SERIES LANDING
  2. else events  WHERE slug = slug            → render EVENT DETAIL (today's path)
  3. else notFound()
```

A series query runs first (cheap, indexed `canonical_slug UNIQUE`). **No route collision:**
a new `src/app/events/[slug]/[year]/page.tsx` coexists fine — the existing static
`src/app/events/[slug]/vendors/page.tsx` still wins over the dynamic `[year]` segment, and
`/events/foo` vs `/events/foo/2025` are different depths. (The "hard collision" worry is
unfounded in App Router.)

- `/events/<series-slug>/<year>` resolves `(series_id, year)` → the occurrence event row →
  renders the occurrence (reuse the event-detail renderer) with a **self-canonical**
  `<link rel="canonical" href="/events/<series-slug>/<year>">` and `superEvent` → series.
- The series landing renders the next/current occurrence as hero + a "Past years" list
  (reuse the K18 `occurrenceDates` aggregation pattern), self-canonical to
  `/events/<series-slug>`.

**Edge guard:** a `canonical_slug` could equal an existing event `slug` (e.g. the clean
member). That's fine — they're the same real thing; the series query winning just means
the landing renders instead of the single occurrence. The clean member's own
`…-<year>`-less slug becoming the series landing is the intended Option-A behavior.

### 2. Middleware 301s (GATED on backfill)

`src/middleware.ts` already walks `event_slug_history` (5-hop chain → 301) for `/events/`.
P2's legacy-slug redirect (`/events/newport-…-2025` → `/events/newport-…/2025`) rides this
existing machinery — **the backfill writes the `event_slug_history` rows** when it renames
occurrence slugs. So:

- **P2a (ship now, inert):** series landing + occurrence rendering + canonicals + schema.org.
  Renders only when a series exists; zero behavior change pre-backfill.
- **P2b (gated):** the backfill's slug-rename + `event_slug_history` writes (an extension of
  the P1 commit) + the middleware path that 301s `…-<year>` → `/<series>/<year>`. Ships with
  / after the gated backfill, because it presumes series + history rows exist.

Add the series landing slugs to middleware's `EVENT_STATIC_SUBROUTES`-style allowances only
if needed (series slugs are real `[slug]` values, so the existing event-status check must
also consult `event_series` to avoid 404-ing a valid series slug — small middleware edit).

### 3. schema.org — `EventSeries` + `superEvent` (pure, buildable now)

`src/components/seo/EventSchema.tsx` emits `Event`/`Festival`/… with a `subEvent[]` from
`eventDays`. P2 adds:

- **Series landing:** a new `EventSeriesSchema` component → `{"@type":"EventSeries", subEvent:[…occurrences…]}`.
- **Occurrence page:** the existing `EventSchema` gains an optional `superEvent` →
  `{"@type":"EventSeries","@id|url": "/events/<series-slug>"}`.

The JSON-LD shaping is **pure and unit-testable now** (no series rows needed) — the first
safe build brick, mirroring how P1 led with pure modules. Put builders in
`src/lib/series/series-schema-org.ts` + tests; the components are thin wrappers.

### 4. Sitemap

`src/app/sitemap-events.xml/route.ts` (`buildEventUrls()`, `SITEMAP_MIN_COMPLETENESS` gate,
`priority` 0.7 upcoming / 0.5 past). P2:

- Add series landing URLs + occurrence-year URLs.
- Bias `<priority>` current/future **0.8** vs past **0.4** (locked §8.3).
- Apply the same completeness gate (series completeness = max over occurrences, or the
  next/current occurrence's score — decide in build).
- Inert pre-backfill (no series → no extra URLs).

### 5. Vendor "shows by year" timeline

`src/app/vendors/[slug]/page.tsx` (`getVendor()`, already aggregates `occurrenceDates` via
the K18 pattern). P2 groups a vendor's events by **series → year**, rendering a "Shows we've
done" timeline. Reuses `formatDateRange` / `formatOccurrenceDate`. Degrades cleanly: events
with `series_id = NULL` render exactly as today (one row each).

## Build sequence

| Step     | Scope                                                                                                          | Gated?                 | Ship                           |
| -------- | -------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------ |
| **P2.1** | Pure `series-schema-org.ts` builders (`EventSeries` + `superEvent`) + tests                                    | No                     | now                            |
| **P2.2** | Pure series-vs-event slug **resolver** + a `getSeriesLanding()` query helper + tests                           | No                     | now                            |
| **P2.3** | `[slug]` series branch + `[slug]/[year]` route + renderers + canonicals + schema wiring. Inert when no series. | No (inert)             | after P2.1–2                   |
| **P2.4** | Sitemap series/occurrence URLs + priority bias                                                                 | No (inert)             | with P2.3                      |
| **P2.5** | Vendor shows-by-year timeline                                                                                  | No (inert)             | independent                    |
| **P2.6** | Backfill slug-rename + `event_slug_history` writes + middleware `…-<year>` 301 + series-aware status check     | **YES** (needs series) | with/after the gated P1 commit |

P2.1–P2.5 are safe to build and ship ahead of the backfill (inert until series exist).
**P2.6 is the only gated piece** and lands alongside the operator-run backfill.

## Non-goals (P3+)

- `merge_events` year-guard, `create_occurrence`, discovery match-to-series — **P3** (consume
  the identity P2 surfaces).
- Reconcile prior mutated rows — **P4**.

## Open question for the operator

- **Occurrence page rendering:** reuse the event-detail renderer verbatim for
  `/events/<series>/<year>` (fastest, consistent), or a trimmed occurrence view? Recommend
  **reuse** — an occurrence _is_ an event row; the only deltas are the canonical URL and the
  `superEvent` link. Confirm before P2.3.
