# What `lifecycle_status = 'TENTATIVE'` means

**OPE-611, 2026-08-28.** Written because the field was doing two incompatible
jobs and the choice between them was being made per-session, by whoever
happened to look.

## The incident that forced the question

The Aug 28–30 weekend digest went out with **zero New Hampshire events** on the
biggest fair weekend of the year. This was not a discovery failure. The Capital
Mineral Club Gem, Mineral & Jewelry Show (Concord NH, 1,486 views) was in the
database and correct in _every_ field: dates stated twice on the organizer's own
site, an **active `official_website` citation at 0.95 confidence**,
`dates_confirmed = 1`, correct venue and hours, real hero image, `gate_flags`
NULL.

One field suppressed it: `lifecycle_status = 'TENTATIVE'`. Nothing had ever
revisited it, and it was found by hand **one day before it opened**.

## The two jobs, and which one is authoritative

`TENTATIVE` was being used for both of these, and they need opposite handling:

| reading                       | meaning                                                  | correct handling                                                   |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| **A — organizer uncertainty** | the organizer genuinely has not committed to these dates | stay TENTATIVE; the public page should be honest about it          |
| **B — our own ignorance**     | we ingested it and never checked                         | promote as soon as evidence exists; this is a _queue_, not a state |

**Reading B is what the data actually shows.** Every writer of the value sets it
at creation time as a default — see the writer table below — and none of them
has any signal about organizer commitment. So in practice `TENTATIVE` means
_"nobody has confirmed this yet"_, and it is close to redundant with
`dates_confirmed` plus citation state.

The consequence: **`TENTATIVE` is a work queue, and a work queue needs a drain.**

## Every writer of the field

Established by grep, 2026-08-28 (OPE-611 recorded its own claim here as an
inference from the data; this is the read-from-source version):

| value written   | where                                              | automatic?       |
| --------------- | -------------------------------------------------- | ---------------- |
| `TENTATIVE`     | `src/lib/series/create-occurrence-core.ts`         | yes, at creation |
| `TENTATIVE`     | `mcp-server/src/event-rollover.ts`                 | yes, at creation |
| `TENTATIVE`     | `mcp-server/src/tools/vendor.ts`                   | yes, at creation |
| (from input)    | `src/app/api/suggest-event/submit/route.ts`        | at creation      |
| `OCCURRED`      | `mcp-server/src/event-occurred-sweep.ts`           | **yes, cron**    |
| any (validated) | `src/app/api/admin/events/[id]/lifecycle/route.ts` | no — hand        |
| any (validated) | `update_event_lifecycle` MCP tool                  | no — hand        |

Note the shape: **the lifecycle rail is not unused.** `OCCURRED` has a working
automatic sweep. What was missing for `SCHEDULED` was never the writer — it was
a reader and a trigger.

## Why it matters downstream

`TENTATIVE` events **render publicly and are indexable** — they emit
`EventScheduled` with no robots meta. So this is not an indexing problem, it is
a **selection** problem: every consumer that filters `lifecycle_status =
'SCHEDULED'` silently drops them. The weekend digest is one. Any facet or feed
built on the same predicate is another.

An event can therefore be complete, sourced, publicly visible, and absent from
the digest at the same time.

## The promotion rule

Readiness is **three auditable tiers**, not a score. A score cannot be reviewed —
nobody can say why 0.72 was enough. Implemented in
`mcp-server/src/events/tentative-queue.ts` (`readinessTier`).

| tier         | conditions                                                                                       | meaning                                              |
| ------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `ready`      | `dates_confirmed = 1` **AND** ≥1 active `official_website` citation **AND** `gate_flags` IS NULL | organizer-grade provenance, nothing outstanding      |
| `probable`   | ≥1 active `official_website` citation, but one of the other two unmet                            | a human decision, with the evidence already gathered |
| `unverified` | no active `official_website` citation                                                            | someone must source it first                         |

Two conditions that look like decoration and are not:

- **`state = 'active'`** on the citation. A _superseded_ official citation is a
  record that we once believed something, not current evidence.
- **`gate_flags IS NULL`.** Live example: _Kefi Greek Festival 2026_ carries
  `["name_em_dash_subvenue"]` alongside `dates_confirmed = 1` and an official
  citation. Without this clause it is the **highest-scoring row in the entire
  cohort** — the one an auto-promotion rule would take first, and exactly the
  one it must refuse.

## Surfaces

- **Reader** — `get_tentative_promotion_queue` (MCP, admin-only). Ranked tier →
  soonest → most-viewed. Read-only; promotion is a separate deliberate
  `update_event_lifecycle` call.
- **Alert** — folded into the daily `operator-queue-notice` cron as its third
  queue, firing on events **within 14 days** of opening that are `ready` or
  `probable`.

### Why the alert triggers on imminence, not on backlog size

OPE-611 offered both triggers. Only imminence is built.

A backlog-size threshold fires **every day forever** — 51 rows carry organizer
citations today and the number moves slowly, so "51 > 20" is true every morning
until someone drains it by hand. `operator-queue-notice.ts` already states the
rule that violates: a **work queue** whose steady count means "seen, not yet got
to" must not re-nag, because that is what trains an operator to filter the
sender. (An **invariant** is the opposite case and _should_ nag daily — that is
the OPE-510 list-balance canary, and the difference is deliberate.)

Imminence is self-clearing: a row leaves the set by being promoted or by the
event starting. Measured live on 2026-08-28 it selects **4** rows — a list
someone can act on. The full backlog stays available through the reader, for a
deliberate drain rather than a daily push.

## Measured population (2026-08-28, live D1)

| population                                             | count  |
| ------------------------------------------------------ | ------ |
| APPROVED + TENTATIVE, all                              | 339    |
| …upcoming                                              | 164    |
| …upcoming and `dates_confirmed = 1`                    | 112    |
| …upcoming with an active `official_website` citation   | 51     |
| …upcoming matching the full `ready` rule               | **37** |
| …within 14 days and actionable (`ready` or `probable`) | **4**  |

⚠️ The `ready` count is **37, not 51**. The ticket describes the 51-row cohort as
the auto-promotion candidate set; adding `gate_flags IS NULL` and
`dates_confirmed = 1` removes 14 of them. Anyone sizing the §4 proposal should
use 37.

## Auto-promotion (OPE-611 §4) — PROPOSED, NOT SHIPPED

**Status: needs issue-level approval. Nothing in the codebase promotes anything.**

Proposal: promote `ready` rows automatically, on the same cron.

The case for: 37 rows today, every one carrying provenance we already trust for
other purposes. The gem show would have been promoted the day its citation was
written (2026-08-20) instead of being found by hand on the 28th.

The case against, which is why it is gated: promotion changes what appears in
**customer-facing email and on public pages**. A false promotion advertises an
event that may not happen, to real people. The blast radius is asymmetric — a
missed promotion costs one event's traffic for one weekend; a false one costs
trust and is visible.

If approved, ship it with:

1. A dry-run mode logging what it _would_ promote, run for at least one week
   before enabling — the OPE-403 `PHOTO_AUTOWRITE_ENABLED` pattern.
2. A cap per run, so a bad citation batch cannot promote hundreds at once.
3. `admin_actions` rows with a distinct actor, so the promoted cohort stays
   identifiable and reversible (the OPE-433 convention).
4. A heartbeat probe on the promotion writer — it would be a new writer, so
   OPE-246 applies.
