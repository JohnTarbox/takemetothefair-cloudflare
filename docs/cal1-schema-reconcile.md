# CAL1 — Step 1: Schema reconcile (`events`/`event_days` → `CalendarEvent`)

**Status:** Step 1 of CAL1 (Dev-Email-2026-06-14-MMATF-Developer-Calendar-Integration). · **Filed:** 2026-06-14
**Verdict:** ✅ **No migration required.** MMATF's current schema already carries every field the module's
`CalendarEvent` contract (ES §5) needs. This doc is the field map the Step-2 adapter (`to-calendar-event.ts`)
is built from, and the artifact to diff against the module dev's reference adapter at the seam-freeze.

> The contract shape here is transcribed from `Calendar-Module-02-Engineering-Spec-Dev-Handoff.md` §5 (the
> ES draft). **Re-confirm against the frozen integration handoff doc when it ships** — if the frozen JSON shape
> differs, only this map and the adapter change. Schema columns cited from `packages/db-schema/src/index.ts`.

## `CalendarEvent` (one per MMATF `events` row)

| Contract field       | Type / rule                                                       | MMATF source                                              | Notes                                                                                    |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `id`                 | string, stable + unique across windows                            | `events.id` (uuid PK)                                     | direct                                                                                   |
| `title`              | string                                                            | `events.name`                                             | direct                                                                                   |
| `category?`          | drives color via theme `categoryColors`                           | `parseJsonArray(events.categories)[0]`                    | categories is a JSON-array text col; take first                                          |
| `url?`               | Zod protocol-allowlist (no `javascript:`/`data:`)                 | `` `/events/${events.slug}` ``                            | same-origin relative path; always safe                                                   |
| `recurrenceSummary?` | display-only, adapter-supplied                                    | derive from `events.recurrenceRule` if present, else omit | engine renders verbatim; never recomputed from occurrences                               |
| `occurrences[]`      | concrete instances, **sorted ascending by start**                 | see span rules below                                      | —                                                                                        |
| `ongoing?`           | omit → engine derives TRUE iff any occurrence span > 14d (strict) | leave derived; do **not** set explicitly                  | a continuous multi-week event (e.g. a 98-day flat range) auto-becomes the "Ongoing" band |

## `Occurrence` — two cases

### Case A — continuous event (`events.discontinuousDates = false`)

One all-day occurrence spanning `startDate … endDate`.

| Contract field         | MMATF source / rule                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `events.id` (single occurrence) — or `` `${events.id}:0` `` for uniformity                                                                                                                                                |
| `start`                | `toIsoDateOnly(events.startDate)` → `"YYYY-MM-DD"` (date-only, floating)                                                                                                                                                  |
| `end`                  | `toIsoDateOnly(events.endDate + 1 day)` — **DTEND is EXCLUSIVE.** Fri–Sun ⇒ `end = Mon`. Omit when `endDate` is null/== `startDate` (single day). **Property-test the off-by-one** (a 3-day fair covers exactly 3 cells). |
| `allDay`               | `true`                                                                                                                                                                                                                    |
| `timezone`             | omitted — all-day occurrences are FLOATING (never shift day under `displayTimeZone`)                                                                                                                                      |
| `location`             | `` `${venue.name}, ${venue.city}` `` (when `venueId` set)                                                                                                                                                                 |
| `mapUrl`               | `venue.googleMapsUrl` (Zod-allowlisted; omit if null)                                                                                                                                                                     |
| `openTime`/`closeTime` | omit for the continuous case (single span, no per-day hours)                                                                                                                                                              |

### Case B — discontinuous event (`events.discontinuousDates = true`)

One single-day all-day occurrence **per `event_days` row** (vendorOnly rows filtered out for the public surface),
sorted ascending by `date`.

| Contract field         | MMATF source / rule                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `` `${events.id}:${event_days.date}` `` — stable + unique per occurrence                                               |
| `start`                | `event_days.date` (already `"YYYY-MM-DD"`)                                                                             |
| `end`                  | omit (single day)                                                                                                      |
| `allDay`               | `true`                                                                                                                 |
| `openTime`/`closeTime` | `event_days.openTime` / `event_days.closeTime` (nullable — DQ4; pass through, may be NULL = "hours not yet confirmed") |
| `location`/`mapUrl`    | from `venue` as in Case A                                                                                              |
| `note`                 | `event_days.notes` (optional)                                                                                          |

> `event_days` dates are already pre-loaded for the calendar branch (`eventDayDates`, `getEvents()` ~373–399),
> and vendorOnly filtering already happens there — the adapter reads them, **no new query**.

## `CalendarConfig` (resolved server-side, per request)

| Config field             | MMATF value                                                          | Notes                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `displayTimeZone`        | `"America/New_York"` (constant; `VENUE_TZ`)                          | REQUIRED; IANA-validated at the **deploy** boundary (`validateConfig`) + render guard. MMATF is single-zone so this is fixed. |
| `defaultDurationMinutes` | n/a — all MMATF Month events are all-day                             | omit (no timed occurrences in Month)                                                                                          |
| `categoryColors`         | from `CALENDAR_EVENT_COLORS` (moved to `src/lib/calendar/colors.ts`) | one palette shared with the legacy client sub-views                                                                           |
| `weekStartsOn`           | `0` (Sunday, US default)                                             |                                                                                                                               |
| `locale`                 | `"en-US"`                                                            |                                                                                                                               |
| `showWeekNumbers`        | `false`                                                              |                                                                                                                               |

## Gaps / decisions

- **None blocking.** Every field resolves from existing columns.
- **`recurrenceSummary`:** MMATF has `events.recurrenceRule` (RRULE text) but no human summary column. v1: omit
  `recurrenceSummary` (the popover falls back gracefully per ES §5), or derive a short string adapter-side later.
  No schema change.
- **All-day floating ↔ midnight-UTC storage:** MMATF stores `startDate`/`endDate` as midnight-UTC anchors;
  mapping them to date-only floating occurrences via `toIsoDateOnly` is exact and zone-safe — matches the
  contract's iCalendar floating rule by construction.
- **Status:** `events.status` / `events.lifecycleStatus` are richer than the engine needs; the engine treats
  unknown statuses as active. Pass `events.lifecycleStatus` (CANCELLED/RESCHEDULED carry display meaning) if the
  frozen contract adds a status field; the ES §5 draft has none, so v1 passes nothing.

## To confirm at the seam-freeze (before Step 2)

- Frozen `CalendarEvent` JSON shape vs this ES-draft transcription.
- The module dev's reference adapter's assumed `events`/`event_days` column names (so ours matches).
- Whether the contract gains a `status` field (CANCELLED/RESCHEDULED display).
