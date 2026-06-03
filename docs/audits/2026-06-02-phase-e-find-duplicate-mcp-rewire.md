# Phase E audit — `findDuplicate` MCP rewire deferred

**Date:** 2026-06-02
**Source:** Dev-Email-2026-06-02.md (Phase E: rewire `suggest_event` + `update_event` MCP tools through `findDuplicate` instead of their inline overlap-based matcher).
**Outcome:** **Deferred.** The bare rewire would flag ~53% of the APPROVED event corpus as duplicate candidates, dominated by legitimate recurring weekly markets. Per the plan's pre-merge audit policy ("ship only if delta is small + clean; raise the threshold or scope down stages if large or noisy") this exceeds the threshold by an order of magnitude.

---

## Context

[`src/lib/duplicates/find-duplicate.ts`](../../src/lib/duplicates/find-duplicate.ts) was extracted in K2 (PR #282, May 2026) as the unified duplicate-detection matcher. It runs 4 stages in order, first hit wins:

1. **`exact_url`** — `events.source_url` equality (no date guard)
2. **`venue_date`** — same venue, ±7 days
3. **`city_state_date`** — same city+state via venue join, ±7 days
4. **`similar_name_date`** — Levenshtein > 0.85 on normalized name, ±7 days

Today's MCP `suggest_event` ([`mcp-server/src/tools/vendor.ts:760–815`](../../mcp-server/src/tools/vendor.ts)) and `update_event` ([`mcp-server/src/tools/admin.ts:855–912`](../../mcp-server/src/tools/admin.ts)) each inline a different matcher:

```sql
-- existing.start <= newEnd AND coalesce(existing.end, existing.start) >= newStart
WHERE events.venue_id = ?
  AND events.start_date <= newEnd
  AND COALESCE(events.end_date, events.start_date) >= newStart
```

That's a **venue-scoped overlap-of-date-ranges** check. It catches "same venue, dates physically intersect". It does NOT catch same-venue near-misses, cross-venue collisions, or name similarities.

The proposed rewire would replace each inline matcher with a call to the shared route at [`src/app/api/suggest-event/check-duplicate/route.ts`](../../src/app/api/suggest-event/check-duplicate/route.ts), which delegates to `findDuplicate`. This was deferred from PR #285's commit (May 2026) precisely because "Unifying them is a behavior change that needs its own audit + PR." This audit is that prerequisite.

---

## Methodology

All queries were read-only SELECTs against production D1 (`takemetothefair-db`, `d449e416-3814-48a6-b9e8-b676333b2cdc`) via the Cloudflare Developer Platform MCP tool, per [feedback_prod_d1_blocked_via_wrangler](../../) (wrangler --remote is blocked by the auto-mode classifier even for SELECT).

For each `findDuplicate` stage, count **NEW pairs** the rewired matcher would flag that today's overlap-based matcher does not. Pairs are unordered (`a.id < b.id`) and bounded to APPROVED events with non-null `venue_id` and `start_date`. Corpus size: 1,260 events.

Stages 1–3 are pure SQL. Stage 4 uses an exact-name lower bound because SQLite has no native Levenshtein.

---

## Findings

| Variant                                                        | NEW pairs flagged | vs. baseline (21 today) |
| -------------------------------------------------------------- | ----------------- | ----------------------- |
| **Baseline — today's overlap matcher**                         | 21                | —                       |
| Stage 1 — bare `exact_url`                                     | **4,486**         | **213×**                |
| Stage 1 — date-bounded `exact_url` (±7d)                       | 254               | 12×                     |
| Stage 2 — `venue_date` (±7d, NOT overlapping)                  | 253               | 12×                     |
| Stage 2 — `venue_date` minus shared `source_url`               | 68                | 3×                      |
| Stage 3 — `city_state_date` (cross-venue, ±7d)                 | 158               | 7×                      |
| Stage 4 — exact-name ±7d (lower bound for `similar_name_date`) | 2                 | ~0                      |

The plan's threshold of 5% of corpus = 63 pairs. **Every stage except stage 4 exceeds it.**

---

## Root cause: recurring weekly markets

The 10 most-shared `source_url` values in the APPROVED set:

| `source_url`                                    | event count |
| ----------------------------------------------- | ----------- |
| `https://www.brattleboroareafarmersmarket.com/` | 53          |
| `https://www.bangorfarmersmarket.org/`          | 42          |
| `https://www.capitalcityfarmersmarket.com/`     | 38          |
| `https://vtfarmersmarket.org/markets/winter/`   | 26          |
| `https://vtfarmersmarket.org/markets/summer/`   | 26          |
| `https://burlingtonfarmersmarket.org/`          | 26          |
| `https://www.mafa.org/2026fairsbydate.html`     | 23          |
| `https://www.vtnhfairs.org/copy-of-fairs`       | 12          |
| `https://www.vtnhfairs.org/copy-of-fairs-1`     | 11          |
| `https://gnecraftartisanshows.com/calendar`     | 9           |

These are weekly markets where each calendar occurrence is stored as a separate event row sharing one homepage `source_url`. They are NOT duplicates. The `findDuplicate` matcher was not designed to recognize them:

- **Stage 1 (bare):** matches any pair sharing source_url → would flag every new Brattleboro market against the first existing one. **Catastrophic** for the MCP block path.
- **Stage 2:** same venue + ±7d catches weekly intervals → flags Vermont 1st Saturday vs Vermont 2nd Saturday Markets in Rutland; Brattleboro Area Indoor Market vs Brattleboro Mid-Winter Market.
- **Stage 3:** same city+state ±7d catches close-neighbor weekly markets in the same town.

Sample false positives from stage 2 (after the `source_url` exclusion still leaves 68 pairs):

| Event A                                            | Event B                                         | Same venue      | A date     | B date     |
| -------------------------------------------------- | ----------------------------------------------- | --------------- | ---------- | ---------- |
| Vermont Mid-Winter Farmers Market 2026             | Vermont 1st Saturday Farmers Market 2026        | Rutland, VT     | 2026-01-31 | 2026-02-07 |
| Brattleboro Area Winter Indoor Farmers Market 2026 | Brattleboro Area Mid-Winter Farmers Market 2026 | Brattleboro, VT | 2026-02-14 | 2026-02-07 |
| Vermont 2nd Saturday Farmers Market 2026           | Vermont 1st Saturday Farmers Market 2026        | Rutland, VT     | 2026-02-14 | 2026-02-07 |
| Vermont 3rd Saturday Farmers Market 2026           | Vermont 4th Saturday Farmers Market 2026        | Rutland, VT     | 2026-02-21 | 2026-02-28 |

The `Brattleboro Farmers Market 2026` vs `Brattleboro Area Farmers Market 2026` case (different `source_url`, same venue, week apart) shows the false-positive class persists even with the source_url exclusion: same venue + weekly cadence = stage 2 hit regardless.

---

## Why the existing `/api/suggest-event/check-duplicate` route works in production today

The web suggest-event form delegates entirely to `findDuplicate` and would, on paper, hit the same stage 1 flood. It works in practice because **the 53 Brattleboro markets and similar recurring sets were not created via the suggest-event flow** — they were bulk-imported via `/admin/import` or scraped via the calendar harvest pipeline before K2 (May 2026) introduced `findDuplicate`. The web form is also low-volume; a new Brattleboro suggestion via the form would just hit "duplicate found" once and the user would move on.

The MCP path is different in two ways that change the calculus:

1. **`suggest_event` BLOCKS unless `force_create=true`** (vendor.ts:790–815). High-volume MCP agents adding recurring weekly markets would be refused wholesale, not just shown a friendly notice.
2. **`update_event` WARNS via `warnings.possible_duplicates`** (admin.ts:903–911). More tolerable, but a flood of false-positive warnings still degrades the response shape.

---

## What needs to change before re-trying Phase E

Pre-conditions for re-opening this rewire:

1. **`findDuplicate` needs a recurring-event-aware mode.** Concrete options (one or more):
   - **Date-bound stage 1**: require ±7d (or shorter) match in addition to source_url equality. Add an `exactUrlDateWindow` option (default `null` = no bound; MCP path sets `7`).
   - **Recurring-event signal**: detect when both candidate-and-existing share `source_url`, are at the same `venue_id`, AND have stored `recurrenceRule` OR cadence matches (7/14/30 days). Treat as recurring, NOT duplicate.
   - **Cadence detection**: when an existing event row already shares venue + source_url with N other rows at regular intervals, treat new same-venue events at matching cadence as occurrences, not duplicates.

2. **Update the audit thresholds.** With the recurring-event filter in place, re-run all stages and confirm the NEW-pair count drops below 5% of corpus (~63 pairs).

3. **Decide on `suggest_event` block-vs-warn semantics.** Today it blocks unless `force_create=true`. Even with a safe matcher, the rewire likely surfaces enough new matches that the block default becomes annoying for high-volume agents. Consider switching to warn-by-default + `acknowledge_possible_duplicates`, matching `update_event`'s already-warn semantics.

4. **Surface `matchType` in the response.** The plan called for this; it's straightforward once the rewire actually runs.

---

## Re-entry criteria

Phase E re-opens when:

- A recurring-event-aware `findDuplicate` variant (or option) ships AND its corpus-delta audit lands below the 5% threshold, OR
- The Brattleboro / Bangor / Vermont weekly-market rows are restructured so each occurrence has a unique `source_url` (large data migration; not recommended), OR
- A separate `findDuplicateForIngest()` variant is built that uses only stages 3 + 4 (skips the recurring-vulnerable stages 1 + 2) — could ship as a smaller PR but loses the strict-duplicate detection that K2 was designed for.

The recommendation in this audit is option 1.

---

## Files touched (none)

This deferral ships no code change. The audit doc itself is the only artifact, alongside the plan-file update marking Phase E as deferred-pending-recurring-event-support.

## Plan file update

[`/home/wa1kli/.claude/plans/c-users-wa1kl-downloads-dev-email-2026-0-compiled-sutton.md`](../../) — Phase E section appended with "Status: deferred 2026-06-02, see docs/audits/2026-06-02-phase-e-find-duplicate-mcp-rewire.md".
