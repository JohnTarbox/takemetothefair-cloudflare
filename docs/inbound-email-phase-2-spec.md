# Updated spec

**From:** John Tarbox <jtarboxme@gmail.com>
**Date:** Tue, May 19, 2026 at 9:04 AM
**To:** John Tarbox <jtarboxme@gmail.com>

**Owner:** John
**Drafted by:** Claude (Cowork session 2026-05-17, refreshed 2026-05-18 after Phase 2A ship, **revised 2026-05-19 after codebase audit + JSON-LD coverage audit**)
**Status:** PARTIAL SHIPPED — Phase 2A (Part A bug fixes + B5 dedup + B6 sender trust) live in production 2026-05-18. Codebase audit 2026-05-19 found A2 venue matcher is more fully shipped than the 2026-05-18 refresh implied, and A4 JSON-LD parsing/plumbing is already live (only the AI-bypass decision branch is missing). JSON-LD coverage audit (n=30 representative organizer URLs) measured Event-schema coverage at **3.3%**, well below the ≥15% threshold the spec set for prioritizing A4 — so A5 (Browser Rendering) moves ahead of A4 in the rollout order.
**Priority:** HIGH (remaining items unlock ~30–40% of currently-failing submission patterns — revised down from 70–80% after audit showed many "failed" rows are dead URLs, not extraction bugs)
**Estimated effort remaining:** ~2.5–3 developer days (was 3–4 total; ~1 day shipped + 2 new high-leverage items added)
**Related:** `inbound-email.md` (current architecture), `Dev-Email-2026-05-18-Bug-Fix-Recap.md` (the email that drove the Phase 2A ship), `MMATF-Spec-Event-Date-Quality-Gates.md` (overlapping timezone normalization)

## TL;DR

The inbound email pipeline went live 2026-05-17 (PR #183). The first end-to-end test (NEAR-Fest XXXIX) exposed three bugs in AI extraction; this spec consolidated those fixes (Part A) and proposed the Phase 2 feature set (Part B). The developer shipped a large chunk of it on 2026-05-18: all three Part A bug fixes, B5 dedup, B6 sender trust + 2 new MCP tools, plus four bonus items the original spec didn't ask for (automatic approval-notification emails, graceful fetch/extract failure handling, retroactive audit rules, the new `inbound_email_senders` table). The system now runs a complete 3-email feedback loop with the submitter (receipt → approval → corrections invitation).

**2026-05-19 audit revisions.** A codebase audit confirmed the shipped checklist but corrected two items: (1) the A2 venue matcher (`src/lib/venue-matching.ts:autoLinkVenue`) is fully shipped with all of the spec's pseudocode (exact + state-agreement + address-corroborated tiers, `Lane`→`lane` normalization, ambiguity handling); the Starling Hall residual case is more likely an AI-extraction issue (wrong venue name passed in) than a matcher bug. (2) A4 JSON-LD parsing and plumbing into the AI prompt is already live (`html-parser.ts` extracts JSON-LD, `submit.ts` forwards it, `ai-extractor.ts` injects it as "Structured data" context); what's NOT shipped is the AI-bypass decision branch the spec proposed. A separate JSON-LD coverage audit (n=30 representative NE organizer URLs) measured Event-schema coverage at 3.3% — well below the spec's ≥15% threshold for prioritizing A4. **Rollout reordered:** A5 (Browser Rendering) ships before A4 finish, because measured fetch-failure rate is 15–30% on live URLs (vs the spec's earlier 5–15% estimate) while JSON-LD Event coverage is functionally rare.

This refresh marks shipped items, flags one partial-shipped item that needs a follow-up, adds two new Part A items that emerged from this week's submissions (JSON-LD priority extraction and Browser Rendering fallback), and reorders the rollout plan around the remaining work. Phase 2B (B1 multi-URL, B2 free-text, B3 confidence tiers, B4 pre-filled form) is unchanged and still queued. Phase 3 (B7 attachment OCR) gains a new regression case: multi-row PDF table conflation, traced to the NHAC June 7 phantom event.

The canonical test case remains NEAR-Fest XXXIX (event id `8b75454a-7c28-41ad-972c-b34490522784`), corrected manually 2026-05-17. Three additional test cases now also have known good states for regression validation: ARRL Maine (`d8684ece`), Garden & Craft Fair (`1fbdc98e`), Breakfast with Bake Sale (`75368a13`).

## Goals

