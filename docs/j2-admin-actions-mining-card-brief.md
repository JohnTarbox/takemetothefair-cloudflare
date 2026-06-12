# J2 / C1 — `admin_actions` mining card (design brief)

**Status:** Design locked 2026-06-12 (kickoff). Build = dedicated 2–3 day session.
**Goal:** an `/admin/analytics` card that mines operator activity to produce a **ranked list
of automation candidates with evidence rows** — i.e. where to point engineering next.

## Data audit (prod, ~4,900 `admin_actions` over ~2 months)

| Operator activity                      | Source                                                                | Volume    | Minable today           |
| -------------------------------------- | --------------------------------------------------------------------- | --------- | ----------------------- |
| Vendor linking                         | `event_vendor.create_or_link` + `event_vendor.create`                 | **1,654** | ✅ (3× everything else) |
| Approve / reject                       | `event.status_change` (payload `previous_status`→`new_status`+`slug`) | 438       | ✅                      |
| Lifecycle changes                      | `event.lifecycle_change`                                              | 88        | ✅                      |
| Merges                                 | `event.merge` (17) + `venue.merge` (2)                                | 19        | ✅ (rich payloads)      |
| **Field edits** (name/date/venue/desc) | —                                                                     | **0**     | ❌ **not logged**       |

`admin_actions` schema: `id, action, actor_user_id (null=cron), target_type, target_id,
payload_json, created_at`. Indexed on `(target_type,target_id)` and `created_at`.

**Key gap:** `update_event` / the admin event-edit route do **not** write an action row, so
"which fields the operator corrects" can't be mined from `admin_actions`. Field-level
provenance lives in `event_data_citations` (`field_name`, `source_type`, `created_by`) but
it's low-volume (~200) and reflects source provenance, not operator overrides. → metric A
requires the instrumentation below.

## v1 metrics (locked)

### M-B. Source / promoter reject-rate — "where auto-ingest is weakest"

- **Data:** `event.status_change` rows, joined `target_id → events.id` for
  `source_domain` / `source_name` / `promoter_id`.
- **Compute:** per source, `% TENTATIVE→REJECTED` vs `→APPROVED` (min-N guard, e.g. ≥5).
- **Output:** ranked sources by rejection %, with evidence rows (the rejected slugs).
- **Action it informs:** down-weight / gate / disable bad sources (ties into URL-classification).

### M-C. Vendor-link batch clusters — "biggest batch-UI win"

- **Data:** `event_vendor.create_or_link` + `create` (1,654 rows).
- **Compute:** group by `(actor_user_id, target event, session window ~15 min)`; rank by
  burst size. Large bursts = a batch-add-vendors UI would save the most clicks.
- **Output:** top events/sessions by vendor-links-per-burst, with counts + timestamps.
- **Action it informs:** build a multi-select "add N vendors" admin flow.

### M-A. Field-correction hotspots — "which fields the extractor gets wrong"

- **Data (v1 proxy):** `event_data_citations.field_name` distribution (today: end*date,
  start_date, ticket_price*\*, venue_id lead).
- **Data (first-class, after instrumentation below):** `admin_actions WHERE action='event.update'`
  → `payload_json.fields[]` distribution, joinable to source/promoter like M-B.
- **Output:** ranked fields by correction frequency; once instrumented, split by source.
- **Action it informs:** targeted extractor improvements per field.

**Deferred:** metric D ("time per action type") — no duration field; only a fuzzy
inter-action-gap heuristic. Revisit if a session-timing need emerges.

## Instrumentation (prereq for M-A — ship first, separately)

Write an `admin_actions` row with `action='event.update'` whenever a tracked event field
changes, carrying the changed field-name list. Two write paths:

- **MCP:** `mcp-server/src/tools/admin.ts` `update_event` — it already computes the set of
  touched tracked fields for the `event_data_citations` auto-insert; reuse that exact set.
- **Main app:** `src/app/api/admin/events/[id]/route.ts` — the admin edit PATCH.

Payload shape: `{ "fields": ["start_date","venue_id",...], "source": "mcp"|"admin_ui" }`.
Reuse the existing admin-action insert helper used by `event.merge` / `event.status_change`.
Non-blocking (a logging failure must never fail the edit). Data accrues from ship date, so
**land this ASAP** — every day unlogged is lost M-A signal.

## Card layout (sketch — for the build session)

`/admin/analytics` card "Automation candidates", three ranked tables (M-B, M-C, M-A), each
row expandable to its evidence rows. Server component, edge runtime, same conventions as
`/admin/source-quality`. All three are single-pass GROUP BY queries over indexed columns.

## Open questions for the build session

- Time window for M-C session-bucketing (15 min? per-event regardless of time?).
- Min-N thresholds for M-B (avoid 1-event sources reading as 100% reject).
- Does the card link out to the relevant admin surface per candidate (source-quality page,
  event edit, etc.)?
