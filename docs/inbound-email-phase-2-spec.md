# Updated spec

**From:** John Tarbox <jtarboxme@gmail.com>
**Date:** Tue, May 19, 2026 at 9:04 AM
**To:** John Tarbox <jtarboxme@gmail.com>

**Owner:** John
**Drafted by:** Claude (Cowork session 2026-05-17, refreshed 2026-05-18 late evening after Phase 2A ship)
**Status:** PARTIAL SHIPPED — Phase 2A (Part A bug fixes + B5 dedup + B6 sender trust) live in production 2026-05-18; Phase 2B/2C queued; two new Part A items added based on this week's learnings.
**Priority:** HIGH (remaining items unlock 70–80% of currently-failing submission patterns)
**Estimated effort remaining:** ~2.5–3 developer days (was 3–4 total; ~1 day shipped + 2 new high-leverage items added)
**Related:** `inbound-email.md` (current architecture), `Dev-Email-2026-05-18-Bug-Fix-Recap.md` (the email that drove the Phase 2A ship), `MMATF-Spec-Event-Date-Quality-Gates.md` (overlapping timezone normalization)

## TL;DR

The inbound email pipeline went live 2026-05-17 (PR #183). The first end-to-end test (NEAR-Fest XXXIX) exposed three bugs in AI extraction; this spec consolidated those fixes (Part A) and proposed the Phase 2 feature set (Part B). The developer shipped a large chunk of it on 2026-05-18: all three Part A bug fixes, B5 dedup, B6 sender trust + 2 new MCP tools, plus four bonus items the original spec didn't ask for (automatic approval-notification emails, graceful fetch/extract failure handling, retroactive audit rules, the new `inbound_email_senders` table). The system now runs a complete 3-email feedback loop with the submitter (receipt → approval → corrections invitation).

This refresh marks shipped items, flags one partial-shipped item that needs a follow-up, adds two new Part A items that emerged from this week's submissions (JSON-LD priority extraction and Browser Rendering fallback), and reorders the rollout plan around the remaining work. Phase 2B (B1 multi-URL, B2 free-text, B3 confidence tiers, B4 pre-filled form) is unchanged and still queued. Phase 3 (B7 attachment OCR) gains a new regression case: multi-row PDF table conflation, traced to the NHAC June 7 phantom event.

The canonical test case remains NEAR-Fest XXXIX (event id `8b75454a-7c28-41ad-972c-b34490522784`), corrected manually 2026-05-17. Three additional test cases now also have known good states for regression validation: ARRL Maine (`d8684ece`), Garden & Craft Fair (`1fbdc98e`), Breakfast with Bake Sale (`75368a13`).

## Goals

- Eliminate the three known extraction failure modes → mostly done; one residual gap in A2 (Part A).
- Convert ~70–80% of currently-failing submission patterns into successful PENDING events by handling multi-URL emails, free-text submissions, and incomplete data with confidence-aware fallbacks (Part B).
- Build the dedupe + claim funnel → B5 shipped 2026-05-18; verified working.
- Improve admin-queue signal-to-noise by recognizing trusted senders → B6 shipped 2026-05-18; sender trust system + 2 new MCP tools (`get_email_submitter_quality`, `set_email_sender_trust`) + new `inbound_email_senders` table now live.
- **NEW:** Bypass AI extraction entirely when a source page emits structured Event schema (JSON-LD priority extraction).
- **NEW:** Recover from 403/blocked fetches transparently via Cloudflare Browser Rendering API.

## Non-goals

- Attachment processing (flyer PDFs, JPG photos). Still Phase 3. Implementation cost is roughly equal to remaining Phase 2 combined. Auto-reply currently tells senders attachments are ignored — that's honest.
- Multi-turn email conversations. Reply-parsing loops remain brittle. The pre-filled web form (B4) handles "we need more info" better.
- HMAC-signed reply routing. Only useful if we add threaded replies. Park until Phase 3.
- Free-text AI extraction for corrections@ / support@ / press@ / hello@ / unsubscribe@ intents. Still scoped to submit@ only.

## Status as of 2026-05-18 (post-ship)

### What shipped (Phase 2A — verified live in production)

| Item                                | Spec section | Ship status                         | Verification                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug 1a — prefer body over meta tags | A1           | ✅ Shipped 2026-05-18               | Confirmed via 5 test submissions (NEAR-Fest, ARRL Maine, Garden & Craft Fair, Windsor, Starling Hall Breakfast); description text now sources from body content                                                                                                                                                                                                                                                       |
| Bug 1b — venue resolution           | A2           | ⚠️ Partial                          | `state_code` regex pass works (sets `state_code=ME/NH/etc.` correctly); venue-table fuzzy-match is incomplete (`venue_id` still NULL on auto-extracted events even when the venue exists in MMATF). Canonical residual case: Breakfast with Bake Sale event `75368a13-2f2e-4eda-88a3-fa4fa71ed030` auto-extracted with `state_code=ME` but `venue_id=NULL` despite Starling Grange Hall existing in the venues table. |
| Bug 1c — timezone normalization     | A3           | ✅ Shipped 2026-05-18               | Dates now stored at noon UTC; verified across all test submissions                                                                                                                                                                                                                                                                                                                                                    |
| Dedup against existing events       | B5           | ✅ Shipped 2026-05-18               | Test: re-submitting an URL that matches an existing approved event no longer creates a duplicate PENDING record. Confirmed via "SH" + "dup" test submissions.                                                                                                                                                                                                                                                         |
| From-address signal weighting       | B6           | ✅ Shipped 2026-05-18 (beyond spec) | Two new MCP tools: `get_email_submitter_quality` (per-sender stats with out-of-area flag), `set_email_sender_trust` (4-tier enum: unknown/trusted/watchlist/blocked). Backed by new `inbound_email_senders` table.                                                                                                                                                                                                    |

### What shipped beyond the spec (bonus items)

These were not in the original 2026-05-17 spec but the developer shipped them anyway on 2026-05-18:

- **Automatic approval-notification emails.** When admin moves an event from PENDING → APPROVED via `update_event_status`, the submitter automatically receives an email from `notify@meetmeatthefair.com` with subject "Your submission is live: <event name>", the live event URL, copy text setting honest expectations ("some details may have been adjusted during review"), and an invitation to use the reply path for corrections. This creates a complete 3-email feedback loop: T+0 submission → T+~30sec receipt → T+admin-review approval. The system replaces what would otherwise have been manual confirmation work.
- **Graceful fetch/extract failure handling.** Fetch 403/timeout/etc → clean `NonRetryableError: fetch-upstream` with user-facing message. Extract failure on fetched content → `NonRetryableError: extract-upstream` with "Try pasting the content manually" message. Both surface in `inbound_emails.error` for admin review, with corresponding user-facing auto-replies.
- **Retroactive audit rules.** New recommendation rules `events_legacy_gate_candidates` (477 matches) and `stale_year_events` (245 matches) catch events that would now trip the pre-ingest gates but predate them.
- **`inbound_email_senders` table.** Backing store for B6's per-sender stats and trust state.

### What's still queued (Phase 2B / 2C / 3)

| Item                                                          | Status             | Effort                    |
| ------------------------------------------------------------- | ------------------ | ------------------------- |
| A2 follow-up — tighten venue fuzzy-match                      | Queued             | ~1–2 hours                |
| A4 (NEW) — JSON-LD Event schema priority extraction           | Queued             | ~4–6 hours                |
| A5 (NEW) — Browser Rendering fallback for 403/blocked fetches | Queued             | ~half day                 |
| B1 — Multiple URLs per email                                  | Queued             | ~3 hours                  |
| B2 — Free-text AI extraction (no URL)                         | Queued             | ~half day                 |
| B3 — Confidence-aware auto-reply                              | Queued             | ~3 hours (depends on B2)  |
| B4 — Pre-filled web form for incomplete submissions           | Queued             | ~half day (depends on B3) |
| B7 — Attachment OCR                                           | Phase 3 (deferred) | ~1 dev day                |

**Total remaining:** ~2.5–3 dev days for Phase 2B/2C inclusive of the two new Part A items.

## Part A — Bug fixes + new extraction items

### A1. Prefer body content over meta tags for location extraction ✅ SHIPPED

**Status:** Shipped 2026-05-18. Implementation approach: Option A (body content fed to AI extraction prompt before meta tags). Verified across 5 production test submissions.

**Test case (regression):** Submit `https://near-fest.com/` to submit@. Resulting PENDING event description should reference "Hillsborough County 4-H Fairgrounds" / "New Boston, NH", not "Deerfield."

**Reframing for future evolution:** Once A4 (JSON-LD priority) ships, the priority cascade for location extraction becomes: JSON-LD Event.location > microdata `itemtype="https://schema.org/Event"` > body content > `<meta>` tags. A1's body-over-meta logic becomes the third tier of that cascade rather than the only fix. A4 is strictly higher leverage for any site that emits structured data.

### A2. Venue resolution + state_code inheritance ⚠️ PARTIAL SHIPPED

**Status:** Shipped partial 2026-05-18.

- ✅ `state_code` regex fallback works — events auto-tag with the correct state code via description pattern match.
- ❌ Venue-table fuzzy-match is incomplete — `venue_id` lands NULL on auto-extracted events even when the venue exists in MMATF.

**Canonical residual case:** Event `75368a13-2f2e-4eda-88a3-fa4fa71ed030` (Breakfast with Bake Sale, submitted via email 2026-05-18) auto-extracted with `state_code=ME` correctly, but `venue_id=NULL` despite "Starling Grange Hall" existing in the venues table and being referenced in the source page body. The state-code regex caught the state; the venue fuzzy-match did not connect the dots.

**Follow-up work (~1–2 hours):** Tighten the SQL fuzzy-match pseudocode from the original spec (still valid as written below) to actually run in the workflow. The exact-match path probably works; the fuzzy-match path likely needs (a) the address-normalization step ("Lane" / "Ln") and (b) the slug-LIKE comparison wired in. Test against the Starling Hall case + 2–3 others until `venue_id` resolves correctly for venues that are clearly in MMATF.

**Pseudocode (unchanged from original spec — still the right target):**

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

### A4. JSON-LD Event schema priority extraction 🆕 QUEUED

**Estimated effort:** ~4–6 hours

**Why it's the highest-leverage remaining Part A item:**

The Part A1 fix (body over meta) handles unstructured signals. But many NE event sites publish structured `<script type="application/ld+json">` blocks with `@type: "Event"` — often automatically via WordPress plugins like The Events Calendar, EventOn, or Events Manager. Those blocks contain authoritative `startDate`, `endDate`, `location` (with name + address + postalCode), `organizer`, `description`, `offers.price`, and `image` — all the fields we currently ask the AI to extract from prose.

This is strictly higher leverage than A5 (Browser Rendering fallback):

- The 403 fetch problem hits ~5–15% of submissions
- The wrong-extraction problem hits ~30–50% of submissions where the AI made up or got the wrong value
- A4 bypasses AI entirely when JSON-LD is present → no hallucination, no date drift, no venue-resolution gap, lower LLM cost
- Already the canonical pattern used by the discovery skill for Simpleview DMO sites (memory `reference_simpleview_sitemap_harvest.md` + `feedback_probe_data_layer_first.md`)

**Reframes A1.** The priority cascade becomes: JSON-LD Event > microdata `itemtype="https://schema.org/Event"` > body content (A1) > `<meta>` tags (last resort).

**Implementation:**

- After fetch, parse HTML for `<script type="application/ld+json">` blocks.
- Find blocks where `@type === "Event"` (or schema.org Event subtypes: Festival, MusicEvent, FoodEvent, BusinessEvent, SocialEvent, etc.).
- Validate required fields (name + startDate at minimum).
- Map JSON-LD fields → MMATF columns:
  - `location.name` + `location.address.streetAddress` → venue resolution (via A2's fuzzy-match)
  - `startDate`, `endDate` → `events.start_date/end_date` (then through A3's noon-UTC normalization)
  - `offers.price` → `events.ticket_price` (and `offers.url` → `events.ticket_url`)
  - `image` → `events.image_url`
  - `description` → `events.description`
  - `organizer.name` → promoter resolution
- Skip AI extraction when JSON-LD provides ≥3 of {name, dates, location, description}.
- Add `inbound_emails.extraction_method` enum value `'json-ld'` so admin dashboard can show the JSON-LD hit rate.

**Test cases (live in production):**

- `https://starlinghall.org/event/garden-craft-fair/` — likely has JSON-LD via WordPress plugin (the AI extracted this cleanly today, but a JSON-LD path would be even better)
- `https://near-fest.com/` — likely doesn't (Frontier Theme, no event plugin per inspection) — should fall back to body/AI
- `https://www.ham-con.org/` — confirmed no JSON-LD via Google Rich Results Test 2026-05-18 — should cleanly fall through to A5 (browser rendering) then A1 (body extraction)
- `https://www.charlestownseafoodfestival.com/` — likely has JSON-LD
- `https://www.tunbridgeworldsfair.com/` — uncertain; good test of detection robustness

**Bonus discovery-pipeline impact:** the same JSON-LD probe logic could be lifted into the batch discovery skill, replacing some of the bespoke Simpleview/TEC API harvesters with a unified "fetch + parse JSON-LD" approach. Out of scope for this ticket but worth noting in dev backlog.

### A5. Browser Rendering fallback for 403/blocked fetches 🆕 QUEUED

**Estimated effort:** ~half day

**Decision (locked 2026-05-18 late evening):** Implement the Cloudflare Browser Rendering REST API only. Do NOT pre-build a REST → Puppeteer cascade. Defer the Workers Puppeteer binding to a future ticket, gated on production data showing a meaningful "REST API ran but extraction still failed" cohort. Rationale captured below so future-us doesn't relitigate the choice from scratch.

#### The problem

The current email-submission Worker uses default `fetch()` from inside a Cloudflare Worker. Some legitimate small-org event sites (ham-con.org confirmed; expect 5–15% of NE event URLs over time) return 403 Forbidden because the Worker's default user-agent gets blocked by their hosting provider's bot rules. The workflow already handles this gracefully (clean `NonRetryableError: fetch-upstream: Could not access page (403 Forbidden). Try pasting the content manually.` with admin notification + user-facing auto-reply, shipped 2026-05-18), but no event gets created.

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
- NE event sites aren't JS-heavy SPAs. They're WordPress + The Events Calendar (server-side rendered, full content in HTML), or static HTML, or older PHP CMS. The case where Puppeteer outperforms REST API mostly applies to enterprise SaaS dashboards and React-app marketing sites — not the small-org NE event ecosystem. Empirically, the 15% of failures observed so far are 403/bot-blocks, not "the page needs JavaScript to render" failures.
- Volume math. Standard fetch handles ~85% of submissions. REST API likely handles 80–90% of the remaining 15% — call it 12–13% of total. The cohort where Puppeteer beats REST API but isn't a complete dead-end (sites with such aggressive anti-bot that even managed Chrome fingerprints differently) is plausibly 1–2% of total submissions. At MMATF's volume — handful of submissions per week — that's a few cases per year. Not worth a maintained third code path until/unless data proves otherwise.
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

Cloudflare's Browser Rendering pricing (browser-minutes/browser-hours allotment on Workers Paid + per-unit overage) is current as of the latest cloudflare.com docs at time of writing. Worth verifying current numbers before locking the dev's estimate — pricing pages change. At expected MMATF volume the cost is negligible either way (the fallback fires on ~5–15% of an already-low submission rate), but worth a sanity check.

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

### Still pending (Phase 2B/2C)

```sql
-- For B1 (multi-URL) + B2 (free-text) + B3 (confidence tiers) + B4 (form tokens)
ALTER TABLE inbound_emails ADD COLUMN extraction_confidence REAL;
ALTER TABLE inbound_emails ADD COLUMN extracted_fields TEXT; -- JSON, per-field confidence
ALTER TABLE inbound_emails ADD COLUMN parent_email_id TEXT; -- multi-URL one-row-per-URL
ALTER TABLE inbound_emails ADD COLUMN url_count INTEGER DEFAULT 0;
ALTER TABLE inbound_emails ADD COLUMN extraction_method TEXT; -- 'url-fetch' | 'json-ld' | 'free-text' | 'attachment-ocr' | 'mixed'
ALTER TABLE inbound_emails ADD COLUMN fetch_method TEXT; -- 'standard' | 'browser-rendering' | 'failed' (for A5)

CREATE INDEX idx_inbound_emails_parent ON inbound_emails(parent_email_id);
```

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

| #   | Test email body                                            | Expected venue_id                                                            | Expected state_code            | Expected start_date      | Validates                                                                             |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------- |
| 1   | `https://near-fest.com/`                                   | `2add6e80-2ff0-47f6-aea4-0e2f67d93d32` (Hillsborough County 4-H Fairgrounds) | NH                             | `2026-10-02T12:00:00Z`   | A1 ✅ + A2 ⚠️ + A3 ✅ — canonical Part A test                                         |
| 2   | `https://www.ham-con.org/`                                 | (HAM-CON venue once created)                                                 | VT                             | Noon UTC of correct date | A5 (Browser Rendering fallback) — currently fails with 403                            |
| 3   | `https://starlinghall.org/event/breakfast-with-bake-sale/` | (Starling Grange Hall)                                                       | ME                             | Noon UTC                 | A2 follow-up — currently lands with `venue_id=NULL`                                   |
| 4   | `https://starlinghall.org/event/garden-craft-fair/`        | (Starling Grange Hall)                                                       | ME                             | Noon UTC                 | A4 (JSON-LD priority) — if WordPress plugin emits Event schema, this path should fire |
| 5   | `https://example-with-no-venue-in-mmatf.example.com/`      | NULL (no match)                                                              | (state from description regex) | Noon UTC                 | No-match path doesn't error                                                           |

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

### What's already deployed (Phase 2A, 2026-05-18)

- A1 (body over meta) — live
- A2 (state_code regex) — live partial
- A3 (timezone normalization, email path) — live
- B5 (dedup) — live
- B6 (sender trust + 2 new MCP tools + `inbound_email_senders` table) — live
- Bonus: automatic approval emails, graceful failure handling, retroactive audit rules

### What's still queued

Suggested rollout order (revised after Phase 2A ship):

1. **Phase 2A.5 (~1.5 dev days):** A2 follow-up (~1–2 hrs) + A4 JSON-LD priority (~4–6 hrs) + A5 Browser Rendering fallback (~half day). All three address fetch/extract quality and stack independently — can ship in any order; recommended together since they share the fetch-and-extract code path.
2. **Phase 2B (~1.5 dev days):** B1 multi-URL + B2 free-text + B3 confidence tiers + B4 pre-filled form. These build on each other (B3 needs B2; B4 needs B3).
3. **Phase 2C (~half day, optional):** admin extraction-quality dashboard.
4. **Phase 3 (future):** B7 attachment OCR (with the multi-row PDF regression case from NHAC) + automatic promoter-match approval + HMAC reply threading.

The broader timezone-normalization audit/update for existing events (A3, broader scope) remains a separate ticket — coordinate with the date-quality-gates work.

## Open questions

- **Confidence threshold tuning.** HIGH/MEDIUM/LOW boundaries (0.85, 0.5) are still guesses. Calibrate against ~50 real submissions before locking.
- **Free-text extraction model choice.** Workers AI offers several; benchmark before B2 ships.
- **Form abandonment rate.** B4 assumes the pre-filled form converts at higher rates than email replies. Measure both rates in production.
- **Claim-funnel conversion.** B5 dedup-hit-as-claim-opportunity is a hypothesis. Coordinate with the unified vendor tier launch (separate spec).
- **Trusted-sender auto-approval.** B6 shipped the trust infrastructure but didn't enable auto-approval. Need verification-of-domain-ownership flow + false-positive monitoring before enabling. Park for Phase 3.
- **Multi-URL email semantic limits.** What if all 10 URLs are different photos from the same event? Or 10 links to ticket pages for the same event? B5 dedup should catch this AFTER each URL extracts, but if each URL fetches different metadata we may end up with 10 sub-events of the same event. Real-world data will tell us.
- **JSON-LD coverage estimate (NEW).** Before sizing A4 priority vs. A5, worth one quick audit: pick 20 random NE event-organizer URLs from the inbox and check which emit Event JSON-LD. If coverage is ≥40%, A4 leverage is huge; if ≤15%, A5 may be the more pragmatic first ship.
- **JSON-LD field mapping precision (NEW).** Some WordPress event plugins emit `Event.location` as a string ("Town Hall"); others emit a nested Place object with address fields. The extraction step needs to handle both shapes gracefully.

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
notes:           AI extraction was clean post-ship; venue_id manually set
```

### Breakfast with Bake Sale @ Starling Hall (2026-05-18 evening, A2 residual case)

```
event_id:        75368a13-2f2e-4eda-88a3-fa4fa71ed030
source_url:      https://starlinghall.org/event/breakfast-with-bake-sale/
status:          OCCURRED
state_code:      ME (set correctly via regex fallback)
venue_id:        NULL → MANUALLY SET (Starling Grange Hall) → this is the A2 residual case
notes:           The venue exists in MMATF; the workflow didn't connect it. Acceptance test for A2 follow-up.
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

These four reference events together exercise the full Part A surface: A1 (NEAR-Fest), A2 partial (ARRL/Garden working, Breakfast residual), A3 (all four), A4 (Garden likely yields JSON-LD), A5 (HAM-CON 403 case).
