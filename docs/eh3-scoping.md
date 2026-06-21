# EH3 — Event Series + Occurrence model: scoping & sequencing

**Status:** scoping (no code) · **Date:** 2026-06-21 · reconciled against
`MMATF-EventOccurrence-Model-Redesign-2026-06-21.md` (the design spec).

This doc is the dev-side read on the spec: what to build, what's risky, how to
phase it, and — the main value-add — **where it has to land in the backlog**.

## Verdict: right model, build it

Series-parent + dated-occurrence (`EventSeries` / `Event` + `superEvent`) is the
standard, standards-correct fix. It kills the cross-year contamination class **by
construction** — the 548-vendor-link boat-show incident is the canonical failure,
and a per-occurrence `event_vendors` makes per-year rosters fall out automatically.
No architectural pushback. All the risk is in **migration sequencing and the
backfill**.

## What the spec's data changes (vs. an abstract read)

The spec quantifies the corpus, and it **de-risks the scary part**:

- **2,644 `event_vendors` links across just 94 events.** Vendor data is
  concentrated on trade/boat shows. The high-stakes backfill failure (a false
  name+venue merge fuses two real series and corrupts a roster) can therefore only
  happen on ~94 events — a **hand-reviewable** set. Auto-group the ~1,200
  vendor-less tail (cosmetic if wrong); **manually confirm the 94 that carry
  rosters**.
- `recurrence_rule` set on only 6 rows; `rolled_from_event_id` 0 populated. So the
  spec's plan to repurpose `rolled_from_event_id` as occurrence lineage is free —
  nothing depends on it today (it's K27's column, see below).
- ~1,300 `events` rows total; de-facto occurrences already exist as disconnected
  `…-<year>` slugs (the K34 duplicate pattern).

## The hard parts (ranked)

1. **Backfill = dedup-in-reverse, but bounded.** Grouping by normalized(name) +
   venue _is_ `findDuplicate`. A false merge fuses two genuine series. Mitigation:
   conservative + reversible + operator-audited, and — per the data above —
   **manual confirmation is only needed on the 94 vendor-bearing events.** Treat it
   like the merge tooling: tombstone + audit row + undo path.
2. **`event_id` semantics flip across ~18 FK sites.** Most code already treats an
   event row as a specific dated thing, so it's largely additive. Audit the places
   that implicitly assume "one event == one real-world series": dedup (→ match to
   series), discovery (→ create/refresh occurrence), recommendations, favorites
   (occurrence vs series — see decisions), canonical/SEO.
3. **Routing collision in `/events/[slug]`.** Series-slug and occurrence-slug share
   one dynamic route. Needs a deliberate slug scheme (year-agnostic series slug vs
   year-suffixed occurrence slug) and a **301 plan for the existing `…-<year>` URLs**
   — those pages carry rankings/backlinks; collapsing them to a series landing risks
   SEO equity unless `event_slug_history` redirects + canonicals are handled. The
   redirect machinery already exists (middleware walks `event_slug_history`).
4. **K27 overlap — EH3 _absorbs_ it.** `rolled_from_event_id` is K27's rollover
   lineage (near-inert, unseeded), and K27's `FREQ=YEARLY` rollover already
   "creates a next-year TENTATIVE edition" = EH3's "roll-forward = create
   occurrence." Running both mints next-year rows twice. EH3 P4-tools should
   **replace** the K27 rollover. **Operator: hold off seeding the 18 K27 rules if
   EH3 is near** — they'd create rows EH3 then has to reconcile.
5. **`merge_events` year guard + "link as occurrences."** Behavior change to a
   shipped tool; needs its own tests + the existing tombstone/slug-history audit
   trail.

## Phasing (matches spec §6; ships additive)

| Phase  | Scope                                                                                                                                                                                | Visible?  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| **P0** | `event_series` table + nullable `events.series_id` FK. No reads.                                                                                                                     | No        |
| **P1** | Backfill: auto-group vendor-less tail; **manual-confirm the 94 vendor-bearing**. Audited + reversible. Seed from known series first (boat shows, the 18 annuals).                    | Mostly no |
| **P2** | Series landing (`/events/<series-slug>` + past-years history + per-year rosters), vendor-profile "shows by year", canonical/SEO + 301s, schema.org `EventSeries`/`superEvent`.       | Yes       |
| **P3** | Tools: `create_occurrence` (never mutate), `merge_events` year guard + link-as-occurrences, discovery match-to-series, `get_vendor_events` tagged by year. **Absorbs K27 rollover.** | Behavior  |
| **P4** | Cleanup / reconcile prior mutated rows (spec §7); retire K33 (obviated) / K34 (subsumed).                                                                                            | —         |

## Sequencing — the key recommendation

The deepest constraint is the **discovery clock**, not internal dependencies. The
K34 pattern re-triggers when next year's events get discovered as fresh rows. So:

- **EH3 P0/P1 + discovery-match are a prerequisite for _scaling ingestion_.** If
  K7 Tier 2/3 (connectors) or K20 (multi-source extraction) ship before
  series-awareness, they industrialize the duplicate creation EH3 exists to stop —
  turning a one-time backfill into perpetual cleanup. **Either land EH3's
  foundation before heavy K7/K20, or build K7/K20 series-aware from day one.**
- **Timing** (agreeing with John's read): after the REL4 quiet window stabilizes +
  the I1 auto-merge gate opens (both gate operator attention, and the backfill
  needs human eyes). Ideally before the next discovery cycle.
- **I2** (promoter/venue enrichment) and the calendar rebuild are orthogonal —
  sequence independently.

## Decisions for John (spec §8) — dev recommendations

1. **Series table vs single-table grouping** → **thin `event_series` table** (spec's
   rec). Dedups metadata, clean canonical URL, schema.org-aligned. Agree.
2. **Preserve vendor-less past occurrences, or model forward only?** → **Model
   forward + preserve vendor-bearing** (mandatory). Vendor-less past occurrences are
   low-stakes; re-expressing them is optional polish, not a blocker.
3. **Occurrence URL scheme** (`/events/<series>/<year>` vs `?occurrence=<year>`) →
   driven by SEO decision: if past-year pages should stay **individually indexable**
   (with `superEvent` → series), use the **path segment**; if they should canonical-up
   to the series landing, a query param is fine. Recommend path segment + decide
   per-year `index` vs `canonical` deliberately (this is the SEO-equity lever).
4. **Approve interim Newport/Norwalk remediation** → **already done** (548 links
   moved back to the 2025 rows; verified in D1 per the 2026-06-21 Polish email).
   Decision resolved.

## Cross-refs

- **K34** — implement _as_ match-to-series; folded into EH3, not standalone.
- **K33** — obviated (past occurrences stay `OCCURRED`; next year is a different
  `SCHEDULED` row).
- **K27** — EH3 absorbs the `FREQ=YEARLY` rollover; reuses `rolled_from_event_id`.
- **U11** — orthogonal display fix; already shipped (#521).
- **`merge_events`** — gains the year guard.
- Spec: `MMATF-EventOccurrence-Model-Redesign-2026-06-21.md`.
