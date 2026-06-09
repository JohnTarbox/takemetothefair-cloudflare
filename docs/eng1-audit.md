# ENG1 — Engagement instrumentation audit (Step 0)

**Filed:** 2026-06-09 per Dev-Email-2026-06-09 §B and the inlined
`MMATF-Engagement-Instrumentation-Spec-2026-06-09.md` headline ask.
**Owner:** Dev (this doc) + John (GA4 Admin actions noted inline).

## Why this exists

The 2026-06-09 dev email proposed expanding intent/activation tracking
because (per GA4 90d data on property 521710889) we instrument
**browsing** thoroughly but **intent + activation barely at all** — and
for an off-platform-transaction directory like MMATF, intent +
activation **is** the conversion. Before writing more code, we audit
what's actually firing today, because three of the spec's "zero events"
findings (favorite, add_to_calendar, sign_up) looked like wiring gaps
but were really _naming / registration_ gaps.

This doc is the "what-fires-where" table that comes out of that audit.
The companion runbook `eng1-ga4-custom-dimensions.md` is the operator
side: which GA4 custom dimensions need to exist before the ENG1.High
code PR merges.

## Audit-first lesson (applied)

Per [[feedback_check_existing_work_before_scoping_spike]]: before
designing the spike, grep for the existing pattern. The two channels
already in place:

- **GA4** via `trackEvent(action, params)` — canonical wrapper at
  `src/lib/analytics.ts:12-28`. Calls `window.gtag('event', action, ...)`.
- **First-party D1 beacon** via `sendBeacon(name, category, properties)`
  at `src/lib/analytics.ts:123-142`. POSTs to `/api/analytics/track`
  (allowlist at `src/app/api/analytics/track/route.ts:16-26`). Uses
  `navigator.sendBeacon` with fetch-keepalive fallback. The allowlist
  is enforced server-side; new beacon events MUST be added there or
  they silently 400 in DevTools.

ENG1 reuses both. No new infrastructure.

## Section A — What fires today vs. what doesn't

