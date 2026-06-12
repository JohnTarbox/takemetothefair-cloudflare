# C2 — Homepage redesign (design brief)

**Status:** Design proposal for review — 2026-06-12. No code yet.
**Goal:** make the homepage do the directory's core job above the fold — "find an event
near me, soon" — and fix the three-identical-grids problem that erodes information scent.

## Why

The homepage (`src/app/page.tsx`, 559 lines) renders, top to bottom: Hero → This Weekend →
Browse by State → Featured → Upcoming → Blog → CTA → Help. Prior work shipped the hero
shorten (~600px cap), the `getWeekendEvents` query + "This Weekend" section, and
Weekend↔Upcoming ID dedup (`page.tsx:259-266`). Two problems remain:

1. **The first screen doesn't do the job.** The hero is a headline + two buttons (`Browse
Events`, `List Your Event`) + three stat counts — **no search, no actual events above the
   fold.** For a local-events directory the visitor's job-to-be-done is "find something to go
   to near me, soon," and nothing on the first screen serves it.
2. **Three near-identical `EventCard` grids** (This Weekend / Featured / Upcoming) read as the
   same list three times. The email called this a "dedup" task, but the real issue isn't
   duplicate IDs — it's **low information scent**: when modules look the same, users lose
   confidence about where to go. Deduping IDs is necessary but not sufficient.

## Best-practice basis (web research, June 2026)

- **Above the fold must answer what/where/when + one obvious action, no scrolling.** A clear
  primary CTA above the fold lifts conversion double digits.
  ([OneNine](https://onenine.com/website-homepage-design-best-practices/),
  [Bizzabo](https://www.bizzabo.com/blog/beautiful-event-websites-design))
- **Search belongs at the top, prominent; location + date are the core event filters.** Keep
  it light (instant value), show applied filters as chips.
  ([DesignRush](https://www.designrush.com/best-designs/websites/trends/search-ux-best-practices),
  [UXPin](https://www.uxpin.com/studio/blog/filter-ui-and-ux/))
- **Concise + scannable + objective copy = up to 124% measured usability lift.** Strong
  hierarchy; primary zones carry the important content.
  ([NN/g](https://www.nngroup.com/articles/concise-scannable-and-objective-how-to-write-for-the-web/))
- **Redundancy nuance:** a _little_ nav redundancy helps; the damage is **too many similar
  modules eroding information scent.** Differentiate or cut — don't just dedup.
  ([NN/g IA mistakes](https://www.nngroup.com/articles/top-10-ia-mistakes/))
- **Aggregators screenshot your homepage** to represent you — keep the above-fold clean.
  ([Bart Platteeuw](https://bartplatteeuw.com/blog/event-website-best-practices/))

## Proposed redesign

### A. Above the fold — enhanced (location-aware) search + a real events peek

Restructure the hero band (`page.tsx:289-351`) to:

1. **Value headline** (keep, tighten): "Discover Local Fairs & Events across New England."
2. **Enhanced search** as the primary action — a single compact bar:
   - **Keyword** (text) → `/events?query=`
   - **Where**: state select **+ "Near me"** (browser geolocation → `sort=nearest`)
   - **When**: quick chips — _This weekend_ / _This month_ / _Any date_
   - Submit routes to `/events` with the chosen params; applied selections render as chips on
     the results page (existing filter UI).
3. **"This weekend" peek**: a compact horizontal row of 3–4 real weekend `EventCard`s directly
   under the search, so actual content is above the fold (proves density, does the JTBD).
   Shorten the hero band so this row is visible without scrolling on a laptop.
4. Demote the stat-counts (upcoming/venues/vendors) to a thin trust strip — keep, don't headline.

### B. Module system — differentiate, then dedup

The three grids must each carry a **distinct angle** so they don't read as one list ×3:

| Module           | Angle          | Change                                                                                                                                      |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **This weekend** | Time-urgent    | Promote to the above-fold peek + keep the full section.                                                                                     |
| **Featured**     | Editorial pick | Keep, but make visually distinct (larger cards / "Staff picks" framing), not a third identical grid.                                        |
| **Upcoming**     | Generic        | **Replace** with a higher-scent module — _Browse by category_ (chips/tiles) or _Popular this month_ — so it isn't a third date-sorted grid. |

Then **dedup event IDs across all surviving event modules** (extend the existing
Weekend↔Upcoming filter at `page.tsx:259-266`) to close the residual. Decision needed on
whether **Featured** participates in dedup (today it's intentionally exempt — `page.tsx:266` —
on the theory that an editorial pick _should_ be allowed to repeat).

### C. Scannability pass

Tighten section copy to concise/scannable/objective; one clear hierarchy per section; ensure
exactly one above-fold primary action (the search).

## Reuse map (don't rebuild)

- **Keyword / state / category filters** already exist on `/events` (`SearchParams`:
  `query`, `state`, `category`, `sort`, …) — the hero search just composes these URLs.
- **"Near me" / distance** builds on existing infra: `haversineDistance()` /
  `formatDistance()` in `src/lib/geo.ts` and the `sort=nearest` mode already in
  `events-view.tsx`. New piece = wire **browser geolocation** → coords → `sort=nearest`
  for the public (today `nearest` is fed by vendor home coords).
- **Event cards**: `EventCard` (`src/components/events/event-card.tsx`).
- **Weekend data**: `getWeekendEvents()` already in `page.tsx`.

## Build items / gaps

- **Date filter on `/events` is missing** — there is no `when`/`from`/`to` param today. "This
  weekend" / "This month" chips need a small new server-side date filter on `/events` (or the
  chips link to dedicated views). Smallest of the new pieces but it IS new.
- **Public geolocation "Near me"** — new client affordance (permission prompt → coords →
  `sort=nearest`), graceful fallback to state select when denied.
- **Hero search component** — new client component (the rest of the page stays a server
  component).

## Phasing (so value lands incrementally)

1. **P1 — Above-fold search + weekend peek** (keyword + state + "near me"), hero restructure.
   The highest-value, most-visible change.
2. **P2 — Date filter** on `/events` + wire the When chips.
3. **P3 — Module differentiation + dedup** (replace Upcoming, distinguish Featured, extend dedup).
4. **P4 — Scannability/copy pass.**

Rough effort: P1 ~½–1 day, P2 ~½ day, P3 ~½ day, P4 ~¼ day → ~2 days total, matching the
email's 2–3 day estimate but front-loading the visible win.

## Decisions (2026-06-12, signed off)

1. **"Near me" → no radius cutoff.** Sort by nearest, no distance ceiling.
2. **Featured → deduped.** Dedup event IDs across all surviving event grids; precedence
   **This Weekend > Featured > Browse-by-category**; hide any section that empties out. The
   "editorial picks may repeat" exemption (`page.tsx:266`) is dropped — visible duplication in
   near-identical grids is the clearest scent-eroder.
3. **Replace "Upcoming" → Browse by category.** A navigational module (high scent), orthogonal
   to Browse-by-State (what vs where = faceted directory nav), reusing `EVENT_CATEGORIES` +
   the category pages. Chosen over Popular-this-month (depends on a thin `view_count` signal).
4. **Search submit → always navigates to `/events`** with the selected params (incl. a
   weekend-only submit). The above-fold weekend peek is the preview; the search is a tool that
   lands in results — no homepage dead-end.
5. **Mobile → search collapses to a tap-to-expand bar.** Confirmed.

## Verification (when built)

- Lighthouse mobile: LCP element is the hero/first weekend card, CLS ≈ 0, one
  `fetchpriority=high`.
- Above the fold on a 1366×768 laptop shows headline + search + ≥1 real event without scroll.
- Search composes correct `/events?…` URLs for each control; "Near me" degrades to state
  select when geolocation is denied.
- No event appears in two surviving modules (dedup); each module reads as a distinct purpose.
