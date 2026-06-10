# ENG1 — GA4 custom dimensions setup (operator runbook)

**Filed:** 2026-06-09 alongside Dev-Email-2026-06-09 §B + §C.
**Owner:** John (GA4 Admin).
**Companion:** `docs/eng1-audit.md` — the dev-side audit that names
the gaps this runbook closes.

## Why this exists

PR-ENG1.High ships client-side instrumentation for `share`, `login`,
`add_to_favorites` / `remove_from_favorites`, `newsletter_submit`,
`vendor_claim_submit`, `suggest_event_public_submit`,
`suggest_event_vendor_submit`, `vendor_application_submit`, and
`print_sheet`. Each carries one or more custom event params
(`entity_type`, `share_method`, `method`, etc.).

But: **GA4 does not surface custom event params in standard reports
(or via the GA4 Data API / `get_ga4_event_detail` MCP tool) until they
are registered as custom dimensions** (per BC2's runbook). Without
this Admin step, the event count is captured but the per-method /
per-audience / per-entity breakdown is invisible.

The first-party beacon side is independent of this: every fired event
that's on the allowlist (`src/app/api/analytics/track/route.ts:16-26`)
POSTs to `/api/analytics/track` and writes to D1 immediately. GA4
registration is needed for the GA4-side rollup (Realtime, Engagement
reports, Data API).

## Pre-flight (do this BEFORE merging PR-ENG1.High)

This runbook is intentionally landed in a docs-only PR so the
24-hour custom-dim propagation window opens before code merge.

### A) Disable GA4 enhanced measurement → form interactions

Currently auto-fires a generic `form_submit` event on every form on
every page (175/90d, no `form_id` segmentation — see audit doc §B.4).
ENG1.3 replaces it with explicit per-form events.

1. Open <https://analytics.google.com/> → select the
   `meetmeatthefair.com` property.
2. Admin → **Data Streams** → click the web stream.
3. Click the gear next to **Enhanced measurement**.
4. **Uncheck** "Form interactions".
5. Save.

(Leave other enhanced-measurement toggles alone — page_view, scroll,
outbound clicks, and site search are still useful.)

### B) Register 9 event-scoped custom dimensions

Admin (cog at lower-left) → **Custom Definitions** (under Data Display)
→ **Custom dimensions** tab → **Create custom dimensions**.

Create **nine** custom dimensions, all event-scoped, **Event parameter
names matching the client payload exactly (case-sensitive)**:

| Dimension name (display) | Scope | Event parameter   | Description                                                                                                                                   |
| ------------------------ | ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity type              | Event | `entity_type`     | `EVENT` \| `VENUE` \| `VENDOR` \| `PROMOTER` \| `BLOG` — the entity the action targeted                                                       |
| Entity ID                | Event | `entity_id`       | DB primary key of the targeted entity                                                                                                         |
| Entity slug              | Event | `entity_slug`     | URL slug of the targeted entity                                                                                                               |
| Share method             | Event | `share_method`    | `twitter` \| `facebook` \| `linkedin` \| `email` \| `copy`                                                                                    |
| Auth method              | Event | `method`          | `credentials` \| `google` \| `facebook` — used by `login` and `sign_up`                                                                       |
| Form audience            | Event | `form_audience`   | `newsletter` \| `suggest_event_public` \| `suggest_event_vendor` \| `vendor_application` \| `vendor_claim`                                    |
| Favorite action          | Event | `favorite_action` | `add` \| `remove` — used by `add_to_favorites` / `remove_from_favorites` (and legacy `favorite_toggle` during cutover)                        |
| Calendar type            | Event | `calendar_type`   | `Google Calendar` \| `Outlook Calendar` \| `Download .ics` — used by `add_to_calendar` (re-registering an existing param that was unsurfaced) |
| Event slug               | Event | `event_slug`      | URL slug of the event (used by `add_to_calendar`, `view_event_detail`, etc.)                                                                  |

The dimension display names can be edited later — what matters is the
**Event parameter** column, which must match the param key in the
client payload **exactly** (case-sensitive, no spaces).

### C) Mark existing key events

Admin → **Events** → for each row below that already exists in the
property, click the kebab menu → **Mark as key event**.

Pre-deploy (these exist today):

- `outbound_ticket_click`
- `outbound_application_click`
- `sign_up`
- `add_to_calendar`

(The remaining 5 — `add_to_favorites`, `vendor_application_submit`,
`vendor_claim_submit`, `suggest_event_public_submit`,
`newsletter_submit` — only appear in the GA4 Events table AFTER they
fire at least once, so they'll be marked in pass 2 below.)

## After registration

- Allow **~24 hours** for the custom dimensions to become queryable
  in reports / Data API. New events fired in the meantime ARE
  recorded with the params — they just don't surface in reports
  until ingestion completes.
- Verify in GA4 → **Reports → Engagement → Events** → click any
  affected event name (e.g. `add_to_calendar`) → confirm the
  registered custom dimensions appear in the drill-down list.
- The MCP tool `get_ga4_event_detail` will then return param
  breakdowns once the 24h window elapses (same as BC2's pattern).

## Sanity check (immediate, before the 24h wait)

In **Realtime → Events** within a few minutes of PR-ENG1.High deploy:

1. Open <https://meetmeatthefair.com/> → click any event card to land
   on a detail page.
2. Click the **Share** button → pick **Copy link**.
3. Switch to Realtime → Events. Expect `share` with `event_count: 1`
   and (in the drill-down once the dim propagates) `share_method=copy`.
4. Repeat for **Favorite** (heart icon) → expect `add_to_favorites`.
5. Repeat for **Add to calendar → Google Calendar** → expect
   `add_to_calendar` with `calendar_type=Google Calendar`.
6. Repeat for **Print** (Ctrl+P or print button on event detail) →
   expect `print_sheet` with `entity_type=EVENT`.
7. First-party beacon side: visit
   `/admin/analytics?tab=first-party-events` and confirm
   `newsletter_submit`, `vendor_claim_submit`, and `print_sheet` rows
   appear in D1 within minutes of triggering each (these three are
   the allowlist additions; the others are GA4-only).

If a GA4 event doesn't appear in Realtime, GA4 is not receiving the
beacon at all — check `window.gtag` availability + the
`NEXT_PUBLIC_GA_MEASUREMENT_ID` envvar before troubleshooting custom
dimensions.

## Pass 2 (post-deploy): mark new key events

Once the new events appear in **Admin → Events** (after they fire at
least once in production):

- `add_to_favorites`
- `vendor_application_submit`
- `vendor_claim_submit`
- `suggest_event_public_submit`
- `newsletter_submit`

Click kebab → **Mark as key event** on each row.

(Skip the dual-emit legacy events `favorite_toggle`, `event_suggest`,
`vendor_apply` — they go away on 2026-07-09 per the cutover; don't
mark them as key events or the chart-break will affect conversion
rate twice.)

## Pass 3 (2026-06-10): ENG1.5 / 1.6 / 1.7 additions

Shipped in the ENG1-Med analytics PR (Dev-Email-2026-06-10 §B). Three
new instrumentation clusters; register the two new params and mark the
new key events.

### Register 2 more event-scoped custom dimensions

Admin → Custom Definitions → Custom dimensions → Create:

| Dimension name (display) | Scope | Event parameter  | Description                                                                                                |
| ------------------------ | ----- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Claim method             | Event | `claim_method`   | `register` \| `email` \| `admin_approved` — used by `claim_started` / `claim_submitted` / `claim_approved` |
| Item list name           | Event | `item_list_name` | `events_listing` \| `vendors_browse` \| `vendors_search_results` \| `venues_browse` — browse-CTR list id   |

(`vendor_id` / `vendor_slug` ride on the claim events too; they reuse
the existing entity-style params and don't need separate dimensions
unless you want them broken out.)

### Mark new key events (after they first fire in prod)

- `claim_started`, `claim_submitted`, `claim_approved` (supply-side funnel)
- `select_item` (browse → detail click-through; the conversion half of CTR)
- `newsletter_confirm` (double-opt-in completion)

`view_item_list` is a coverage/denominator event — leave it un-keyed.

### Sanity check

- **Browse CTR**: open `/events` → Realtime shows `view_item_list`
  (`item_list_name=events_listing`); click a card → `select_item`.
  `view_item_list` / `select_item` are **GA4-only** (not in the D1
  first-party beacon by design — high volume).
- **Claim funnel**: trigger a claim (vendor profile or a vendor page
  you're eligible to claim) → Realtime shows `claim_started` →
  `claim_submitted` → `claim_approved`. These three DO mirror to D1 —
  confirm at `/admin/analytics?tab=first-party-events`.
- **Newsletter**: complete a double-opt-in → `/newsletter/confirmed`
  fires `newsletter_confirm` (GA4 + D1 beacon).

Note: `claim_approved` with `claim_method=admin_approved` is NOT wired
yet (the MCP approval tool doesn't emit analytics today) — expect only
`register` / `email` methods in the funnel for now.

## Related

- `docs/eng1-audit.md` — dev-side companion (what fires today vs.
  what doesn't, with file:line refs).
- `docs/bc2-ga4-custom-dimensions.md` — the pattern this runbook
  mirrors; BC2 added 3 dims for `blog_outbound_click` in early June.
- `src/lib/analytics.ts` — canonical `trackEvent` / `sendBeacon`
  helpers + per-event wrappers (`trackShare`, `trackLogin`,
  `trackFavoriteToggle`, `trackFormSubmit`, `trackPrintSheet` added
  in ENG1.High).
- `src/app/api/analytics/track/route.ts:16-26` — beacon allowlist
  (`newsletter_submit`, `vendor_claim_submit`, `print_sheet` added in
  ENG1.High).
- `[[project_ga4_server_reporting]]` — the server-side jose JWT path
  the MCP `get_ga4_event_detail` tool uses.
- Dev-Email-2026-06-09 §B and §C (PRINT2 fold-in).
