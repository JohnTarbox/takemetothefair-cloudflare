# MMATF Event Occurrence Model — Redesign Spec

**Filed:** 2026-06-21 · **Status:** DRAFT for John's decision · **Author:** Cowork analysis session

## 1. The problem (in one sentence)

A recurring event's vendor roster changes year to year, but the data model has **no concept of an occurrence (a specific year's instance)** — so we cannot record or query "which vendors were at the 2025 show vs. the 2026 show," and every roll-forward or dedup either destroys a year's data or duplicates it.

This became concrete during today's dedup work: merging the Newport (383) and Norwalk (165) exhibitor rosters off their 2025 rows onto the 2026 keeper rows **reattributed 548 exhibitor links from 2025 to 2026** — a false claim that those 2025 exhibitors are exhibiting in 2026.

## 2. What we are currently doing (as studied, 2026-06-21)

**Tables (D1 `takemetothefair-db`):**

- **`events`** — flat, **one row per event**. Lineage columns exist but are essentially unused: `rolled_from_event_id` (**0 rows populated**), `merged_into`, `possible_duplicate_of`. `recurrence_rule` is set on only **6 of ~1,300** rows. There is **no series / occurrence / edition table**.
- **`event_vendors`** — links `vendor_id ↔ event_id` (+ optional `event_day_id`, `participation_type`, `status`, `booth_info`). **2,644 links across just 94 events** (vendor data is concentrated on trade shows / boat shows). The link points at a single `events` row; it has **no year/occurrence attribute** of its own beyond `created_at`.
- **`event_days`** — days _within one occurrence_ (Fri/Sat/Sun of this year). Not a year-level concept.
- **`event_slug_history`** — 301 redirect history (used by merges).

**De-facto "occurrences" today:** the discovery / community-suggestion pipeline creates **year-suffixed rows** (`cheshire-fair-2026`, `newport-international-boat-show-2025`, etc.). Each suffixed row _is_ effectively an occurrence — but they are **disconnected** (no shared identity), **duplicate all metadata** (name, venue, promoter, description, image per year), and collide with clean un-suffixed canonical rows. This is the duplicate pattern filed as **K34**.

**The two failure modes:**

1. **Roll-forward by mutation** (what I did today for the fairs + Lamoille): edit a single canonical row's `start_date`/`end_date` from 2025 → 2026. This **overwrites the prior year's instance** — the 2025 occurrence ceases to exist as a dated record, and any vendors on it now implicitly belong to the new year.
2. **Roll-forward by duplication** (the pipeline / K34): insert a new year-suffixed row. History is _technically_ preserved (two rows), but unlinked, duplicative, and prone to being merged away — which is failure mode 1 again.

Either way, **per-occurrence vendor history is not first-class and is routinely lost.**

## 3. Goal

Make **occurrence** a first-class concept so that:

- Each year's instance of a recurring event is its own record with its own dates, vendor roster, and `event_days`.
- A vendor's participation is recorded against a **specific occurrence**, and we can query both:
  - _per occurrence_ — "who exhibited at the 2025 Newport show?"
  - _per series_ — "every show this vendor has ever done, and in which year."
- A recurring event keeps **one stable identity and URL** (no `…-2026` churn), with a browsable history of past occurrences.
- Dedup and roll-forward stop destroying history.

## 4. Recommended design — Series + Occurrence (two-level)

Introduce a thin parent table and make `events` the occurrence (edition) table.

### 4.1 `event_series` (new, thin — the stable identity)

```
event_series
  id                TEXT PK
  canonical_slug    TEXT UNIQUE     -- the year-agnostic URL: "newport-international-boat-show"
  name              TEXT            -- "Newport International Boat Show"
  venue_id          TEXT FK         -- default venue (occurrence may override)
  promoter_id       TEXT FK
  recurrence_rule   TEXT            -- FREQ=YEARLY etc. (drives "next occurrence" expectations)
  description       TEXT            -- default; occurrence may override
  image_url, categories, tags, primary_audience, public_access, ...  -- series defaults
  created_at, updated_at
```

### 4.2 `events` becomes the OCCURRENCE row

- Add **`series_id TEXT REFERENCES event_series(id)`** (nullable: `NULL` = standalone one-off event).
- Each row = **one dated instance**. Keeps `start_date`/`end_date`, `lifecycle_status`, `event_days`, and may override series defaults (its own image/description for that year).
- Repurpose the dormant **`rolled_from_event_id`** as the occurrence-to-occurrence lineage breadcrumb ("2026 occurrence rolled from 2025 occurrence") — it already exists and is unused.

### 4.3 `event_vendors` — unchanged mechanically, correct by construction