- Eliminate the three known extraction failure modes → done. A1 + A3 shipped 2026-05-18; A2 venue matcher shipped 2026-05-18 (one extraction-side residual case to investigate).
- Convert currently-failing submission patterns into successful PENDING events by handling multi-URL emails, free-text submissions, and incomplete data with confidence-aware fallbacks (Part B). **Revised 2026-05-19:** addressable yield is ~30–40% (down from spec's earlier 70–80% claim, which double-counted dead-URL 404s as fixable failures).
- Build the dedupe + claim funnel → B5 shipped 2026-05-18; verified working.
- Improve admin-queue signal-to-noise by recognizing trusted senders → B6 shipped 2026-05-18; sender trust system + 2 new MCP tools (`get_email_submitter_quality`, `set_email_sender_trust`) + new `inbound_email_senders` table now live.
- ~~**NEW:** Bypass AI extraction entirely when a source page emits structured Event schema (JSON-LD priority extraction).~~ ⚠️ **Deprioritized 2026-05-19** — coverage audit (3.3%) below threshold. JSON-LD parsing/plumbing into AI prompt is live and useful; AI-bypass branch is parking-lot.
- **NEW:** Recover from 403/blocked fetches transparently via Cloudflare Browser Rendering API. **Promoted to ship-next 2026-05-19** based on measured 15–30% fetch-failure rate on live URLs.

## Non-goals

- Attachment processing (flyer PDFs, JPG photos). Still Phase 3. Implementation cost is roughly equal to remaining Phase 2 combined. Auto-reply currently tells senders attachments are ignored — that's honest.
- Multi-turn email conversations. Reply-parsing loops remain brittle. The pre-filled web form (B4) handles "we need more info" better.
- HMAC-signed reply routing. Only useful if we add threaded replies. Park until Phase 3.
- Free-text AI extraction for corrections@ / support@ / press@ / hello@ / unsubscribe@ intents. Still scoped to submit@ only.

## Status as of 2026-05-19 (post-ship + post-audit)

### What shipped (Phase 2A — verified live in production)

| Item                                | Spec section | Ship status                             | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bug 1a — prefer body over meta tags | A1           | ✅ Shipped 2026-05-18                   | Confirmed via 5 test submissions (NEAR-Fest, ARRL Maine, Garden & Craft Fair, Windsor, Starling Hall Breakfast); description text now sources from body content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Bug 1b — venue resolution           | A2           | ✅ Shipped 2026-05-18, ⚠️ residual case | Venue matcher `autoLinkVenue` at `src/lib/venue-matching.ts` is fully shipped with all spec'd pseudocode (exact normalized-name + state agreement, address-corroborated near-match, `Lane`→`lane` / `St`→`street` normalization, ambiguity handling). Matcher intentionally prefers `venueId=NULL` over wrong-link (per file docstring: "prefer false negatives over false positives"). `state_code` regex fallback (`deriveStateFromText`) also live. Residual case: Breakfast with Bake Sale event `75368a13-2f2e-4eda-88a3-fa4fa71ed030` lands `venue_id=NULL` despite Starling Grange Hall existing in venues table — likely root cause is AI extraction passing "Starling Hall" without the "Grange" qualifier, NOT a matcher bug. Investigate the inbound row's extracted `venueName` field before tightening matcher further. |
| Bug 1c — timezone normalization     | A3           | ✅ Shipped 2026-05-18                   | Dates now stored at noon UTC; verified across all test submissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dedup against existing events       | B5           | ✅ Shipped 2026-05-18                   | Test: re-submitting an URL that matches an existing approved event no longer creates a duplicate PENDING record. Confirmed via "SH" + "dup" test submissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| From-address signal weighting       | B6           | ✅ Shipped 2026-05-18 (beyond spec)     | Two new MCP tools: `get_email_submitter_quality` (per-sender stats with out-of-area flag), `set_email_sender_trust` (4-tier enum: unknown/trusted/watchlist/blocked). Backed by new `inbound_email_senders` table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### What shipped beyond the spec (bonus items)

These were not in the original 2026-05-17 spec but the developer shipped them anyway on 2026-05-18:

- **Automatic approval-notification emails.** When admin moves an event from PENDING → APPROVED via `update_event_status`, the submitter automatically receives an email from `notify@meetmeatthefair.com` with subject "Your submission is live: <event name>", the live event URL, copy text setting honest expectations ("some details may have been adjusted during review"), and an invitation to use the reply path for corrections. This creates a complete 3-email feedback loop: T+0 submission → T+~30sec receipt → T+admin-review approval. The system replaces what would otherwise have been manual confirmation work.
- **Graceful fetch/extract failure handling.** Fetch 403/timeout/etc → clean `NonRetryableError: fetch-upstream` with user-facing message. Extract failure on fetched content → `NonRetryableError: extract-upstream` with "Try pasting the content manually" message. Both surface in `inbound_emails.error` for admin review, with corresponding user-facing auto-replies.
- **Retroactive audit rules.** New recommendation rules `events_legacy_gate_candidates` (477 matches) and `stale_year_events` (245 matches) catch events that would now trip the pre-ingest gates but predate them.
- **`inbound_email_senders` table.** Backing store for B6's per-sender stats and trust state.

### What's still queued (Phase 2B / 2C / 3)

Order revised 2026-05-19 after audit. A5 promoted to first ship; A4 demoted to optional / parking-lot since the high-leverage portion (JSON-LD plumbing into the AI prompt) is already live.

| Item                                                                  | Status                    | Effort                    |
| --------------------------------------------------------------------- | ------------------------- | ------------------------- |
| A5 (NEW) — Browser Rendering fallback for 403/blocked fetches         | Queued — **ship next**    | ~half day                 |
| A2 follow-up — investigate Starling Hall extraction (not matcher)     | Queued — single row check | ~30 min                   |
| A4 (NEW) — JSON-LD AI-bypass decision branch (parsing/prompt is live) | Optional / low-leverage   | ~2 hours if pursued       |
| B1 — Multiple URLs per email                                          | Queued                    | ~3 hours                  |
| B2 — Free-text AI extraction (no URL)                                 | Queued                    | ~half day                 |
| B3 — Confidence-aware auto-reply                                      | Queued                    | ~3 hours (depends on B2)  |
| B4 — Pre-filled web form for incomplete submissions                   | Queued                    | ~half day (depends on B3) |
| B7 — Attachment OCR                                                   | Phase 3 (deferred)        | ~1 dev day                |

**Total remaining:** ~2 dev days for Phase 2B/2C if A4 finish is skipped (recommended); ~2.5 dev days if A4 finish is included.

### Audit results (2026-05-19)

Two audits ran on 2026-05-19 to validate the 2026-05-18 spec refresh against the actual codebase and the real population of NE event-organizer URLs.

#### Codebase audit (~25 spec claims cross-checked)

Verified accurate: all Phase 2A shipped items (A1 body-over-meta prompt at `ai-extractor.ts:25`, A3 noon-UTC backfill in `drizzle/0074` + INSERT-time normalization at `suggest-event/submit/route.ts:177-183`, B5 dedup at `email-handlers/submit.ts:215-260`, B6 sender trust table + 2 MCP tools), all bonus items (3 call sites for `notifyApprovalIfNeeded` matching spec, `extract-failed` / `submit-failed` reply kinds wired in workflow), and all queued-status claims for A5 / B1 / B2 / B3 / B4 / B7 (no implementation found, as the spec says).

Found inaccurate:

- **A2 is more shipped than the 2026-05-18 refresh implied.** `autoLinkVenue` in `src/lib/venue-matching.ts` already implements the spec's pseudocode in full — including the address-normalization step (`Ln`→`lane`, `St`→`street`, etc.), exact-name + state-agreement tier, address-corroborated near-match tier, and ambiguity handling. The "venue fuzzy-match is incomplete" framing overstates the brokenness. The Starling Hall residual case is more likely an upstream AI extraction issue (wrong venue name extracted) than a matcher gap.
- **A4 is ~50% shipped.** JSON-LD parsing (`src/lib/url-import/html-parser.ts:110-142`) and JSON-LD plumbing through fetch → extract → AI prompt (`mcp-server/src/email-handlers/submit.ts:55-57,149-150` + `src/lib/url-import/ai-extractor.ts:175-176` injecting `"Structured data (JSON-LD): {...}"` into the prompt) are already live. What's NOT shipped is the spec's specific A4 proposal to **bypass the AI** when JSON-LD provides ≥3 of {name, dates, location, description}.

#### JSON-LD coverage audit (n=30 URLs)

Sample: 24 random distinct-host organizer URLs drawn from `events.source_url` (excluding aggregators) + 6 URLs from the actual inbound-email submit queue. Each was re-fetched with a browser-like UA and classified by JSON-LD payload.

| Outcome                                        | n   | %     | Notes                                                                                      |
| ---------------------------------------------- | --- | ----- | ------------------------------------------------------------------------------------------ |
| `ok-event` (JSON-LD `@type=Event` or subtype)  | 1   | 3.3%  | Only `visitvermont.com` — and it's a DMO aggregator, not a small-organizer site            |
| `ok-other` (JSON-LD present, no Event payload) | 10  | 33.3% | Yoast/WordPress defaults: `WebSite` + `Organization` + `BreadcrumbList` + `LocalBusiness`  |
| `ok-none` (200 OK, no JSON-LD at all)          | 7   | 23.3% | Older static sites, government-CMS pages                                                   |
| `fetch-fail` (non-2xx)                         | 12  | 40.0% | 4×404 (dead URLs from past events), 4×403 (bot block — A5-fixable), 3×000 (DNS/TLS), 1×429 |

**Decision against spec's threshold:** Spec said _"if coverage is ≥40%, A4 leverage is huge; if ≤15%, A5 may be the more pragmatic first ship."_ Measured coverage is **3.3%** — an order of magnitude below threshold. Conclusion: ship A5 before finishing A4.

**Notable secondary findings:**

- **The Starling Hall WordPress plugin does NOT emit Event JSON-LD** despite the original spec's hypothesis. Its `/event/{slug}/` pages emit standard Yoast SEO markup (`WebPage` + `BreadcrumbList` + `Organization` + `ImageObject`) — no `Event` type. The spec's A4 test-case prediction for Starling Hall was wrong.
- **Fetch failures are higher than the spec estimated.** Spec assumed 5–15% of fetches fail; actual is **40% raw, ~30% after excluding 404'd dead pages** (those wouldn't occur on real-time submissions of live events). Of the live-URL failures, ~15% are 403 bot-blocks (the cleanly-A5-fixable subset); the rest are DNS issues, TLS failures, and rate limits (A5 helps some but isn't a silver bullet).
- **The JSON-LD plumbing already shipped is more useful than the audit number suggests.** 33% of URLs emit non-`Event` JSON-LD that nonetheless carries useful signal (Yoast `Organization` with venue address, `LocalBusiness` with name + telephone + address). The AI prompt receives this as context, lifting extraction quality on a third of sites — which is the legitimate value the spec's A4 plumbing was hoping for, just under a different category label.

## Part A — Bug fixes + new extraction items

### A1. Prefer body content over meta tags for location extraction ✅ SHIPPED

**Status:** Shipped 2026-05-18. Implementation approach: Option A (body content fed to AI extraction prompt before meta tags). Verified across 5 production test submissions.

**Test case (regression):** Submit `https://near-fest.com/` to submit@. Resulting PENDING event description should reference "Hillsborough County 4-H Fairgrounds" / "New Boston, NH", not "Deerfield."

**Reframing for future evolution:** Once A4 (JSON-LD priority) ships, the priority cascade for location extraction becomes: JSON-LD Event.location > microdata `itemtype="https://schema.org/Event"` > body content > `<meta>` tags. A1's body-over-meta logic becomes the third tier of that cascade rather than the only fix. A4 is strictly higher leverage for any site that emits structured data.

### A2. Venue resolution + state_code inheritance ✅ SHIPPED (one residual case to investigate)

**Status:** Shipped 2026-05-18. **Revised 2026-05-19** — the codebase audit found the matcher is more complete than the 2026-05-18 refresh implied.

- ✅ `state_code` regex fallback (`deriveStateFromText` in `src/lib/venue-matching.ts:202`) — events auto-tag with the correct state code via description pattern match when the venue has no explicit state.
- ✅ Venue auto-link (`autoLinkVenue` in `src/lib/venue-matching.ts:91`) — implements all spec pseudocode tiers: exact normalized-name match, exact-name + state agreement, exact-name with only-1-candidate, ambiguity surfacing, address-corroborated near-match. Normalizes `Ln`→`lane`, `St`→`street`, `Rd`→`road`, `Ave`→`avenue`, `Blvd`→`boulevard`, `Dr`→`drive`, `Ct`→`court`, `Pl`→`place` before comparison.
- 🔎 Intentionally conservative — prefers `venueId=NULL` over wrong-link. Per file docstring (line 18): _"prefer false negatives (admin manually links) over false positives (wrong venue silently linked). Existing event_data citations and IndexNow pings flow from venue_id; wrong link is much worse than null."_

**Residual case (likely upstream AI bug, NOT matcher bug):** Event `75368a13-2f2e-4eda-88a3-fa4fa71ed030` (Breakfast with Bake Sale, submitted via email 2026-05-18) auto-extracted with `state_code=ME` correctly, but `venue_id=NULL` despite "Starling Grange Hall" existing in the venues table. Hypothesis: the AI extractor emitted `venueName="Starling Hall"` (without the "Grange" qualifier) — the matcher correctly declines to link because exact-name match fails AND the address path requires both `venueAddress` field present AND name-first-token match.

**Follow-up work (~30 min):** Query `inbound_emails` for the row whose `resulting_event_id` is `75368a13-2f2e-4eda-88a3-fa4fa71ed030` and look at what the AI actually extracted into `venueName` / `venueAddress`. If `venueName="Starling Hall"` (no Grange) — this is an AI-prompt issue and the fix is to add a few-shot example to `ai-extractor.ts` that demonstrates preserving full venue names. If `venueName="Starling Grange Hall"` but matcher still missed — re-investigate matcher; check if "Starling Grange Hall" exists in venues table with a slightly different name spelling (e.g., "The Starling Grange Hall" or "Starling Grange").

**Spec'd pseudocode is already shipped — referenced here for context:**

```sql
-- 1. Try exact match first (highest confidence)
SELECT id, state FROM venues
WHERE LOWER(name) = LOWER(:extracted_venue)
  AND (state = :extracted_state OR :extracted_state IS NULL)
LIMIT 2;

-- 2. If no exact match, try fuzzy match with address signal
SELECT id, state, name FROM venues
WHERE (
    LOWER(name) LIKE '%' || LOWER(:extracted_venue) || '%'
    OR LOWER(slug) LIKE '%' || LOWER(:extracted_venue_slug) || '%'
    OR (
      :extracted_address IS NOT NULL
      AND LOWER(address) = LOWER(:extracted_address)
    )
  )
  AND (state = :extracted_state OR :extracted_state IS NULL)
ORDER BY
  CASE WHEN LOWER(address) = LOWER(:extracted_address) THEN 0 ELSE 1 END,
  CASE WHEN LOWER(name) = LOWER(:extracted_venue) THEN 0 ELSE 1 END,
  ABS(LENGTH(name) - LENGTH(:extracted_venue))
LIMIT 1;
```

Normalize Lane→Ln, Street→St, Road→Rd, Avenue→Ave before comparison. The address-match path is what catches the Hillsborough / Starling Hall–style cases.

**Acceptance test:** Re-submit `https://starlinghall.org/event/breakfast-with-bake-sale/` (or recreate via test submission). Resulting PENDING event should have `venue_id` set to the Starling Grange Hall venue ID. Until then, admin still needs to set `venue_id` manually after auto-extraction.

### A3. Timezone normalization for stored event dates ✅ SHIPPED

**Status:** Shipped 2026-05-18 (email-submission path). All new PENDING events from the pipeline now store dates at noon UTC.

**Broader scope (separate ticket):** A one-time UPDATE migration to add 12 hours to every existing event with `start_date % 86400 = 0` remains queued. Coordinate with the date-quality-gates work. See original spec section for the audit SQL.

### A4. JSON-LD Event schema priority extraction ⚠️ PARTIAL SHIPPED (low leverage, parking-lot)

**Status:** Parsing + plumbing live as of 2026-05-18; AI-bypass decision branch NOT shipped. **Revised 2026-05-19** — JSON-LD coverage audit (n=30 URLs, 3.3% Event-schema coverage) found the leverage thesis was wrong for the NE event ecosystem. Finishing A4 is now optional and **deprioritized below A5 and B-series items**.

**What's already shipped (2026-05-18, unannounced in the original spec):**

- `src/lib/url-import/html-parser.ts:110-142` parses `<script type="application/ld+json">` blocks from fetched HTML, finds `@type: "Event"` (also nested under `@graph` arrays), and surfaces the first Event-shaped payload as `metadata.jsonLd`.
- `mcp-server/src/email-handlers/submit.ts:55-57,149-150` round-trips the JSON-LD payload through the workflow's `submit/fetch-url` step (serialized as a string to satisfy Workers' `Serializable<T>` constraint, deserialized in `submit/ai-extract`).
- `src/lib/url-import/ai-extractor.ts:175-176` injects the JSON-LD into the AI prompt as `"Structured data (JSON-LD): {...}"` context, so the model can lift fields directly from the structured payload when they're present.