| event_name                           | GA4                              | beacon (D1)                        | code site                                                                                             | gap                                                                                                                                                                                 | recommended action                                                                                 |
| ------------------------------------ | -------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `view_event_detail`                  | ✓                                | —                                  | `src/lib/analytics.ts:34`                                                                             | none                                                                                                                                                                                | keep                                                                                               |
| `view_vendor_detail`                 | ✓                                | —                                  | `src/lib/analytics.ts:43`                                                                             | none                                                                                                                                                                                | keep                                                                                               |
| `view_venue_detail`                  | ✓                                | —                                  | `src/lib/analytics.ts:52`                                                                             | none                                                                                                                                                                                | keep                                                                                               |
| `add_to_calendar`                    | ✓                                | —                                  | `src/components/events/AddToCalendar.tsx:165`                                                         | low GA4 count = (a) `event_slug` / `calendar_type` not registered as custom dimensions; (b) `AddToCalendar.tsx:162` passes title-derived `slugFromTitle`, not the real `event.slug` | (a) register dims (this doc); (b) thread real `slug` prop in ENG1.High                             |
| `sign_up`                            | ✓ (3 paths)                      | —                                  | `src/app/(auth)/register/page.tsx:239,423,453`                                                        | wiring is correct (credentials post-success, OAuth pre-redirect). Low count = real low conversions, not under-wiring                                                                | register `method` custom dim, no code change                                                       |
| `favorite_toggle`                    | ✓                                | —                                  | `src/components/FavoriteButton.tsx:70`                                                                | GA4 reports "0" under the name `favorite` / `add_to_favorites` — spec queried wrong name. Code emits `favorite_toggle`.                                                             | dual-emit `add_to_favorites` / `remove_from_favorites` in ENG1.1, 30-day overlap, then drop legacy |
| `outbound_application_click`         | ✓                                | ✓                                  | `src/lib/analytics.ts:146`                                                                            | none                                                                                                                                                                                | keep                                                                                               |
| `outbound_ticket_click`              | ✓                                | ✓                                  | `src/lib/analytics.ts:159`                                                                            | none                                                                                                                                                                                | keep                                                                                               |
| `event_suggest`                      | ✓                                | —                                  | `src/app/suggest-event/page.tsx:480`, `src/app/vendor/suggest-event/page.tsx:359`                     | works, but spec wants per-form segmentation                                                                                                                                         | dual-emit `suggest_event_public_submit` / `_vendor_submit` in ENG1.3                               |
| `vendor_apply`                       | ✓                                | —                                  | `src/components/events/VendorApplyButton.tsx:88`                                                      | works, but spec wants segmented `*_submit` shape                                                                                                                                    | dual-emit `vendor_application_submit` in ENG1.3                                                    |
| `blog_outbound_click`                | ✓                                | ✓                                  | `src/lib/analytics.ts:228`                                                                            | none (BC2)                                                                                                                                                                          | keep                                                                                               |
| `filter_applied`                     | ✓                                | ✓                                  | `src/lib/analytics.ts:248`                                                                            | none                                                                                                                                                                                | keep                                                                                               |
| `view_search_results`                | ✓                                | ✓ (as `internal_search_performed`) | `src/lib/analytics.ts:79`                                                                             | none                                                                                                                                                                                | keep                                                                                               |
| `zero_results_search`                | ✓                                | —                                  | `src/lib/analytics.ts:70`                                                                             | none                                                                                                                                                                                | keep                                                                                               |
| `scroll_depth`                       | ✓                                | —                                  | `src/lib/analytics.ts:96`                                                                             | high-volume, low-value — candidate for capping by page                                                                                                                              | M-tier, defer                                                                                      |
| `api_error`                          | ✓                                | —                                  | `src/lib/analytics.ts:106`                                                                            | none                                                                                                                                                                                | keep                                                                                               |
| `search`                             | ✓                                | —                                  | `src/components/layout/global-search.tsx:126,257`                                                     | undocumented in BC2 runbook                                                                                                                                                         | document, no code change                                                                           |
| **`share`**                          | —                                | —                                  | `src/components/ShareButtons.tsx` (5 share targets, all zero tracking)                                | **not-fired**                                                                                                                                                                       | wire `trackShare()` per share method in ENG1.2                                                     |
| **`login`**                          | —                                | —                                  | `src/app/(auth)/login/page.tsx` (3 sign-in paths, zero tracking)                                      | **not-fired**                                                                                                                                                                       | wire `trackLogin(method)` in ENG1.2                                                                |
| **`form_submit`**                    | (✓ via GA4 enhanced measurement) | —                                  | none in code                                                                                          | generic auto-tracking from GA4 enhanced measurement; no `form_id` segmentation; 175/90d conflates search input with conversion forms                                                | disable enhanced measurement form_interactions + add explicit per-form events in ENG1.3            |
| **`view_item_list` / `select_item`** | —                                | —                                  | none                                                                                                  | not-fired (M-tier per spec)                                                                                                                                                         | DEFER to follow-up                                                                                 |
| **`newsletter_signup`**              | —                                | —                                  | `src/components/layout/newsletter-signup.tsx:10-23` POSTs to `/api/newsletter/subscribe`, no tracking | not-fired                                                                                                                                                                           | wire `trackFormSubmit("newsletter")` in ENG1.3                                                     |
| **`vendor_claim_submit`**            | —                                | —                                  | `src/components/vendors/DirectClaimButton.tsx:28-51`                                                  | not-fired                                                                                                                                                                           | wire `trackFormSubmit("vendor_claim")` in ENG1.3                                                   |
| **`print_sheet`**                    | —                                | —                                  | `src/components/print/PrintButton.tsx` (PR #411 print sheet)                                          | not-fired                                                                                                                                                                           | wire `trackPrintSheet()` on `window.beforeprint` in PRINT2 (folded into ENG1.High)                 |

**Total event count post-ENG1.High** (within the ≤25 ceiling per spec):
the 17 existing events stay; ENG1.High adds **8 new names**
(`add_to_favorites` + `remove_from_favorites` + `share` + `login` +
`newsletter_submit` + `vendor_claim_submit` + 3 segmented form-submit
events + `print_sheet`), and the 30-day cutover drops 3 legacy names
(`favorite_toggle`, `event_suggest`, `vendor_apply`). Steady-state
≈ 22 names — under the ceiling.

## Section B — Four high-suspicion case resolutions

The spec called out four "implausibly low" counts. Three resolved via
audit, no code change for the audit conclusion itself. The fourth is
a real wiring gap (slug source bug) folded into ENG1.High.

### 1. `favorite_toggle` = 0 in GA4

**Resolution: spec queried the wrong name.** Code emits
`favorite_toggle` (not `favorite` or `add_to_favorites`). The "0
events" finding is real _for the name queried_; the underlying signal
is captured at the existing name.

Action: ENG1.1 introduces `add_to_favorites` / `remove_from_favorites`
(matching GA4 Recommended Events naming) via dual-emit alongside
`favorite_toggle` for a 30-day chart-continuity window. Follow-up PR
on 2026-07-09 drops the legacy emit.

**Pre-flight verification BEFORE ENG1.1 ships**: the
`AccountEngagementCardView` at `src/app/admin/analytics/page.tsx:712`
reads `snapshot.accountEngagement.breakdown.event_favorites` from the
overview snapshot loader (`src/lib/analytics-overview.ts`). Today
favorites are GA4-only (no `sendBeacon` in `FavoriteButton.tsx:70`),
so the admin KPI must source from somewhere else (likely the
`userFavorites` table directly, not the GA4 event stream). Read the
loader before the cutover to confirm the rename won't shift the
admin KPI's numerator.

### 2. `add_to_calendar` = 6 in 90d

**Resolution: split — registration AND code bug.**

(a) `event_slug` and `calendar_type` aren't registered as GA4 custom
dimensions, so they're invisible in reports. Fix via the
`eng1-ga4-custom-dimensions.md` runbook (this Step 0 PR's companion).

(b) `AddToCalendar.tsx:162` builds `slugFromTitle` from
`title.replace(...)` — that's a derived-from-title slug, NOT the real
`event.slug`. ENG1.High threads `slug` through the component's props
and updates the `trackAddToCalendar(slug, calendarType)` call.

Either fix alone is incomplete; both are in scope for the same audit
window.

### 3. `sign_up` = 7 in 90d

**Resolution: wiring is correct — the count is the count.**

`src/app/(auth)/register/page.tsx` fires `sign_up` on all three sign-up
paths: credentials (line 239, post-success), Google (line 423,
pre-redirect), Facebook (line 453, pre-redirect). The OAuth paths
emit pre-redirect (intent, not confirmed completion) — that's a known
ambiguity but it inflates the count, not deflates it.

The low number is real: actual sign-ups per quarter for a directory
of this size and ad spend are in this range. No code change.

Action: register `method` as a custom dimension so the
credentials/google/facebook split is queryable.

### 4. `form_submit` = 175 in 90d, no params

**Resolution: source is GA4 enhanced measurement, not our code.**

`grep -rn 'form_submit' src/` returns zero hits. The 175 events come
from GA4's enhanced measurement → form interactions toggle, which
auto-fires on every form `submit` event on every page (search bar,
login, suggest-event, etc.) without `form_id` segmentation.

Action: **disable enhanced measurement form_interactions for the
property** (operator step, doc'd in `eng1-ga4-custom-dimensions.md`)
and add explicit per-form events via `trackFormSubmit(audience, ...)`
in ENG1.3. Five audiences: `newsletter`, `suggest_event_public`,
`suggest_event_vendor`, `vendor_application`, `vendor_claim`.

## Section C — Custom dimensions to register

Per BC2's runbook: GA4 doesn't surface event params in reports until
they're registered as **event-scoped custom dimensions**. The 9 new
params from ENG1.High + PRINT2:

| Param             | Used by                                                                 | Suggested GA4 display name |
| ----------------- | ----------------------------------------------------------------------- | -------------------------- |
| `entity_type`     | `share`, `add_to_favorites`, `remove_from_favorites`, `print_sheet`     | Entity type                |
| `entity_id`       | `share`, `add_to_favorites`, `remove_from_favorites`, `print_sheet`     | Entity ID                  |
| `entity_slug`     | `share`, `print_sheet`                                                  | Entity slug                |
| `share_method`    | `share`                                                                 | Share method               |
| `method`          | `login`, `sign_up`                                                      | Auth method                |
| `form_audience`   | the 5 new `*_submit` events                                             | Form audience              |
| `favorite_action` | `add_to_favorites`, `remove_from_favorites`, `favorite_toggle` (legacy) | Favorite action            |
| `calendar_type`   | `add_to_calendar` (re-register; existing but unsurfaced)                | Calendar type              |
| `event_slug`      | `add_to_calendar`, `view_event_detail`, others                          | Event slug                 |

The companion doc `eng1-ga4-custom-dimensions.md` is the operator
runbook for the registration steps.

## Section D — GA4 key events to mark

Per spec: key events drive GA4's conversion rate calculation, which
feeds the existing `ConversionRateCardView` on `/admin/analytics`
(though that card's numerator currently keys off `outbound_ticket_click`
specifically — widening it is a separate brief, NOT in ENG1.High, to
avoid shifting the KPI threshold and the downstream action-queue
logic).

| Event                         | Why key event?                   |
| ----------------------------- | -------------------------------- |
| `outbound_ticket_click`       | Off-platform conversion proxy #1 |
| `outbound_application_click`  | Off-platform conversion proxy #2 |
| `vendor_application_submit`   | Marketplace activation           |
| `vendor_claim_submit`         | Profile activation               |
| `suggest_event_public_submit` | Catalog growth signal            |
| `add_to_calendar`             | Intent → attendance proxy        |
| `add_to_favorites`            | Engagement → retention proxy     |
| `newsletter_submit`           | Audience retention signal        |
| `sign_up`                     | Account creation                 |

Excluded from key-event status (kept for diagnostic visibility, not
counted toward conversion): `share`, `login`, `favorite_toggle` (legacy),
`view_*`, `filter_applied`, `internal_search_performed`,
`scroll_depth`, `api_error`, `blog_outbound_click`.

Marking is GA4 Admin → Events → toggle "Mark as key event" per row.
**Two-pass operator action**: pre-deploy mark the events that already
exist; post-deploy mark the new events once they fire at least once
(GA4 only surfaces the toggle for events it has actually received).

## Cutover schedule

| Date                    | Action                                                                                             | Owner |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ----- |
| **2026-06-09**          | This doc + `eng1-ga4-custom-dimensions.md` merge                                                   | Dev   |
| **2026-06-09 → 11**     | Register 9 custom dimensions + disable enhanced-measurement form_submit + mark existing key events | John  |
| **2026-06-10 (target)** | ENG1.High PR merges with code changes                                                              | Dev   |
| **2026-06-10**          | Mark new key events as they appear in GA4                                                          | John  |
| **2026-07-09**          | Follow-up PR drops legacy `favorite_toggle`, `event_suggest`, `vendor_apply` per dual-emit cutover | Dev   |

## Related

- `src/lib/analytics.ts` — canonical `trackEvent` / `sendBeacon`
  - per-event helper functions. ENG1.High adds `trackFavoriteToggle`,
    `trackShare`, `trackLogin`, `trackFormSubmit`, `trackPrintSheet`.
- `src/app/api/analytics/track/route.ts:16-26` — beacon allowlist;
  add `newsletter_submit`, `vendor_claim_submit`, `print_sheet` in
  ENG1.High.
- `docs/bc2-ga4-custom-dimensions.md` — the pattern this runbook
  mirrors (registered 3 dims for `blog_outbound_click`).
- `docs/eng1-ga4-custom-dimensions.md` — operator side of Step 0.
- `[[feedback_check_existing_work_before_scoping_spike]]` — the lesson
  this audit applied.
- `[[project_ga4_server_reporting]]` — server-side jose JWT + KV cache
  the `get_ga4_event_detail` MCP tool uses.
- Dev-Email-2026-06-09 §B and §C (PRINT2 fold-in).