- Still `vendor_id ↔ event_id`, but `event_id` now reliably means **a specific occurrence (year)**. Per-year history falls out automatically: the 2025 roster lives on the 2025 occurrence row, the 2026 roster on the 2026 row.
- Vendor-history queries:
  - **Per occurrence:** `WHERE event_id = <occurrence_id>`.
  - **Per series (vendor's full history):** `event_vendors → events → events.series_id`, grouped by occurrence year. This powers a "Shows we've done" timeline on the vendor profile.

### 4.4 URLs / SEO

- `/events/<series-slug>` → **series landing page**: the next/current occurrence as the hero, plus a "Past years" section listing prior occurrences (each with its own roster). Year-agnostic, accrues SEO permanently.
- A specific year is addressable (e.g. `/events/<series-slug>/2025` or `?occurrence=2025`).
- Existing per-year slugs (`…-2026`) 301-redirect into the series or its occurrence — reuse `event_slug_history`.

### 4.5 schema.org alignment

Series → `EventSeries`; occurrences → `Event` with `superEvent` pointing at the series. This is _more_ standards-correct than today and improves structured data / rich results.

## 5. Behavior changes this forces (and a bonus)

- **Roll-forward = create a new occurrence** under the series; **never mutate a past occurrence's dates.** The past occurrence simply flips to `OCCURRED` and keeps its roster.
- **`merge_events` becomes occurrence-scoped:** only merges true duplicates _of the same occurrence_. Add a guard that **refuses to merge two events whose date-years differ** and instead offers "link these as two occurrences of one series."
- **Discovery / ingest (K34):** match an incoming event to an existing **series** (normalized name + venue) and create/refresh the right **occurrence**, instead of spawning a disconnected `…-<year>` row.
- **Bonus — this dissolves K33.** The "OCCURRED can't go back to SCHEDULED" problem only exists because we mutate one row across years. With occurrences, a past year stays `OCCURRED` forever (correct) and the next year is a _different_ row that is `SCHEDULED`. No lifecycle reset ever needed.

## 6. Migration plan (additive, phased — low risk)

1. **Schema:** add `event_series` + `events.series_id` (nullable). No behavior change yet.
2. **Backfill series:** group existing `events` by normalized(`name`) + `venue_id` (using `event_slug_history` and the `…-<year>` suffix as hints). Create one series per group; set `series_id` on members; choose `canonical_slug` (prefer the clean un-suffixed slug). Year-suffixed siblings become occurrences of one series. True one-offs keep `series_id = NULL`.
3. **Routing/UI:** series landing page + past-occurrence history + per-year vendor rosters; add a "shows by year" timeline to the vendor profile.
4. **Tools:** `roll_forward` / `create_occurrence` (new occurrence, never mutate); `merge_events` year guard; discovery match-to-series; `get_vendor_events` returns occurrences tagged by year.
5. **Backfill cleanup:** reconcile rows that were previously mutated/merged (see §7).

## 7. Remediation of today's damage (do this regardless of redesign timing)

Today's dedup collapsed ~16 stale-2025 / fresh-2026 pairs into single rows. Two of them carried vendor rosters:

- **Newport (383) and Norwalk (165):** the 2025 occurrences still exist as **tombstoned rows** (`status=REJECTED`, `merged_into` the 2026 keeper, **2025 dates intact**, vendor count now 0). **Fully reversible:** move the 548 `event_vendors` links back to the 2025 rows (and restore those rows as the 2025 occurrence). The 2026 occurrence then correctly has **no roster yet** (2026 exhibitors aren't known).
- **The 12 vendor-less fairs + Lamoille:** the 2025 occurrence was tombstoned and the canonical mutated to 2026. **No vendor data was lost** (those rosters were empty), but the 2025 instance is gone as a record. Under the new model these would be re-expressed as occurrences; low stakes since there were no vendors.

**Interim fix available now (independent of the full build):** move the 548 Newport/Norwalk vendor links back to their 2025 rows so the live 2026 boat-show pages stop falsely listing 2025 exhibitors. Recommended to do promptly — it's currently wrong on the public site.

## 8. Decisions for John

1. **Series table (recommended) vs. lighter single-table `series_id`-only grouping?** Recommend the thin `event_series` table — dedups metadata, gives a clean canonical URL, schema.org-aligned.
2. **Preserve pre-redesign past occurrences for vendor-less events**, or only model occurrences forward from now? (Vendor-bearing events must be preserved either way.)
3. **Occurrence URL scheme** — `/events/<series>/<year>` vs `?occurrence=<year>`.
4. **Approve the interim Newport/Norwalk vendor remediation now?** (Reverses a live data error; ~10 minutes.)

## 9. Relationship to existing backlog

- **K34** (dedup-on-ingest) — should be _implemented as_ "match to series + create/refresh occurrence," i.e. folded into this redesign rather than done standalone.
- **K33** (OCCURRED can't reset) — **obviated** by this redesign (past occurrences stay OCCURRED legitimately).
- **U11** (past events in recommendation modules) — still a display-layer date-filter fix; orthogonal, ship independently.
- **`merge_events`** — gains the year guard described in §5.