**What's NOT shipped:** The decision branch the spec called for — _"skip AI extraction when JSON-LD provides ≥3 of {name, dates, location, description}"_. Today the AI still runs on every extraction; JSON-LD just enriches the prompt.

**Why the AI-bypass branch is now low-leverage:** The 2026-05-19 coverage audit on n=30 representative NE organizer URLs (24 random + 6 inbox) found only **3.3% have `@type=Event` JSON-LD** (1/30 — and that one is a DMO aggregator, not a small-organizer site). 33.3% emit non-Event JSON-LD (Yoast `Organization` + `LocalBusiness` + `BreadcrumbList` boilerplate) — useful as AI prompt context but not as authoritative Event source. **The original spec's hypothesis that WordPress event plugins like The Events Calendar, EventOn, and Events Manager are widespread among NE event sites turned out to be wrong** — most small organizer sites use Yoast SEO (no Event schema) or have no SEO plugin at all.

**Revised leverage estimate:**

- Spec assumed JSON-LD Event coverage ≥40% → A4 bypass branch would short-circuit AI on most submissions
- Measured coverage: 3.3% → bypass branch would short-circuit AI on ~1 in 30 submissions
- The "wrong-extraction problem hits ~30–50% of submissions" framing remains true, but A4 doesn't fix that volume — the AI prompt already gets JSON-LD context for ~37% of sites (3.3% Event + 33.3% non-Event JSON-LD), which is where the genuine AI accuracy lift comes from. That lift is already live.

**Optional follow-up (~2 hours, NOT recommended for current sprint):** If a future submission cohort starts skewing toward DMO/aggregator URLs (visit*-state* sites, where JSON-LD Event coverage is higher), revisit. Until then, the 2-hour cost of writing + testing + maintaining the bypass branch is hard to justify against a 3.3% hit rate.

**Reframes A1 — UPDATED:** Since A4 is unlikely to ship as a bypass, the priority cascade for location extraction simplifies back to: body content (A1, authoritative) > JSON-LD context (already in prompt as supplementary signal) > `<meta>` tags (treated as "may be stale" hint in the prompt).

#### If you choose to ship the bypass anyway — original spec reference

Kept here for reference if a future cohort shifts toward DMO/aggregator URLs and the 3.3% number changes materially.

**Implementation:**

- After fetch, parse HTML for `<script type="application/ld+json">` blocks. — _Already done in `html-parser.ts:110-142`._
- Find blocks where `@type === "Event"` (or schema.org Event subtypes: Festival, MusicEvent, FoodEvent, BusinessEvent, SocialEvent, etc.). — _Already done._
- Validate required fields (name + startDate at minimum). — _Not done; this is what the bypass branch adds._
- Map JSON-LD fields → MMATF columns:
  - `location.name` + `location.address.streetAddress` → venue resolution (via A2's fuzzy-match)
  - `startDate`, `endDate` → `events.start_date/end_date` (then through A3's noon-UTC normalization)
  - `offers.price` → `events.ticket_price` (and `offers.url` → `events.ticket_url`)
  - `image` → `events.image_url`
  - `description` → `events.description`
  - `organizer.name` → promoter resolution
- Skip AI extraction when JSON-LD provides ≥3 of {name, dates, location, description}.
- Add `inbound_emails.extraction_method` enum value `'json-ld'` so admin dashboard can show the JSON-LD hit rate.

**Test cases — corrected 2026-05-19 after live coverage audit:**

- `https://starlinghall.org/event/garden-craft-fair/` — ❌ **does NOT have Event JSON-LD** (2026-05-18 spec hypothesis was wrong). Emits Yoast SEO `WebPage` + `BreadcrumbList` + `Organization` + `ImageObject` only. Confirmed by direct curl 2026-05-19.
- `https://near-fest.com/` — confirmed no Event JSON-LD; also 403s from curl-with-browser-UA, so this is an A5 case too.
- `https://www.ham-con.org/` — confirmed no Event JSON-LD via Google Rich Results Test 2026-05-18; should cleanly fall through to A5 (browser rendering) then A1 (body extraction). Note: curl-from-WSL with browser UA returns 200, but the Worker default UA gets 403 — so this is genuinely an A5 case in production, not a fetch-from-anywhere problem.
- `https://www.visitvermont.com/event/{slug}/` — ✅ confirmed Event JSON-LD with `name` + `startDate` (the only ok-event hit in the n=30 audit). DMO aggregator pattern; worth supporting if cohort skews this way.
- DMO sites in general (visit-{state}, discover-{region}) — likely candidates for Event JSON-LD based on the visitvermont hit. Audit a cohort of 10–20 DMO URLs before committing engineering time.

**Bonus discovery-pipeline impact — revised:** the same JSON-LD probe logic _could_ be lifted into the batch discovery skill, but the 3.3% Event-schema coverage on the small-organizer slice suggests the existing bespoke Simpleview/TEC API harvesters are probably picking up the higher-leverage signal anyway. Out of scope for this ticket and lower priority than initially thought.

### A5. Browser Rendering fallback for 403/blocked fetches 🆕 QUEUED — ship next

**Estimated effort:** ~half day

**Decision (locked 2026-05-18 late evening):** Implement the Cloudflare Browser Rendering REST API only. Do NOT pre-build a REST → Puppeteer cascade. Defer the Workers Puppeteer binding to a future ticket, gated on production data showing a meaningful "REST API ran but extraction still failed" cohort. Rationale captured below so future-us doesn't relitigate the choice from scratch.

**Revised 2026-05-19:** Promoted ahead of A4-finish in the rollout order based on the JSON-LD coverage audit (3.3% Event coverage rules out A4-as-bypass) and a measured fetch-failure rate of **15–30% on live URLs** (up from the spec's earlier 5–15% estimate).

#### The problem

The current email-submission Worker uses default `fetch()` from inside a Cloudflare Worker. Some legitimate small-org event sites return non-2xx responses because the Worker's default user-agent gets blocked by their hosting provider's bot rules. The workflow already handles this gracefully (clean `NonRetryableError: fetch-upstream: Could not access page (403 Forbidden). Try pasting the content manually.` with admin notification + user-facing auto-reply, shipped 2026-05-18), but no event gets created.

**Measured 2026-05-19** (n=30 representative organizer URLs, curl with browser-like UA from outside Cloudflare):

- 4×404 — dead pages from past events; these wouldn't occur on real-time submissions of live events
- 4×403 — bot blocks from hosting-provider WAFs (the cleanly-A5-fixable subset, ~15% of live URLs)
- 3×000 — DNS / TLS / connect failures (slow or partially-broken sites; Browser Rendering may help but isn't guaranteed)
- 1×429 — rate limited (Browser Rendering may help by spreading requests across managed IPs)

Confirmed cases from the inbox / discovery: `ham-con.org` (403 from Worker UA, 200 from browser UA), `near-fest.com` (403 from both — likely Cloudflare WAF; needs Browser Rendering's full Chrome fingerprint), `guilfordfair.org` (403), `auditorium.alepposhriners.com` (403), `artsbrookline.org` (403).

#### The fix — two-tier cascade

1. Standard `fetch()` with browser-like user-agent (cheap, fast — works for ~85% of sites)
2. On 403/401/429/interstitial-detected → escalate to Cloudflare Browser Rendering REST API (`/content` endpoint — managed headless Chrome, sites can't tell it from a real user)
3. On Browser Rendering also failing → emit the existing `NonRetryableError` with the "paste content manually" message + admin alert

#### Why Cloudflare Browser Rendering specifically

- Purpose-built for exactly this case (Cloudflare's own bot-handling stack)
- One additional binding/endpoint integration in `mcp-server/wrangler.toml`
- Sites that 403 a Worker fetch don't 403 a managed-Chrome request
- Stacks with A4: Browser Rendering solves the FETCH problem; JSON-LD priority solves the EXTRACT quality problem. They're complementary, not redundant.

#### Why REST API and not a REST → Puppeteer cascade

Cloudflare exposes Browser Rendering two ways: the REST API (`/content`, `/snapshot`, `/screenshot` — fire-and-forget URL fetching, returns HTML) and the Workers binding (Puppeteer-style programmatic control via `@cloudflare/puppeteer`). We considered a 3-tier cascade: standard fetch → REST API → Puppeteer → fail. Decided against. Reasons:

- Both REST API and Puppeteer run Chrome and execute JavaScript. The REST API's `/content` endpoint already renders the page, waits for load, returns full HTML. The Workers binding mostly buys you interaction — `waitForSelector`, clicks, scrolls, network interception. The set of sites where "REST API returned HTML but the HTML was wrong" is much smaller than the set where "REST API got the HTML you needed."
- Detection logic gets fuzzy fast. When would you escalate REST API → Puppeteer? You'd need a heuristic like "HTML < 5KB" or "no `<title>` tag" or "extraction confidence < 0.3" or pattern match on "Please enable JavaScript." Each heuristic adds a code path and a failure mode. The simplest "real" trigger is the extraction step itself failing — but by then you've already paid for the AI inference call.
- NE event sites aren't JS-heavy SPAs. They're WordPress + Yoast (server-side rendered, full content in HTML — coverage audit 2026-05-19 confirmed this), or static HTML, or older PHP CMS. The case where Puppeteer outperforms REST API mostly applies to enterprise SaaS dashboards and React-app marketing sites — not the small-org NE event ecosystem. Empirically, the failures observed in the n=30 audit are 403/bot-blocks or DNS/TLS issues, not "the page needs JavaScript to render" failures.
- Volume math (updated 2026-05-19). Standard fetch handles ~70–85% of live-URL submissions (the spread reflects audit variance: 24 random + 6 inbox URLs gave 50% success rate, but excluding the 4×404 dead pages — which represent past-event URLs unlikely in real submissions — gives ~70% standard-fetch success). REST API expected to handle 70–80% of the remaining failures (the 403 bot-blocks, plus some fraction of 000/429s) — call it 12–20% of total submissions. The cohort where Puppeteer beats REST API but isn't a complete dead-end (sites with such aggressive anti-bot that even managed Chrome fingerprints differently, e.g., near-fest.com confirmed 403 from a real-browser-UA curl) is plausibly 2–5% of total submissions. At MMATF's volume — handful of submissions per week — that's a handful of cases per year. Not worth a maintained third code path until/unless data proves otherwise.
- Both APIs draw from the same Cloudflare Browser Rendering pricing pool (billed by browser-time used, not by API surface). The REST API tends to be effectively cheaper in practice because it can't be misused into long-running sessions: each request spins up a browser, returns HTML, tears it down — minimum billable time. The Workers binding gives you more rope to hang yourself with (a held-open browser handle keeps billing). For A5's fire-and-forget use case, the REST API is the cost-floor option.

#### When to revisit (Puppeteer escalation criteria)

After ~30–60 days of production data, file a follow-up ticket adding the Workers Puppeteer binding as a third tier **only if** the metrics show a meaningful cluster of:

- `inbound_emails` rows where `fetch_method = 'browser-rendering'` AND the resulting extraction returned with confidence < 0.3 or the workflow failed at the extract step, AND
- The pattern is repeatable (same domain or domain class failing multiple times — not one-off site outages)

Until production data demands it, the third tier doesn't exist.

#### Implementation

- Add Cloudflare Browser Rendering REST API access to mcp-server config (either via account-level API token, or via the dedicated binding form if Cloudflare's current docs recommend that for Workers→REST API calls).
- In the fetch step, detect 403/non-200/short-content → call the `/content` endpoint with the URL.
- Return rendered HTML to the next step (extract); rest of workflow unchanged.
- Add `inbound_emails.fetch_method` enum: `'standard' | 'browser-rendering' | 'failed'` so the admin dashboard can show the fallback hit rate (also primary signal for the Puppeteer-escalation decision above).
- Do NOT add the Workers Puppeteer binding in this ticket — leave it as a future escalation only if data demands it.

#### Live test case

Inbound email `d1991708-2deb-4ba7-b8ea-64552f233fc4` (VT submission, URL `https://www.ham-con.org/`, currently `status='failed'` with the 403 error). After A5 ships, re-submitting that URL should produce a PENDING event for HAM-CON. The canonical end state already exists for comparison: I manually ingested HAM-CON 2027 as event `67051e05-bdd4-4fab-b822-ee79ede67596` after fetching from Claude's side (different infrastructure, no 403). Auto-extraction should reproduce something close to that shape.

#### Pricing caveat

Cloudflare's Browser Rendering pricing (browser-minutes/browser-hours allotment on Workers Paid + per-unit overage) is current as of the latest cloudflare.com docs at time of writing. Worth verifying current numbers before locking the dev's estimate — pricing pages change. At expected MMATF volume the cost is negligible either way (the fallback fires on ~15–30% of an already-low submission rate, revised up from spec's earlier 5–15% estimate after the 2026-05-19 coverage audit), but worth a sanity check.

## Part B — New capabilities

### B1. Multiple URLs per email 📋 QUEUED

**Estimated effort:** ~3 hours. Unchanged from original spec.

**Problem:** real-world submissions often contain multiple events:

- A promoter announcing their seasonal lineup ("Spring Show: URL1, Summer Show: URL2, Fall Show: URL3")
- A press release listing coordinated events at multiple venues
- A community member forwarding multiple Facebook events
- A chamber-of-commerce digest

Currently the workflow picks the first URL in the body (`parsed_url` is singular in the schema) and ignores the rest.

**Behavior change:**

- Find ALL URLs in the body (cap at 10 per email; if more, forward whole email to admin for manual handling).
- For each URL, spawn an independent extraction workflow in parallel.
- Schema decision: create one `inbound_emails` row per URL, with a shared `parent_email_id` linking them back to the original message.
- Single combined auto-reply: "Thanks — we received [N] events from your message. All are pending review: [list of extracted names]." Or if any failed: "We extracted [N] events successfully and were unable to process [M] URLs."

**Edge cases:**

- Same URL twice in one email (signature line + body) → dedup before spawning workflows.
- Mix of submit-able URLs and other URLs (Twitter share, unsubscribe link) → URL classification gate filters before extraction.
- One of the N URLs is a 404 / paywall / Cloudflare interstitial → that row gets `status = 'extraction_failed'`, others succeed, the auto-reply mentions the failure count.

### B2. Free-text AI extraction (no URL present) 📋 QUEUED

**Estimated effort:** ~half day. Unchanged from original spec.

**Problem:** the most common pattern for non-technical submitters is to describe the event in prose:

> "Hi, there's going to be a holiday craft fair at the Bangor Library on December 12, 9am-3pm. Hope you can add it."

Today the workflow detects "no URL" and replies asking the sender to include a link. Many casual submitters won't reply; those submissions are lost.

**Behavior change:**

- New extraction path: if no URL is detected, feed the email body directly to the AI with a prompt scoped to event-detail extraction.
- Required minimum for creating a PENDING event: event name + (date OR venue) — if both date AND venue are missing, fall back to the "send a smart reply" path (B3/B4).
- AI returns per-field confidence scores (0.0–1.0); these feed B3 and B4.
- The resulting `inbound_emails.extraction_method = 'free-text'` for downstream reporting.

**Implementation notes:**

- Same AI model as URL-content extraction.
- Watch out for sender signature blocks — filter them out via heuristics (last 5 lines, "regards"/"thanks"/"sincerely" boundary, email-signature patterns).
- Cap input to MAX_BODY_LEN (currently 50,000 chars per the architecture doc).

### B3. Confidence-aware auto-reply 📋 QUEUED

**Estimated effort:** ~3 hours (depends on B2's confidence scoring being in place).

**Behavior change:** three reply tiers based on overall extraction confidence (computed as min or mean of per-field confidences for critical fields: name, date, venue):

| Confidence        | Trigger                                                     | Reply template                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH (≥0.85)      | URL + venue resolved + dates confirmed                      | "Thanks — your event '<name>' on <date> at <venue> is pending review. Approved events typically appear within 24 hours."                                                                                                                  |
| MEDIUM (0.5–0.85) | Most fields captured but venue unresolved OR date ambiguous | "Thanks — we captured your event '<name>'. We were not able to confirm the <venue OR date>. If you can reply with that detail, or use this short form pre-filled with what we already have, we will get it published faster: <form link>" |
| LOW (<0.5)        | Only name extracted, or significant missing fields          | "Thanks — we received your submission about '<name>'. To add it to the site we need a few more details. The fastest way to fill them in is this short form pre-filled with what we have: <form link>"                                     |

PENDING event is created in all three cases (even LOW) so admin can review and complete. The reply differs only in whether/how it solicits more info.

**Interaction with the bonus approval-notification emails (already shipped):** When admin approves a PENDING event, the approval email already fires automatically with a corrections invitation. B3 only adds tiering at the receipt step. Together they form a complete confidence-aware feedback loop: low-confidence receipt → MEDIUM/LOW reply → user completes form → admin approves → approval email confirms.

### B4. Pre-filled web form for incomplete submissions 📋 QUEUED

**Estimated effort:** ~half day. Unchanged from original spec.

**Schema additions:**

```sql
CREATE TABLE event_submission_tokens (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id),
  FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX idx_event_submission_tokens_token ON event_submission_tokens(token);
CREATE INDEX idx_event_submission_tokens_event_id ON event_submission_tokens(event_id);
```

**Behavior change:**

- New public route: `GET /submit-event/[token]`
- Token is a random 32-byte URL-safe string (~256 bits entropy) generated when the PENDING event is created with confidence < HIGH.
- Form is pre-filled with whatever fields the AI did extract; user fills in the missing ones (date, venue, etc.).
- `POST /submit-event/[token]/update` writes the user's input directly into the existing PENDING events row.
- Token expires after 30 days; re-submitting with an expired token redirects to a fresh submission form.

**Security:**

- One token per submission; once `used_at` is set, the form is read-only.
- Form does not allow editing the suggester email or source_name.
- Submission rate-limited via the same OAUTH_KV per-sender mechanism as the email path.

### B5. Deduplication against existing events ✅ SHIPPED

**Status:** Shipped 2026-05-18. Verified via "SH" + "dup" test submissions on 2026-05-18 — submitting an URL that matches an existing approved event does NOT create a duplicate PENDING record.

**Conversion opportunity (still applicable):** the dedup-hit path is a natural funnel into the paid vendor / promoter tier — every dedup hit is a potential claimer. Worth instrumenting this funnel with analytics (`event_dedup_match_offered_claim` GA4 event) so we can measure conversion later. Coordinate with the unified vendor tier launch.

### B6. From-address signal weighting ✅ SHIPPED (beyond spec)

**Status:** Shipped 2026-05-18, with broader scope than the original spec asked for. The developer added:

- New `inbound_email_senders` table — per-sender stats and trust state.
- New MCP tool `get_email_submitter_quality` — returns per-sender stats with an out-of-area flag.
- New MCP tool `set_email_sender_trust` — 4-tier enum: `unknown | trusted | watchlist | blocked`.
- Sender trust is now consultable in admin review and can be used for routing decisions.

The original spec's `from_address_match_type` ENUM + `from_address_match_id` column approach is superseded by the new `inbound_email_senders` table design.

**Phase 3 (still out of scope):** automatic approval for senders in the trusted tier when their `source_url` host matches the trusted domain. Defer until enough data exists on false-positive rates.

### B7. Attachment OCR — Phase 3 (deferred) 📋 QUEUED

**Estimated effort:** ~1 dev day. Not in scope for this spec; still Phase 3.

**Regression test case added 2026-05-18:** When B7 ships, it must handle multi-row PDF tables correctly. The canonical failure mode (memory `feedback_multi_row_pdf_conflation.md`) is: ingesting a PDF where the same venue hosts a series of unrelated events across multiple dates, where AI extraction carries context (organizer, event type) from one row into the next.

**Specific test:** Concord NH Everett Arena 2026 calendar PDF (`https://www.concordnh.gov/DocumentCenter/View/1050/Spring--Summer-Shows`). The PDF is a 24-row schedule, date-sorted and tabular (Date | Day | Start | End | Event | Notes). The 5/23 row is "Gun Collectors Show" (NHAC). The 6/7 row is "Antiques & Book Show" (different organizer). The current AI extraction created a 6/7 "NHAC Gun Collectors Show (June)" by carrying the 5/23 organizer + event-type forward — fabricated, since NHAC is not sponsoring any 6/7 event. The actual 6/7 event is an Antiques & Book Show, unrelated.

**Expected behavior when B7 ships:** that PDF should produce 24 distinct events (or close to it), each with the correct event-column name from its own row. Specifically, the 6/7 event should NOT be named "NHAC" anything.

When prioritized later, the implementation path is otherwise unchanged from the original spec:

- Detect attachment(s) on the inbound email (MIME type filter: PDF, JPG, PNG).
- Forward attachment(s) to Cloudflare Workers AI for image-to-text extraction.
- Run the B2 free-text extraction over the OCR output with explicit per-row isolation when the input is tabular.
- Optionally: store the attachment in R2 via the `upload_image_bytes` MCP tool (queued separately) and attach to the resulting event.

**Expected yield:** 20–30% of small-event submissions arrive as flyer-photo attachments today. Still the largest single-feature volume unlock available.

## Schema changes summary

### Already shipped (in production 2026-05-18)

- `inbound_emails.message_id` (migration 0073) — Gmail-origin dedup
- `inbound_email_senders` table — B6 backing store
- Several `inbound_emails` column additions for the bonus features (graceful failure handling surfaces in `inbound_emails.error`)

### Still pending — A5 (next ship)

```sql
-- For A5 Browser Rendering. Minimum needed to ship A5 + measure fallback hit rate.
ALTER TABLE inbound_emails ADD COLUMN fetch_method TEXT; -- 'standard' | 'browser-rendering' | 'failed'
```

### Still pending — Phase 2B/2C (when those ship)

```sql
-- For B1 (multi-URL) + B2 (free-text) + B3 (confidence tiers) + B4 (form tokens)
ALTER TABLE inbound_emails ADD COLUMN extraction_confidence REAL;
ALTER TABLE inbound_emails ADD COLUMN extracted_fields TEXT; -- JSON, per-field confidence
ALTER TABLE inbound_emails ADD COLUMN parent_email_id TEXT; -- multi-URL one-row-per-URL
ALTER TABLE inbound_emails ADD COLUMN url_count INTEGER DEFAULT 0;
ALTER TABLE inbound_emails ADD COLUMN extraction_method TEXT; -- 'url-fetch' | 'json-ld' | 'free-text' | 'attachment-ocr' | 'mixed'

CREATE INDEX idx_inbound_emails_parent ON inbound_emails(parent_email_id);
```

(The `extraction_method` column becomes useful in Phase 2B once `'free-text'` and `'attachment-ocr'` paths exist. A4 deprioritization means the `'json-ld'` enum value is unlikely to be populated; harmless to leave in the enum spec.)

(`dedup_match_event_id`, `from_address_match_type`, `from_address_match_id` from the original spec are now superseded by the shipped `inbound_email_senders` design + dedup-already-shipped behavior — likely no longer needed as separate columns.)

```sql
-- For B4
CREATE TABLE event_submission_tokens (...);  -- see B4 section
```

**No changes to:** `events`

All remaining Part A fixes and Part B behavior operate on existing columns.

## API surface summary

### Already shipped (Phase 2A — new MCP tools)

- `get_email_submitter_quality` — per-sender stats; admin tool for sender review
- `set_email_sender_trust` — 4-tier trust state (`unknown | trusted | watchlist | blocked`)

### New public routes (queued for B4)

- `GET /submit-event/[token]` — pre-filled form page
- `POST /submit-event/[token]/update` — form submission handler

### Possible new admin route (optional)

- `GET /api/admin/inbound-emails/extraction-quality` — returns aggregate stats on extraction confidence by tier, dedup hit rate, JSON-LD hit rate, Browser Rendering fallback rate, sender-match distribution. Useful for monitoring whether Part B is actually moving the needle once shipped. ~1–2 hours to add if wanted.

## Test plan

### Part A regression tests

Each of these emails sent to `submit@meetmeatthefair.com` should produce a PENDING event with the specified properties:

| #   | Test email body                                            | Expected venue_id                                                            | Expected state_code            | Expected start_date      | Validates                                                                                                                        |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `https://near-fest.com/`                                   | `2add6e80-2ff0-47f6-aea4-0e2f67d93d32` (Hillsborough County 4-H Fairgrounds) | NH                             | `2026-10-02T12:00:00Z`   | A1 ✅ + A2 ✅ + A3 ✅ — canonical Part A test. **Also A5 case** (403 from browser-UA confirmed 2026-05-19)                       |
| 2   | `https://www.ham-con.org/`                                 | (HAM-CON venue once created)                                                 | VT                             | Noon UTC of correct date | A5 (Browser Rendering fallback) — currently fails with 403 from Worker UA. Confirmed 200 from real-browser UA                    |
| 3   | `https://starlinghall.org/event/breakfast-with-bake-sale/` | (Starling Grange Hall)                                                       | ME                             | Noon UTC                 | A2 residual investigation — currently lands with `venue_id=NULL`. Check AI-extracted `venueName` field before tightening matcher |
| 4   | `https://starlinghall.org/event/garden-craft-fair/`        | (Starling Grange Hall)                                                       | ME                             | Noon UTC                 | A2 — confirmed 2026-05-19 that Starling Hall pages do **NOT** emit Event JSON-LD (Yoast `WebPage`/`Organization` only)           |
| 5   | `https://example-with-no-venue-in-mmatf.example.com/`      | NULL (no match)                                                              | (state from description regex) | Noon UTC                 | No-match path doesn't error                                                                                                      |

### Part B feature tests

| #   | Test description                                                                                                     | Expected behavior                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 6   | Email body with 3 different URLs separated by newlines                                                               | 3 separate PENDING events created, all linked via `parent_email_id`; single auto-reply listing all 3 |
| 7   | Email body with 1 URL appearing twice (signature + body)                                                             | 1 PENDING event (deduped before workflow spawn)                                                      |
| 8   | Email body with 12 URLs                                                                                              | Caps at 10 events spawned + 1 admin-forward message                                                  |
| 9   | Email body with no URL but text "Holiday craft fair at Bangor Library on December 12, 9am-3pm"                       | PENDING event created via free-text extraction; `extraction_method = 'free-text'`                    |
| 10  | Email body with prose but no event details ("Hi, hope you're well")                                                  | No PENDING event; reply requesting more info OR forwards to admin                                    |
| 11  | Email with HIGH confidence extraction                                                                                | Auto-reply uses HIGH template (no form link)                                                         |
| 12  | Email with MEDIUM confidence (missing venue)                                                                         | Auto-reply includes form link; form pre-filled with name + date                                      |
| 13  | Email with LOW confidence (only name extracted)                                                                      | Auto-reply emphasizes form link                                                                      |
| 14  | Submit a URL that exactly matches an existing APPROVED event's `source_url`                                          | No PENDING created; reply offers claim link ✅ (already shipped via B5)                              |
| 15  | Submit an event name matching an existing event's name fuzzily + same venue + within 3 days of existing event's date | No PENDING created; reply offers claim link ✅ (already shipped via B5)                              |
| 16  | Submit from an email address tracked in `inbound_email_senders` as `trusted`                                         | PENDING created; admin queue shows trusted indicator ✅ (already shipped via B6)                     |

### Manual verification queries (post-shipping)

```sql
-- New PENDING events from email pipeline should all have venue_id + state_code resolved (or NULL with admin flag)
SELECT id, name, status, venue_id, state_code, source_name
FROM events
WHERE source_name = 'email-submission'
  AND created_at > unixepoch('2026-05-17')
ORDER BY created_at DESC LIMIT 50;

-- A2 follow-up acceptance: after the venue fuzzy-match tightening, venue_id NULL rate should drop materially
SELECT
  COUNT(*) AS total,
  COUNT(venue_id) AS venue_resolved,
  ROUND(100.0 * COUNT(venue_id) / COUNT(*), 1) AS pct_resolved
FROM events
WHERE source_name = 'email-submission'
  AND is_statewide = 0
  AND created_at > unixepoch('2026-05-18');

-- A4 hit rate: how often does JSON-LD short-circuit the AI?
SELECT extraction_method, COUNT(*) AS n
FROM inbound_emails
WHERE to_address = 'submit@meetmeatthefair.com'
GROUP BY extraction_method;

-- A5 hit rate: how often does Browser Rendering save a 403?
SELECT fetch_method, COUNT(*) AS n
FROM inbound_emails
WHERE to_address = 'submit@meetmeatthefair.com'
GROUP BY fetch_method;

-- Confidence tier distribution (after B2/B3)
SELECT
  CASE
    WHEN extraction_confidence >= 0.85 THEN 'HIGH'
    WHEN extraction_confidence >= 0.5 THEN 'MEDIUM'
    WHEN extraction_confidence IS NOT NULL THEN 'LOW'
    ELSE 'unscored'
  END AS tier,
  COUNT(*) AS n
FROM inbound_emails
WHERE to_address = 'submit@meetmeatthefair.com'
GROUP BY tier;

-- Sender trust distribution (B6 already shipped — should already return data)
SELECT trust_level, COUNT(*) AS n
FROM inbound_email_senders
GROUP BY trust_level;
```

## Migration / rollout

### What's already deployed (Phase 2A, 2026-05-18; corrected 2026-05-19)

- A1 (body over meta prompt) — live (`ai-extractor.ts:25`)
- A2 (venue auto-link + state_code regex) — live (`src/lib/venue-matching.ts:autoLinkVenue` + `deriveStateFromText`). Spec-revision 2026-05-19: more fully shipped than the 2026-05-18 refresh implied.
- A3 (timezone normalization) — live in BOTH the one-shot backfill (`drizzle/0074`, 751 rows shifted) AND INSERT-time (`suggest-event/submit/route.ts:177-183`). The 2026-05-18 refresh wrongly called the backfill "queued"; it shipped on 2026-05-18.
- A4 partial — JSON-LD parsing + plumbing into the AI prompt is live (`html-parser.ts:110-142`, `submit.ts:149-150`, `ai-extractor.ts:175-176`). AI-bypass decision branch NOT live (deprioritized 2026-05-19 after coverage audit).
- B5 (dedup) — live (`submit/check-duplicate` workflow step + `/api/suggest-event/check-duplicate`)
- B6 (sender trust + 2 new MCP tools + `inbound_email_senders` table) — live
- Bonus: automatic approval emails (`notifyApprovalIfNeeded`, 3 call sites confirmed), graceful failure handling (`NonRetryableError` with `fetch-` / `extract-` / `submit-` prefixes), retroactive audit rules (`events_legacy_gate_candidates`, `stale_year_events`)

### What's still queued (rollout order revised 2026-05-19)

1. **Phase 2A.5 (~half day):** A5 Browser Rendering fallback (~half day) + A2 residual-case investigation (~30 min, just look at the inbound_emails row for the Starling Hall extraction). **Drop A4 finish** unless future cohort data justifies it.
2. **Phase 2B (~1.5 dev days):** B1 multi-URL + B2 free-text + B3 confidence tiers + B4 pre-filled form. These build on each other (B3 needs B2; B4 needs B3).
3. **Phase 2C (~half day, optional):** admin extraction-quality dashboard.
4. **Phase 3 (future):** B7 attachment OCR (with the multi-row PDF regression case from NHAC) + automatic promoter-match approval + HMAC reply threading.

The broader timezone-normalization audit/update for existing events was completed by `drizzle/0074_event_dates_noon_utc.sql` (751 rows) — coordinate any future audit/update with the date-quality-gates work.

## Open questions

- **Confidence threshold tuning.** HIGH/MEDIUM/LOW boundaries (0.85, 0.5) are still guesses. Calibrate against ~50 real submissions before locking.
- **Free-text extraction model choice.** Workers AI offers several; benchmark before B2 ships.
- **Form abandonment rate.** B4 assumes the pre-filled form converts at higher rates than email replies. Measure both rates in production.
- **Claim-funnel conversion.** B5 dedup-hit-as-claim-opportunity is a hypothesis. Coordinate with the unified vendor tier launch (separate spec).
- **Trusted-sender auto-approval.** B6 shipped the trust infrastructure but didn't enable auto-approval. Need verification-of-domain-ownership flow + false-positive monitoring before enabling. Park for Phase 3.
- **Multi-URL email semantic limits.** What if all 10 URLs are different photos from the same event? Or 10 links to ticket pages for the same event? B5 dedup should catch this AFTER each URL extracts, but if each URL fetches different metadata we may end up with 10 sub-events of the same event. Real-world data will tell us.
- ~~**JSON-LD coverage estimate (NEW).**~~ ✅ **Resolved 2026-05-19.** Audit ran on n=30 representative organizer URLs (24 random + 6 inbox). Result: 3.3% have `@type=Event` JSON-LD, well below the ≥15% threshold. **Conclusion:** ship A5 before A4-finish; A4 AI-bypass branch deprioritized to optional / parking-lot. See "Audit results (2026-05-19)" section.
- **JSON-LD field mapping precision.** Some WordPress event plugins emit `Event.location` as a string ("Town Hall"); others emit a nested Place object with address fields. Relevant only if A4 bypass branch is ever revisited. Existing plumbing already passes the JSON-LD payload to the AI as a string-serialized context block (`ai-extractor.ts:175-176`), which handles both shapes transparently because the AI parses the JSON itself.

## Reference: canonical test cases

### NEAR-Fest XXXIX (2026-05-17, primary Part A canonical)

```
event_id:        8b75454a-7c28-41ad-972c-b34490522784
name:            NEAR-Fest XXXIX
slug:            near-fest-xxxix
status:          PENDING (manually corrected)
source_name:     email-submission
source_url:      https://near-fest.com/
suggester_email: jtarboxme@gmail.com

venue_id:        2add6e80-2ff0-47f6-aea4-0e2f67d93d32  (Hillsborough County 4-H Fairgrounds)
state_code:      NH
start_date:      2026-10-02T12:00:00Z   (Friday)
end_date:        2026-10-03T12:00:00Z   (Saturday)
indoor_outdoor:  MIXED
ticket_url:      https://tickets.near-fest.com/
dates_confirmed: true
promoter_id:     886c40c2-7ad2-47c1-b1e3-0d05bcdb8018  (The New England Amateur Radio Festival Inc.)
```

### ARRL Maine State Convention & Hamfest (2026-05-18 morning, second auto-extraction)

```
event_id:        d8684ece (full id in event_lifecycle_history)
source_url:      arrl.org/hamfests/...
status:          APPROVED after manual review
notes:           Validated that A1 + A3 work end-to-end after the 2026-05-18 ship
```

### Garden & Craft Fair @ Starling Hall (2026-05-18, FOSH series)

```
event_id:        1fbdc98e (full id in event_lifecycle_history)
source_url:      https://starlinghall.org/event/garden-craft-fair/
status:          APPROVED after FOSH review
notes:           AI extraction was clean post-ship; venue_id manually set.
                 2026-05-19: confirmed via direct curl that this page does NOT
                 emit Event JSON-LD (Yoast SEO WebPage/Organization only).
                 So this URL is NOT a useful A4 test case — it tests A1 + A2.
```

### Breakfast with Bake Sale @ Starling Hall (2026-05-18 evening, A2 residual case)

```
event_id:        75368a13-2f2e-4eda-88a3-fa4fa71ed030
source_url:      https://starlinghall.org/event/breakfast-with-bake-sale/
status:          OCCURRED
state_code:      ME (set correctly via regex fallback)
venue_id:        NULL → MANUALLY SET (Starling Grange Hall) → A2 residual case
notes:           The venue exists in MMATF. Codebase audit 2026-05-19 found the
                 matcher is fully shipped with the right pseudocode — likely root
                 cause is that the AI extracted "Starling Hall" without the "Grange"
                 qualifier, NOT a matcher bug. Investigate inbound_emails row's
                 extracted venueName field before tightening matcher.
                 Acceptance test: after the AI prompt is fixed to preserve full
                 venue names (or the row's actual extracted venueName matches
                 a real venues table row), re-submitting should resolve venue_id.
```

### HAM-CON 2027 manual ingestion (2026-05-18, A5 reference)

```
event_id:        67051e05-bdd4-4fab-b822-ee79ede67596
source_url:      https://www.ham-con.org/
status:          APPROVED (manually created after the email submission 403'd)
notes:           After A5 ships, re-submitting ham-con.org via email should reproduce this end state.
                 The inbound email d1991708-2deb-4ba7-b8ea-64552f233fc4 (status='failed' with 403)
                 is the unwound reference.
```

These five reference events together exercise the full Part A surface: A1 (NEAR-Fest body extraction), A2 (ARRL/Garden venue resolution working, Breakfast venueName-extraction residual), A3 (all five — noon UTC), A5 (HAM-CON 403 case, plus NEAR-Fest as confirmed-403-from-browser-UA). A4 has no useful canonical test case in this set: 2026-05-19 audit confirmed none of these URLs emit `@type=Event` JSON-LD; for A4 you'd need a DMO/aggregator URL like `visitvermont.com/event/{slug}`.
