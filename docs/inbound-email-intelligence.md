# MMATF-Spec-Inbound-Email-Intelligence

**Owner:** John
**Drafted by:** Claude (Cowork session 2026-05-19)
**Status:** QUEUED — proposes two new architectural layers on top of the email submission pipeline
**Priority:** HIGH (Part C is a prerequisite for B1/B2/B7 from Phase 2; Part D is reusable substrate for all AI decisions in MMATF)
**Estimated effort:** ~3–3.5 developer days total (Part C ~1.5 days incl. multi-intent + source_suggestion + correction handlers, Part D ~1.5–2 days)
**Last revised:** 2026-05-19 (added source_suggestion intent, fast-path pre-check, source workflow, correction-disambiguation workflow, multi-intent receipt template — driven by John's multi-intent test case)
**Related:** [`MMATF-Spec-Email-Submission-Phase-2.md`](./MMATF-Spec-Email-Submission-Phase-2.md) (Parts A and B of the pipeline, partially shipped 2026-05-18), [`inbound-email.md`](./inbound-email.md) (original architecture)

---

## TL;DR

The inbound email pipeline currently routes by `to_address` only. That's brittle: it can't recover when a sender uses the wrong address (correction to `submit@`, new event to `support@`, flyer to `hello@`), can't gracefully handle multi-event submissions or attachment-only inputs, and has no learning loop to improve over time. This spec proposes two new architectural layers:

- **Part C — Smart Intent Routing.** An LLM classifier sits in front of the address-based router and decides which workflow an email actually belongs to. Allows content to override the address hint when they disagree, and provides the routing branch that B1 (multi-URL), B2 (free-text), and B7 (attachments) all need to dispatch correctly.

- **Part D — Feedback Infrastructure.** A versioned, labeled-dataset substrate that captures every AI decision (classification, extraction, parsing) with its rationale + version stamp, accepts corrections from multiple sources (admin, workflow outcomes, **sender click-through feedback**), and feeds quarterly prompt-refinement cycles. Designed once, reusable across all current and future AI steps in the pipeline.

The meta-design point: **Part D is the substrate; Part C is the first consumer.** Once Part D exists, the same loop extends naturally to extraction quality (Phase 2A is already shipped without it), JSON-LD parsing (A4), free-text extraction (B2), and attachment OCR (B7).

Sender feedback widgets (D.3) are the load-bearing element of Part D for ground-truth labels. Industry CTR on transactional thumbs-up/down is 3–8% — small absolute volume at MMATF scale (handful of submissions/week) but the highest-quality signal in the whole dataset because the sender knows what they meant.

---

## Goals

- **Eliminate address-routing fragility** by classifying intent from content, not just `to_address`. Recover from common misdirections (correction to submit@, new event to support@, etc.).
- **Provide the routing branch B1/B2/B7 need.** Today's single-URL submit workflow assumes its input shape. The classifier lets the pipeline dispatch to different workflows based on the actual email shape.
- **Build a labeled dataset for continuous improvement.** Every AI decision becomes a row with version stamp + confidence + rationale + ground-truth correction (when available). Enables periodic prompt refinement without requiring fine-tuning infrastructure.
- **Make sender feedback explicit.** Embed signed-token thumbs-up/down + intent-correction buttons in outbound emails. Sender feedback is the highest-trust label source in the dataset.
- **Quarantine obvious spam early.** Don't burn AI extraction on "click here for cheap pharmacy" emails.

## Non-goals

- **Fine-tuning a custom intent classifier model.** Out of scope. At MMATF's submission volume (~handful/week), prompt engineering against a hosted LLM is correct; fine-tuning would need hundreds-to-thousands of labeled examples and operational complexity that doesn't pay off.
- **Online learning.** Updating the classifier in real-time based on feedback is a security risk (a malicious sender could poison the classifier) and unnecessary for the throughput pattern.
- **Multi-turn classifier dialogues.** If a classification is ambiguous, route to admin queue + ask the sender via a clarification reply with the feedback widget. Don't try to have the LLM ask follow-up questions.
- **Cross-product application.** This spec is scoped to inbound email. The substrate is designed to be reusable for other AI decisions in MMATF (extraction, etc.) but rolling it out to those is separate work.

---

## Architecture overview

```
[Email arrives at any of submit@/corrections@/support@/hello@/press@/unsubscribe@/catch-all]
        ↓
[Worker: parse headers + body + attachments]
        ↓
[Check sender trust (B6 — already shipped)]
   ↓ blocked   → drop silently
   ↓ trusted   → fast-path: route by to_address as hint, log classifier "skipped: trusted_sender"
   ↓ unknown/watchlist → continue
        ↓
[Part C — Smart Classifier (NEW)]
   inputs: to_address, from_address, subject, body, attachment_count,
           is_reply_to_our_thread, sender_trust_tier
   outputs: intent + confidence + sub_intent + target_workflow + rationale
   stamped with: classifier_version
        ↓
[Confidence gate]
   ↓ confidence ≥ 0.85 → route per classifier
   ↓ confidence < 0.85  → route per to_address (fallback) + flag for admin
        ↓
[Route to workflow]
   ↓ new_event_single_url     → existing submit workflow (Phase 2A.5: + A4 + A5)
   ↓ new_event_multi_url      → B1 workflow
   ↓ new_event_free_text      → B2 workflow
   ↓ new_event_attachment     → B7 workflow (Phase 3)
   ↓ correction               → corrections workflow (TBD spec)
   ↓ claim_request            → claim workflow (TBD, coordinate with unified vendor tier)
   ↓ vendor_inquiry           → support routing
   ↓ press                    → press@ workflow (TBD)
   ↓ unsubscribe              → unsubscribe workflow
   ↓ spam                     → quarantine + admin daily digest (no auto-reply)
   ↓ unclear                  → admin triage queue + clarification reply to sender
        ↓
[Workflow executes, writes outcome to inbound_emails]
        ↓
[Outbound auto-reply includes Part D.3 feedback buttons]
        ↓
[Part D — Feedback Infrastructure captures]
   • D.1: Admin reclassification actions in /admin/inbound-emails
   • D.2: Workflow outcome inference (PENDING approved/rejected, etc.)
   • D.3: Sender button clicks on outbound email links
   • D.4: All sources aggregate into a labeled dataset for quarterly prompt review
```

Architecturally clean: Part D doesn't depend on Part C (it could capture extraction-quality feedback independently). Part C produces signal that Part D captures. Both can ship independently though they're designed together.

---

## Part C — Smart Intent Routing

**Estimated effort:** ~1 dev day (6–10 hours)

### C.1 Intent taxonomy

Eight intent classes plus an `unclear` bucket. Designed to be (a) MECE for the obvious cases, (b) actionable — every intent maps to an existing or planned workflow, (c) extensible — new intents can be added without restructuring.

| Intent              | Description                                                   | Example trigger phrases                                                                                                  | Target workflow                                                                                 |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `new_event`         | Submitting a new event (any sub-shape)                        | "Here's my craft fair...", URL to event page, attachment with flyer                                                      | Phase 2 submit workflow (sub_intent picks single_url / multi_url / free_text / attachment_only) |
| `source_suggestion` | User points us at a website/feed as a potential events source | "I discovered a site listing events at...", "Have you tried looking at X?", "You should check this calendar"             | discovery_candidates dedup-then-cross-check workflow (see C.8 below)                            |
| `correction`        | Fixing details on an event already in MMATF                   | URL contains `meetmeatthefair.com/events/`, "the date is wrong", "appears to be incorrect", reply to our approval thread | Corrections workflow (TBD spec) — must handle event-disambiguation per C.9 below                |
| `claim_request`     | Organizer claiming ownership of a listing                     | "I am the organizer of this event", "How do I claim my listing", from-address matches an event's promoter contact        | Claim workflow (coordinate with unified vendor tier launch)                                     |
| `vendor_inquiry`    | Vendor asking about listing, applications, profile            | "How do I list my booth?", "I exhibit at fairs and would like to be added"                                               | Support routing → eventually vendor self-service                                                |
| `support`           | General support / how-to questions                            | "How does your site work?", "Can you help me find..."                                                                    | Support@ workflow (manual response)                                                             |
| `press`             | Media inquiry, partnership, podcast invite                    | "Writing for [publication]...", "We'd like to feature MMATF"                                                             | Press@ workflow (manual response)                                                               |
| `unsubscribe`       | Opt-out request                                               | "Stop emailing me", "Remove from your list", "unsubscribe"                                                               | Unsubscribe workflow + add to sender_trust as `blocked`                                         |
| `spam`              | Obvious junk                                                  | Phishing patterns, off-topic promotional, gambling/pharma keywords, no NE event context                                  | Quarantine, no auto-reply, surface in daily admin digest                                        |
| `unclear`           | Below confidence threshold or genuinely ambiguous             | Anything not matching above with confidence ≥ 0.85                                                                       | Admin triage queue + clarification reply with intent-picker buttons                             |

### C.2 Sub-intent (for `new_event` only)

When intent = `new_event`, the classifier also returns a sub-intent picking which submission workflow to use:

| Sub-intent        | Trigger                                       | Target workflow                                                                |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `single_url`      | Exactly one event URL in body, no attachments | Phase 2 single-URL workflow (current shipped path + A4/A5 enhancements)        |
| `multi_url`       | 2+ event URLs in body                         | B1 workflow                                                                    |
| `free_text`       | No URLs, prose description with event details | B2 workflow                                                                    |
| `attachment_only` | No URLs, no prose, only PDF/JPG attachment    | B7 workflow (Phase 3 — until then, route to admin)                             |
| `mixed`           | URL(s) + free-text supplementary details      | Sub-route to single_url or multi_url; treat free-text as supplementary context |

### C.3 Classifier implementation

**Model choice:** Workers AI llama family (consistent with the existing extraction step's infrastructure). Use the same binding the extraction step uses to keep operational surface area minimal.

**Prompt structure:**

```
SYSTEM:
You are an intent classifier for an inbound email pipeline for meetmeatthefair.com,
a New England event discovery website. Classify the email into ONE of the following intents:

[taxonomy table from C.1]

For new_event, also classify the sub_intent from [table from C.2].

Respond with JSON only:
{
  "intent": "...",
  "sub_intent": "..." or null,
  "confidence": 0.0–1.0,
  "rationale": "one sentence explaining the classification"
}

USER:
to_address: <to>
from_address: <from>
sender_trust_tier: <unknown|trusted|watchlist|blocked>
is_reply_to_our_thread: <true|false>
attachment_count: <n>
attachment_types: <list>
subject: <subject>
body (first 3000 chars):
<body>
```

**Outputs:**

```json
{
  "intent": "new_event",
  "sub_intent": "single_url",
  "confidence": 0.94,
  "rationale": "Single URL to event page in body, no attachments, sent to submit@; sender is unknown but message structure matches typical new-event submission."
}
```

**Versioning:** classifier_version is a string like `c-2026-05-19-v1` that fingerprints the prompt + model. Every classification gets stamped. Lets us A/B test prompt revisions and roll back if a new version regresses.

### C.4 Confidence gate + fallback behavior

- **Confidence ≥ 0.85:** route per classifier output. classifier-driven routing logged with `routing_source = 'classifier'`.
- **Confidence < 0.85:** fall back to `to_address` routing (current behavior). Log with `routing_source = 'fallback_low_confidence'`. Add to admin triage queue with the classifier's best guess + rationale so admin can override.
- **classifier_version mismatch with to_address:** if classifier confidence ≥ 0.85 but disagrees with the address (e.g., correction sent to submit@), route per classifier. Log with `routing_source = 'classifier_override'`. This is the most interesting case — it's the value the classifier adds.

The 0.85 threshold is a starting guess. Calibrate against the first ~100 production classifications before locking the value (open question Q1).

### C.5 Fast-path for trusted senders — with cheap multi-intent pre-check

When sender_trust_tier (from B6) = `trusted` AND to_address matches a known-canonical pattern for that sender:

- **First, run a cheap regex pre-check** on the body to detect multi-intent shapes (zero AI cost — just pattern matching):
  - 2+ distinct event-page URLs in body → run full classifier
  - Body contains correction-signal keywords (`wrong`, `incorrect`, `should be`, `the date`, `appears to be`) → run full classifier
  - Body contains source-suggestion-signal keywords (`I discovered`, `I found a site`, `you should check`, `have you tried`, `here is a website`) → run full classifier
  - Body contains claim-signal keywords (`I am the organizer`, `I run this event`, `my event`) → run full classifier
  - Reply-chain detected (In-Reply-To/References pointing to our outbound) → run full classifier
- **Only if NONE of those signals fire:** skip classifier, route by to_address, log `routing_source = 'trusted_fastpath'`
- Embed feedback widgets in the auto-reply regardless so we can detect regressions

**Why the pre-check matters (locked 2026-05-19):** Even trusted senders write multi-intent emails. The canonical demo case is John's own test email containing a source suggestion, a Facebook URL submission, AND a correction reference in one message — none of which the original fast-path would have detected. Without the pre-check, the fast-path silently mis-routes anything with mixed content. The pre-check is a zero-cost addition (regex pass on body) that catches the multi-intent and correction-disguised-as-submission cases without losing the latency benefit of the fast-path on simple single-intent submissions.

Cost analysis: regex pre-check adds ~1ms per email. Multi-intent shapes are uncommon (~5-10% of all submissions estimated), so the fast-path still applies to the vast majority of trusted-sender emails. Net effect: catches the failure mode without sacrificing the optimization.

### C.6 Spam handling

Classification = `spam` triggers a different path:

- **No PENDING event created**
- **No auto-reply sent** (replying to spam confirms a live inbox)
- **Inbound row written** with full content for admin audit
- **Daily admin digest** surfaces the spam batch with one-click "yes, definitely spam → add sender to blocked" affordance

Patterns to catch in the prompt (training-by-example):

- Pharma/gambling/cheap-loans keywords
- Phishing patterns (urgency + credential request + suspicious URL)
- Mass-marketed lists (recipients in BCC, generic subject)
- Off-topic for NE event context

### C.7 Reply-chain detection

If `In-Reply-To` or `References` headers contain a Message-ID from a previous outbound email (notify@/support@/etc.), this is part of an ongoing conversation. Route to the original thread's workflow + adjust intent confidence accordingly. The classifier should still run but with `is_reply_to_our_thread: true` as a strong signal (likely intent = correction OR follow-up to existing workflow, not a new submission).

### C.8 `source_suggestion` workflow — dedup-then-cross-check

When classifier returns intent = `source_suggestion` (with a URL/domain reference), don't blindly insert a new discovery candidate. Run a three-stage check:

```
1. Check discovery_candidates for the URL/domain
   ├─ Matched + status='active' → reply: "Thanks — we already pull from this source.
   │                                      Last harvest [date], [N] events created.
   │                                      Notice a specific event missing? Reply with it."
   ├─ Matched + status='snoozed' / 'failed' → reply: "Thanks — we tried this source
   │                                                 but [reason]. Re-evaluating it
   │                                                 based on your suggestion."
   │                                                 (admin reviews, may unsnooze)
   └─ Not matched ↓
2. Check events.source_url for the domain (informal usage)
   ├─ Matched (events exist sourced from this domain) → reply: "We already use this
   │                                                            source informally —
   │                                                            [N] events from it.
   │                                                            We'll formally register
   │                                                            it in our discovery
   │                                                            queue."
   │                                                            + admin notification
   │                                                            + auto-insert into
   │                                                            discovery_candidates
   │                                                            with status='pending_review'
   └─ Not matched ↓
3. Genuinely new source
   ├─ Insert row in discovery_candidates with status='pending_review',
   │  source_url, source_label (from email), notes='Suggested by [from_address] on [date]
   │  via inbound email [id]', source_type='community_suggestion'
   └─ reply: "Thanks — we've added this to our discovery queue for evaluation.
              Admin will review and we'll let you know if we start pulling events
              from it."
```

**Why this matters (the canonical case):** A user submitted `https://www.mainemade.com/events/` as a source suggestion 2026-05-19. The site has 62 events already sourced from it (informal usage) but isn't registered in discovery_candidates. Without this three-stage check, the system would either (a) ignore the suggestion because the row doesn't exist, or (b) insert a duplicate-of-informal-usage row that admin then has to dedupe. The three-stage check catches the case where a source is "in use but not registered" — a real gap revealed by the test case.

**Schema note:** discovery_candidates already has a `source_type` column per the existing schema (memory `reference_discovery_candidates_table.md`). Add a value `community_suggestion` to that enum (or use the existing `other` value with a notes prefix). No new columns required.

### C.9 `correction` workflow — event-disambiguation

When classifier returns intent = `correction` with an event reference clue (event name, venue, date hint), the corrections workflow needs to disambiguate to a specific event ID before applying any change. Three lookup tiers:

```
1. Exact-URL match — if body contains meetmeatthefair.com/events/SLUG, look up by slug
   ├─ Found + status='APPROVED' → unambiguous target
   ├─ Found + status='REJECTED' → reply: "The event at this URL has been removed.
   │                                       Could you tell us what event you meant?"
   └─ Not found → slug rename / 404 — fall through to tier 2

2. Name + venue fuzzy match
   ├─ Exactly 1 match → unambiguous target
   ├─ 2+ matches (e.g., recurring annual event, latent duplicate) → AMBIGUOUS
   │   Surface BOTH to admin AND in reply to user:
   │   "We found multiple events matching '[name] at [venue]':
   │   • [Event 1] — [date], [slug]
   │   • [Event 2] — [date], [slug]
   │   Which one did you mean? [Pick event 1] [Pick event 2]"
   └─ 0 matches → reply: "We couldn't find a matching event. Could you reply with
                          the event URL on our site, or more details?"

3. Free-text match against name only (fallback)
   ├─ ≥3 matches → escalate to admin for manual disambiguation
   └─ <3 matches → present to user with the disambiguation prompt above
```

**The disambiguation step is mandatory.** Never apply a correction silently when the lookup returns 2+ candidate events — even if the latent-duplicate cleanup would resolve the ambiguity, the correction itself targets a specific row and silently picking one is worse than asking.

**Bonus: surfaces latent duplicates as a side effect.** If the disambiguation returns 2+ matches with the same name + venue + date, that's a latent duplicate pair (like the Lilac Festival case 2026-05-19 that prompted this spec edit). The corrections workflow should surface those to admin with a one-click "merge these" affordance — turning corrections email traffic into a data-quality improvement loop.

**Canonical reference (2026-05-19 Lilac Festival case):** User reported "the date for the Lilac Festival at Viles Arboretum appears to be incorrect." Lookup returned 2 matches: `3fabfc9e` (canonical, slug `lilac-festival`) and `1df6b84` (duplicate, slug `lilac-festival-augusta-2026`). Admin manually resolved: confirmed `3fabfc9e` as canonical, applied A3 noon-UTC backfill (which fixed the display bug the user was actually reporting), rejected `1df6b84` as duplicate. After C.9 ships, that same email would surface the disambiguation prompt automatically.

### C.10 Cross-check: `correction` workflow + event_date_drift recommendation rule

The existing `event_date_drift` recommendation rule already cross-checks stored event dates against canonical organizer sites. When a `correction` workflow targets a date field specifically, run the same drift check inline:

1. Fetch the event's `source_url`
2. Parse for dates (JSON-LD priority, then body)
3. Compare against stored `start_date` / `end_date`
4. If mismatch → surface to admin with "user reported [field] wrong; canonical source says X, we have Y — propose this fix"
5. If match → reply to user: "We checked the canonical source for this event and it matches what we have stored. Could you share where you saw the different date?"

This converts a noisy "your date is wrong" claim into either a high-confidence fix recommendation or a useful "we verified against the source" response. Saves admin from chasing every claim manually.

---

## Part D — Feedback Infrastructure

**Estimated effort:** ~1.5–2 dev days (10–16 hours)

### D.1 Admin reclassification UI

**Estimated effort:** ~3 hours

In the existing `/admin/inbound-emails` detail view (the page shipped 2026-05-18):

**Display additions (read-only):**

- Classifier intent + sub_intent + confidence + rationale prominently in a labeled panel
- classifier_version stamp (small badge, useful for filtering admin queue later)
- routing_source: `classifier` / `classifier_override` / `fallback_low_confidence` / `trusted_fastpath` / `address_only` (pre-classifier rows)

**Interactive affordances:**

- **"Reclassify intent" dropdown** — admin picks a different intent from the taxonomy. On confirm:
  1. Write a row to `inbound_email_intent_feedback` with `feedback_source = 'admin_reroute'`, `original_intent`, `corrected_intent`, optional `admin_note`, `created_by` (admin user_id), `classifier_version`
  2. Optionally re-run the workflow on the new intent (admin gets a checkbox: "also re-run workflow")
- **"Mark as correctly classified" button** — for low-confidence cases that turned out fine. Active labeling. Writes a feedback row with `feedback_source = 'admin_label'` and `corrected_intent = original_intent` (i.e., confirming the classifier was right despite low confidence). This is the dataset's "negative" class — examples the classifier should have been MORE confident about.
- **"Flag this for the next prompt revision" button** — for cases admin notices that aren't reclassifications per se but are worth highlighting in the quarterly review. Writes to a separate `flagged_for_review` boolean.

**Aggregate badge:**

- Top of the inbound-emails page: "Classifier accuracy (last 30 days): N%" — calculated as (1 - admin_reroute_count / total_classifications). Becomes the operational health indicator.

### D.2 Workflow outcome inference

**Estimated effort:** ~3 hours

Implicit feedback from downstream events. Doesn't require any user action — the system observes what happens after routing and infers whether the routing was correct.

**Positive signals (intent confirmed correct):**

| Event                                                   | Implies                                          |
| ------------------------------------------------------- | ------------------------------------------------ |
| PENDING event APPROVED by admin without intent change   | new_event intent was correct                     |
| Corrections workflow completed without admin reroute    | correction intent was correct                    |
| Sender clicks 👍 on the receipt or approval email (D.3) | classifier was right                             |
| Sender doesn't reply within 30 days after auto-reply    | weak positive (could also just be disengagement) |

**Negative signals (intent likely wrong):**

| Event                                                                 | Implies                                       |
| --------------------------------------------------------------------- | --------------------------------------------- |
| PENDING event REJECTED with reason containing "not an event" / "spam" | new_event intent was wrong                    |
| Admin manually reroutes via D.1 UI                                    | classifier was wrong (this overlaps with D.1) |
| Sender clicks ✏️ "I meant something else" on the receipt email (D.3)  | classifier was wrong                          |
| User replies with text matching "I wanted to ..." patterns            | weak negative — admin reviews and labels      |

Each signal triggers a row in `inbound_email_intent_feedback` with `feedback_source` set to the appropriate enum value. Implicit signals get lower weight than explicit ones in the aggregate dataset (open question Q5).

### D.3 Sender feedback widgets — the highest-trust signal

**Estimated effort:** ~4–6 hours

The sender is the ground truth source. Admin labels are educated guesses about what the sender meant; the sender knows. Embed signed-token feedback widgets in outbound emails for one-click feedback.

#### D.3.1 Two feedback moments

Different outbound emails capture different feedback dimensions:

**Receipt auto-reply (T+~30sec) — classifier feedback:**

```
Subject: Thanks — we received your submission about "NEAR-Fest XXXIX"

Hi —

Got it. We logged this as a new event submission and your event is in
admin review now. We'll email you again when it's approved (usually
within 24 hours).

Was this what you wanted?
  ✅ Yes, submit my event           [signed URL → feedback endpoint]
  ✏️ I meant something else         [signed URL → follow-up form]
  ❌ Cancel — don't add this        [signed URL → cancels PENDING]

— Meet Me at the Fair
notify@meetmeatthefair.com
```

The "❌ Cancel" path is its own UX win: gives senders an explicit way to abort accidental submissions within minutes, reducing admin queue noise.

**Multi-intent receipt auto-reply (when the email spawned 2+ child intents):**

When an email is classified into multiple intents (Q3 v2 multi-intent splitting), the receipt auto-reply uses a structured per-intent format instead of the single-intent template above. Each section gets its own feedback widget scoped to its specific intent.

```
Subject: Thanks — we received your email about N items

Hi —

We saw [N] things in your message. Here's what we're doing with each:

1. 📡 [intent_label e.g., "Source suggestion: mainemade.com"]
   [outcome_summary e.g., "We already pull from this site (62 events sourced).
    Admin will formally register it in our discovery queue."]
   Was this what you wanted?
   [✅ Yes]  [✏️ I meant something different]
        ↑                ↑
   signed-token URL    signed-token URL
   (scoped to child #1) (scoped to child #1)

2. 📝 [intent_label e.g., "New event submission: Facebook URL"]
   [outcome_summary e.g., "Unfortunately Facebook restricts automated access.
    The fastest way to add this event is to paste details into our short form."]
   [📋 Open form]  [❌ Cancel — never mind]
        ↑                ↑
   B4 pre-filled form  signed-token URL
   (scoped to child #2) (cancels PENDING child)

3. 🔍 [intent_label e.g., "Correction: Lilac Festival at Viles Arboretum"]
   [outcome_summary e.g., "We found 2 events matching that description.
    Could you tell us which one + what the correct date should be?"]
   [📅 Reply with details]  [👍 Wait for admin to check]
        ↑                          ↑
   mailto: link             signed-token URL
                            (scoped to child #3)

— Meet Me at the Fair
notify@meetmeatthefair.com
```

**Implementation notes:**

- Each section is generated from the corresponding child `inbound_emails` row's intent + outcome state, not from the parent
- Token signing per-section: each button's token encodes the CHILD inbound_email_id, not the parent (so feedback gets attributed correctly)
- Length budget: cap at 4 sections per reply. If 5+ intents, send the email with the top 4 and a note: "Plus [N] additional items we flagged for admin review."
- Each section's "needs fixing" / "I meant something different" path leads to a follow-up form scoped to JUST that child intent — not a giant form covering everything

**Why a dedicated multi-intent template (not just concatenated single-intent templates):**

The single-intent template assumes one feedback decision (was this routing correct?). Multi-intent emails have N independent decisions, and the sender should be able to confirm intent 1, correct intent 2, and cancel intent 3 in one go. Trying to overload the single-intent template would either drop information or confuse the sender about which buttons map to which intent.

**Approval notification (T+admin-review) — extraction quality feedback:**

```
Subject: Your submission is live: NEAR-Fest XXXIX

Hi —

NEAR-Fest XXXIX is now live on meetmeatthefair.com:
https://meetmeatthefair.com/events/near-fest-xxxix

Some details may have been adjusted during review.

Does this listing look right?
  ✅ Looks good                    [signed URL → records 'correct']
  ✏️ Something needs fixing        [signed URL → corrections follow-up]

You can also reply to this email with any corrections.

— Meet Me at the Fair
```

The approval feedback is the higher-leverage of the two because it asks the question that matters most: did we represent the event accurately on the public site? Every "✏️ needs fixing" click is pure gold — sender is telling us exactly which events to look at.

#### D.3.2 Token mechanism

Each button is a signed URL:

```
https://meetmeatthefair.com/feedback/<token>?v=<feedback_value>
```

Token is generated when the email is sent. Structure: HMAC(secret, inbound_email_id + feedback_moment + feedback_value + timestamp), then base64url-encoded. Server-side lookup table:

```sql
CREATE TABLE inbound_email_feedback_tokens (
  token TEXT PRIMARY KEY,           -- base64url of HMAC(...)
  inbound_email_id TEXT NOT NULL,
  feedback_moment TEXT NOT NULL,    -- 'receipt' | 'approval' | 'other'
  resulting_event_id TEXT,          -- the event this feedback applies to (if any)
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- 60 days from issuance
  used_at INTEGER,                  -- once set, token is consumed
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id),
  FOREIGN KEY (resulting_event_id) REFERENCES events(id)
);
CREATE INDEX idx_feedback_tokens_email ON inbound_email_feedback_tokens(inbound_email_id);
CREATE INDEX idx_feedback_tokens_event ON inbound_email_feedback_tokens(resulting_event_id);
```

#### D.3.3 Feedback capture endpoint

`GET /feedback/<token>?v=<value>`

1. Verify token signature.
2. Look up token in `inbound_email_feedback_tokens`. Check not expired, not already used.
3. Write to `inbound_email_sender_feedback` (schema below).
4. Mark token `used_at`.
5. For non-destructive values (`correct`, `looks_good`) → confirmation page: "Thanks for letting us know."
6. For destructive values (`cancel`) → confirmation: "Done — your submission has been cancelled. The event will not be published."
7. For corrective values (`wrong_intent`, `needs_fixing`) → land on a follow-up form (B4 infrastructure, pre-filled with what we have) for them to provide more detail.

For `wrong_intent` follow-up, surface an intent-picker with the same taxonomy as C.1 so the sender can tell us what they meant. That picker output writes back to `inbound_email_intent_feedback` with `feedback_source = 'sender_feedback'`.

#### D.3.4 Sender feedback schema

```sql
CREATE TABLE inbound_email_sender_feedback (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  feedback_token TEXT NOT NULL UNIQUE,     -- the token they clicked
  feedback_moment TEXT NOT NULL,            -- 'receipt' | 'approval' | 'other'
  feedback_value TEXT NOT NULL,             -- 'correct' | 'wrong_intent' | 'needs_fixing'
                                            -- | 'cancel' | 'looks_good'
  intended_intent TEXT,                     -- if "wrong_intent", set by follow-up form
  free_text TEXT,                           -- optional reason from follow-up form
  resulting_event_id TEXT,                  -- the event this feedback is about (if any)
  submitted_at INTEGER NOT NULL,
  submitter_ip TEXT,                        -- for abuse detection
  submitter_user_agent TEXT,                -- for abuse detection
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id),
  FOREIGN KEY (resulting_event_id) REFERENCES events(id)
);
CREATE INDEX idx_sender_feedback_email ON inbound_email_sender_feedback(inbound_email_id);
CREATE INDEX idx_sender_feedback_moment ON inbound_email_sender_feedback(feedback_moment, feedback_value);
```

#### D.3.5 Security & abuse considerations

- **HMAC-signed tokens** — can't be forged without the secret.
- **One-time use** — `used_at` prevents replay. Clicking twice does nothing.
- **60-day expiration** — stale tokens auto-invalidate.
- **Rate-limit per IP** on `/feedback/<token>` — prevents thumbs-bombing or scanner abuse.
- **No internal IDs in URLs** — token IS the reference. inbound_email_id is server-side only.
- **Track IP + UA on click** — server-side, never shared, used for abuse detection only.
- **CAN-SPAM compliance** — include `List-Unsubscribe` header on all outbound. Feedback links don't count as marketing but the email should stay clean.
- **Don't auto-execute destructive actions from a click alone for unauthenticated senders.** The `cancel` path is OK because it's reverting an action the sender initiated; but anything that publishes to the public site should require admin confirmation regardless of sender feedback.

#### D.3.6 Expected click-through rates

Industry baseline for thumbs-up/down in transactional emails:

- **Receipt button CTR:** 1–3% across full sender population. Skews thumbs-down (users click to flag mistakes, less so to confirm correctness).
- **Approval button CTR:** 5–10% — higher because users have a real stake in the event being right when it goes live.

At MMATF's volume (~20–50 submissions/month assumed growth), that's:

- Receipt: ~0–2 explicit clicks/month
- Approval: ~1–5 explicit clicks/month

Low absolute volume, but **the data quality is high.** Every "✏️ needs fixing" click is worth more than 10 admin labels because it's the actual sender. Asymmetric signal — biases toward unhappy users — which is fine because unhappy clicks are exactly what we want to learn from.

#### D.3.7 Failure modes

1. **Senders who don't trust the system enough to click.** Persistent zero-CTR from a sender cluster is its own signal — they're not engaging because either the email looks fake (phishing concerns), or they don't think clicking will matter, or they don't read replies. Track CTR by sender trust tier (B6) to detect.
2. **Confirmation-bias by sender.** A sender might click "looks good" without actually looking. Mitigation: occasionally cross-check sender-confirmed events against later admin corrections.
3. **Misclick or accidental clicks.** Mitigated by the one-time-use token + the confirmation page for destructive actions (especially `cancel`).
4. **Forwarded emails.** Someone forwards the auto-reply to a colleague who clicks. The token will record the click but the IP/UA will be different. Probably OK — the original sender did intend to forward, so they're delegating feedback authority. Worth surfacing in admin if forwarded-click rate is suspiciously high.
5. **Scanner pre-clicks.** Some email security products pre-click links to check them. Mitigation: don't record a click as feedback if the user-agent matches known security scanners (Microsoft Safe Links, Mimecast, Proofpoint, etc.). Token still gets marked `used_at` to prevent later real-user click, but feedback row not written. Worth surfacing in admin as a separate "scanner-clicked" metric.

### D.4 Aggregation & continuous improvement

**Estimated effort:** ~3 hours (initial dashboard) + ongoing operational time for quarterly review

#### D.4.1 Weekly admin dashboard

Add to `/admin/analytics` (or `/admin/inbound-emails`):

- **Classifier accuracy (rolling 30d)** — % of classifications with no correction filed. Operational health.
- **Disagreement rate by intent class** — which intents are getting reclassified most? Heatmap.
- **Top 10 disagreement patterns** — "Emails with X (subject pattern, from-domain, body keyword) were classified as Y but corrected to Z N times". Drives prompt refinement.
- **classifier_version comparison** — accuracy by version, lets us A/B safely.
- **Feedback CTR** — what % of sent emails get sender-feedback clicks. Engagement health.
- **Feedback positive/negative ratio** — sentiment of sender feedback.

#### D.4.2 Quarterly prompt refinement cadence

**Triggered when:** dataset hits 50+ labeled disagreements OR 3 months elapsed since last refinement, whichever comes first.

**Process:**

1. **Pull the labeled dataset.** All rows from `inbound_email_intent_feedback` since last refinement, ordered by `feedback_source` priority (sender_feedback > admin_reroute > workflow_outcome > admin_label).
2. **Pattern identification.** Cluster the disagreements by the inputs they share (subject patterns, body keywords, from-domain patterns). Either manually or with an LLM summarization helper.
3. **Draft prompt revision.** Update the classifier prompt to address the top patterns. Two paths:
   - Manual: admin reviews and writes the update.
   - LLM-assisted: feed the disagreement examples to a meta-prompt: "Here are 30 examples where the classifier got it wrong. Suggest a prompt revision that would have caught these without regressing on the examples below..."
4. **Regression test.** Run the new prompt against a held-out set of ~5 known-good examples per intent class. Any failure = abort revision.
5. **A/B deploy.** Bump `classifier_version`. Optionally route 10–20% of traffic through the new version for 2 weeks to confirm no production regression before full cutover.
6. **Document.** Write the revision rationale into a comment in the prompt file or a dated changelog entry. Future-us will want to know why a specific instruction is there.

#### D.4.3 Meta-leverage point

**The schema is generic by design.** `inbound_email_intent_feedback` is just one consumer of the pattern. The same loop applies to:

- **Extraction quality feedback** — when admin corrects an extracted event field (venue, date, ticket_url), record original vs. corrected with `extraction_version`. New table: `inbound_email_extraction_feedback`. Same shape, different column names.
- **JSON-LD parser feedback (A4)** — when JSON-LD extraction goes wrong, capture which field, which page, which parser version.
- **Free-text extraction feedback (B2)** — same loop, different column subset.

The classifier is the FIRST AI decision where the cost of wrongness is high enough to justify the substrate. Once Part D exists for the classifier, extending it to extraction is mostly schema + UI work (~3–4 hours per additional AI step).

---

## Schema changes summary

### New tables

```sql
-- Feedback events tied to AI classification decisions
CREATE TABLE inbound_email_intent_feedback (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  feedback_source TEXT NOT NULL,        -- 'admin_reroute' | 'admin_label' | 'workflow_outcome'
                                        -- | 'sender_feedback' | 'user_reply'
  original_intent TEXT,                 -- what the classifier picked (NULL if active label)
  corrected_intent TEXT NOT NULL,       -- ground truth (per the source)
  classifier_version TEXT,              -- which classifier version produced original
  admin_note TEXT,                       -- optional, from D.1 UI
  created_by TEXT,                      -- admin user_id when admin-sourced, NULL otherwise
  created_at INTEGER NOT NULL,
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id)
);
CREATE INDEX idx_intent_feedback_email ON inbound_email_intent_feedback(inbound_email_id);
CREATE INDEX idx_intent_feedback_source ON inbound_email_intent_feedback(feedback_source);
CREATE INDEX idx_intent_feedback_version ON inbound_email_intent_feedback(classifier_version);
CREATE INDEX idx_intent_feedback_created ON inbound_email_intent_feedback(created_at);

-- Raw sender click events (source of D.3 truth, fans out into intent_feedback)
CREATE TABLE inbound_email_sender_feedback (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  feedback_token TEXT NOT NULL UNIQUE,
  feedback_moment TEXT NOT NULL,        -- 'receipt' | 'approval' | 'other'
  feedback_value TEXT NOT NULL,         -- 'correct' | 'wrong_intent' | 'needs_fixing'
                                        -- | 'cancel' | 'looks_good'
  intended_intent TEXT,                 -- if "wrong_intent", from follow-up form
  free_text TEXT,                       -- from follow-up form
  resulting_event_id TEXT,
  submitted_at INTEGER NOT NULL,
  submitter_ip TEXT,
  submitter_user_agent TEXT,
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id),
  FOREIGN KEY (resulting_event_id) REFERENCES events(id)
);
CREATE INDEX idx_sender_feedback_email ON inbound_email_sender_feedback(inbound_email_id);
CREATE INDEX idx_sender_feedback_moment ON inbound_email_sender_feedback(feedback_moment, feedback_value);

-- Token lifecycle for sender feedback URLs
CREATE TABLE inbound_email_feedback_tokens (
  token TEXT PRIMARY KEY,               -- base64url(HMAC(secret, ...))
  inbound_email_id TEXT NOT NULL,
  feedback_moment TEXT NOT NULL,
  resulting_event_id TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id),
  FOREIGN KEY (resulting_event_id) REFERENCES events(id)
);
CREATE INDEX idx_feedback_tokens_email ON inbound_email_feedback_tokens(inbound_email_id);
CREATE INDEX idx_feedback_tokens_event ON inbound_email_feedback_tokens(resulting_event_id);
CREATE INDEX idx_feedback_tokens_expires ON inbound_email_feedback_tokens(expires_at);
```

### Modify: `inbound_emails`

```sql
-- Classifier output (Part C)
ALTER TABLE inbound_emails ADD COLUMN classified_intent TEXT;
ALTER TABLE inbound_emails ADD COLUMN classified_sub_intent TEXT;
ALTER TABLE inbound_emails ADD COLUMN classified_confidence REAL;
ALTER TABLE inbound_emails ADD COLUMN classified_rationale TEXT;
ALTER TABLE inbound_emails ADD COLUMN classified_at INTEGER;
ALTER TABLE inbound_emails ADD COLUMN classifier_version TEXT;

-- Routing decision (Part C)
ALTER TABLE inbound_emails ADD COLUMN routing_source TEXT;
  -- 'classifier' | 'classifier_override' | 'fallback_low_confidence'
  -- | 'trusted_fastpath' | 'address_only'
ALTER TABLE inbound_emails ADD COLUMN routed_to_workflow TEXT;

-- Admin review flag (Part D.1)
ALTER TABLE inbound_emails ADD COLUMN flagged_for_review INTEGER DEFAULT 0;
```

---

## API surface summary

### New public routes (Part D.3)

- `GET /feedback/[token]?v=[value]` — record sender feedback click, return confirmation page
- `GET /feedback/[token]/followup` — pre-filled correction/intent-correction form (reuses B4 infrastructure when B4 ships)
- `POST /feedback/[token]/followup` — submit follow-up details

### New admin routes (Part D.1)

- `POST /api/admin/inbound-emails/[id]/reclassify` — admin reclassification action; writes to `inbound_email_intent_feedback`
- `POST /api/admin/inbound-emails/[id]/mark-correct` — admin active-label action
- `POST /api/admin/inbound-emails/[id]/flag-for-review` — admin flag for next prompt review

### New admin MCP tools (optional — Cowork can use the API routes instead)

- `mcp__mmatf__get_classifier_accuracy(days?: number)` — returns rolling accuracy metrics
- `mcp__mmatf__list_classifier_disagreements(since?: date, intent?: string)` — pulls labeled dataset
- `mcp__mmatf__get_sender_feedback_summary(days?: number)` — CTR + sentiment by feedback_moment

---

## Test plan

### Part C — Classifier tests

| #   | Email shape                                                                          | Expected intent              | Expected sub_intent | Expected confidence | Notes                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------ | ---------------------------- | ------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `submit@`, single URL to event page                                                  | `new_event`                  | `single_url`        | ≥0.85               | Canonical happy path                                                                                                                                           |
| 2   | `submit@`, 3 URLs to different event pages                                           | `new_event`                  | `multi_url`         | ≥0.85               | B1 routing target                                                                                                                                              |
| 3   | `submit@`, no URL, prose "Holiday craft fair at Bangor Library Dec 12"               | `new_event`                  | `free_text`         | ≥0.85               | B2 routing target                                                                                                                                              |
| 4   | `submit@`, no URL, PDF flyer attachment only                                         | `new_event`                  | `attachment_only`   | ≥0.85               | B7 routing target (Phase 3)                                                                                                                                    |
| 5   | `submit@`, body contains `meetmeatthefair.com/events/SLUG`, says "the date is wrong" | `correction`                 | NULL                | ≥0.85               | classifier_override — routes to corrections despite submit@                                                                                                    |
| 6   | `support@`, "How do I list my booth?"                                                | `vendor_inquiry`             | NULL                | ≥0.7                |                                                                                                                                                                |
| 7   | `hello@`, "Writing for The Boston Globe..."                                          | `press`                      | NULL                | ≥0.7                |                                                                                                                                                                |
| 8   | `submit@`, "I am the organizer of this event, how do I claim it"                     | `claim_request`              | NULL                | ≥0.7                |                                                                                                                                                                |
| 9   | Any address, "stop emailing me"                                                      | `unsubscribe`                | NULL                | ≥0.95               |                                                                                                                                                                |
| 10  | Pharma-spam keywords + suspicious URL                                                | `spam`                       | NULL                | ≥0.9                | No auto-reply                                                                                                                                                  |
| 11  | `submit@`, "Hi, just saying thanks"                                                  | `unclear`                    | NULL                | <0.85               | Falls back to to_address, flagged for admin                                                                                                                    |
| 12  | Reply to our `notify@` thread containing "thanks, looks good"                        | `correction` or `support`    | NULL                | varies              | `is_reply_to_our_thread = true` should weight toward not-new-event                                                                                             |
| 12a | "I discovered a website listing events at mainemade.com" (no other content)          | `source_suggestion`          | NULL                | ≥0.85               | C.8 dedup-then-cross-check: should find 62 informal-usage events, surface registration prompt to admin                                                         |
| 12b | Body has mainemade.com URL + facebook.com event URL + "Lilac Festival date is wrong" | multi-intent (3 children)    | varies              | varies              | C.5 pre-check triggers full classifier even for trusted sender; classifier splits into 3 children; each routes independently                                   |
| 12c | "The date for the Lilac Festival at Viles Arboretum appears to be incorrect"         | `correction`                 | NULL                | ≥0.85               | C.9 disambiguation: pre-2026-05-19 cleanup would have surfaced 2 matches (Lilac Festival + duplicate Augusta variant) — verify the disambiguation prompt works |
| 12d | Body submits a URL to an already-rejected MMATF event slug                           | `correction` (lookup tier 1) | NULL                | varies              | C.9 tier 1: reply "the event at this URL has been removed; could you tell us what you meant?"                                                                  |

### Part D — Feedback infrastructure tests

| #   | Test description                                                               | Expected behavior                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | Admin reclassifies a submission from new_event to correction via D.1 UI        | Row written to `inbound_email_intent_feedback` with `feedback_source='admin_reroute'`; classifier accuracy metric updates                                                                                        |
| 14  | Admin clicks "Mark as correctly classified" on low-confidence classification   | Row written with `feedback_source='admin_label'`, `corrected_intent = original_intent`                                                                                                                           |
| 15  | Sender clicks 👍 "Yes, submit my event" on receipt email                       | Token marked used; row in `inbound_email_sender_feedback` with `feedback_value='correct'`; row in `inbound_email_intent_feedback` with `feedback_source='sender_feedback'`, `corrected_intent = original_intent` |
| 16  | Sender clicks ✏️ "I meant something else", follow-up form picks correct intent | Two-step capture; final intent feedback row has the sender's chosen intent                                                                                                                                       |
| 17  | Sender clicks ❌ "Cancel" on receipt email                                     | PENDING event status changes to CANCELLED-by-sender; confirmation page shown                                                                                                                                     |
| 18  | Sender clicks 👍 "Looks good" on approval email                                | Row in sender_feedback with `feedback_moment='approval'`, `feedback_value='looks_good'`                                                                                                                          |
| 19  | Sender clicks ✏️ "Something needs fixing" on approval email                    | Follow-up form launches; admin gets notified that a published event needs review                                                                                                                                 |
| 20  | Token reused (clicked twice)                                                   | Second click → "Already recorded" page; no duplicate row                                                                                                                                                         |
| 21  | Expired token clicked (>60 days)                                               | Friendly "This link has expired — please reply to the original email if you have feedback"                                                                                                                       |
| 22  | Forged token (bad signature)                                                   | 404; no row written                                                                                                                                                                                              |
| 23  | Microsoft Safe Links / known scanner UA clicks token                           | Token consumed (marked `used_at`) but feedback row NOT written; surface in admin "scanner-clicked" metric                                                                                                        |
| 24  | High-rate clicks from one IP                                                   | Rate-limit triggers after N requests; subsequent clicks rejected                                                                                                                                                 |

### Manual verification queries

```sql
-- Classifier accuracy (rolling 30d)
WITH classifications AS (
  SELECT id, classified_intent, classifier_version
  FROM inbound_emails
  WHERE classified_at > unixepoch() - 30*86400
    AND classified_intent IS NOT NULL
),
corrections AS (
  SELECT DISTINCT inbound_email_id
  FROM inbound_email_intent_feedback
  WHERE feedback_source IN ('admin_reroute', 'sender_feedback')
    AND corrected_intent != original_intent
)
SELECT
  classifier_version,
  COUNT(*) AS total_classifications,
  COUNT(*) - COUNT(c.inbound_email_id) AS uncorrected,
  ROUND(100.0 * (COUNT(*) - COUNT(c.inbound_email_id)) / COUNT(*), 1) AS accuracy_pct
FROM classifications cls
LEFT JOIN corrections c ON c.inbound_email_id = cls.id
GROUP BY classifier_version;

-- Top disagreement patterns by intent class
SELECT
  original_intent,
  corrected_intent,
  COUNT(*) AS n
FROM inbound_email_intent_feedback
WHERE feedback_source IN ('admin_reroute', 'sender_feedback')
  AND created_at > unixepoch() - 90*86400
GROUP BY original_intent, corrected_intent
ORDER BY n DESC;

-- Sender feedback CTR
SELECT
  feedback_moment,
  COUNT(DISTINCT t.token) AS tokens_issued,
  COUNT(DISTINCT t.used_at) AS tokens_used,
  ROUND(100.0 * COUNT(DISTINCT t.used_at) / COUNT(DISTINCT t.token), 1) AS ctr_pct
FROM inbound_email_feedback_tokens t
WHERE t.issued_at > unixepoch() - 30*86400
GROUP BY feedback_moment;

-- Positive vs negative sender sentiment
SELECT
  feedback_moment,
  feedback_value,
  COUNT(*) AS n
FROM inbound_email_sender_feedback
WHERE submitted_at > unixepoch() - 30*86400
GROUP BY feedback_moment, feedback_value
ORDER BY feedback_moment, n DESC;

-- Workflow outcome accuracy by intent
SELECT
  ie.classified_intent,
  COUNT(*) AS total,
  SUM(CASE WHEN e.status = 'APPROVED' THEN 1 ELSE 0 END) AS approved,
  SUM(CASE WHEN e.status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
  ROUND(100.0 * SUM(CASE WHEN e.status = 'APPROVED' THEN 1 ELSE 0 END) / COUNT(*), 1) AS approval_pct
FROM inbound_emails ie
LEFT JOIN events e ON e.id = ie.created_event_id  -- assumes this FK exists; if not, query via inbound_email_id
WHERE ie.classified_intent = 'new_event'
  AND ie.classified_at > unixepoch() - 30*86400
GROUP BY ie.classified_intent;
```

---

## Rollout plan

Three independent phases. Each can ship and be validated before the next starts.

### Phase C.1 — Smart classifier (Part C) — ~1 dev day

Ship the classifier + routing gate + spam quarantine + reply-chain detection. Do NOT add D.3 sender widgets yet. Use admin D.1 reclassification (manual labeling) as the only feedback source for the first 2 weeks. This lets the classifier accumulate a baseline accuracy measurement on real production traffic without the complexity of sender widgets.

Validation: classifier accuracy ≥80% on the first 50 real submissions, measured via admin's manual reclassifications.

### Phase D.1 — Feedback substrate (Part D.1 + D.2 + initial D.4 dashboard) — ~1 dev day

Ship the schemas, admin reclassification UI, workflow outcome inference, and the weekly accuracy dashboard. Classifier already running from Phase C.1 — this just turns on capture + visibility.

Validation: `inbound_email_intent_feedback` table starts accumulating rows from admin actions. Accuracy badge appears on admin pages.

### Phase D.2 — Sender feedback widgets (Part D.3) — ~half day to a day

Ship the token table, HMAC signing, public feedback endpoints, and add buttons to the receipt + approval email templates. Watch CTR for 30 days.

Validation: feedback tokens being issued + first sender clicks captured. Compare sender feedback against admin labels for the same emails — early signal on alignment.

### Phase D.3 — Quarterly refinement cadence (Part D.4) — ongoing operational

After the dataset hits 50+ labeled disagreements OR 3 months elapsed, run the first refinement cycle. No code change required for this — it's a process the admin (or Cowork session) executes.

### Future — extend Part D to other AI steps

Once the substrate is proven for the classifier, extend the same pattern to extraction quality, JSON-LD parsing, etc. Each extension is ~3–4 hours of schema + UI work.

---

## Open questions

1. **Confidence threshold tuning (Q1).** The 0.85 threshold is a guess. Calibrate against the first 100 production classifications. Look for the threshold that minimizes (false-route rate + admin-rework rate) on the labeled subset.

2. **Model choice (Q2).** Which Workers AI model? Probably the same one the extraction step uses for consistency, but benchmark accuracy vs. cost on a small test set first. Sub-question: should the classifier be a separate model from the extractor (cleaner separation, more inferences) or a joint classify-and-extract model (single inference, but errors compound)? Recommendation: separate, at least until joint shows measurable cost/quality wins.

3. **Multi-intent emails (Q3) — RESOLVED 2026-05-19.** Real-world test case (John's email containing source suggestion + Facebook URL submission + Lilac Festival correction in one message) confirmed multi-intent is common enough to design for from the start. **Decision: ship v2 multi-intent splitting in v1 of this spec.** Classifier returns an array of child intents; each spawns its own `inbound_emails` row with `parent_email_id` linking to the original message; each routes to its own workflow; sender receives a single multi-section receipt email (per D.3 multi-intent template) with per-intent feedback widgets. Cap at 4 intents per email; 5+ escalates to admin. The earlier "escalate to admin in v1" position was too conservative — would have silently dropped 2 of 3 intents in the canonical test case.

4. **Sender feedback weighting (Q4).** When sender feedback disagrees with admin label on the same email, sender wins. But what about admin overrides of sender feedback ("the sender said `wrong_intent` but they meant something different than they think")? Recommendation: sender feedback always wins for ground truth, but admin can add a note flagging when they think the sender misunderstood. Both rows persist; downstream analysis can decide which to weight.

5. **Implicit signal weights (Q5).** PENDING-approved-without-change is weak positive; "Mark as correctly classified" is medium positive; sender 👍 is strong positive. What's the relative weight in aggregate accuracy calculation? Recommendation: count all positive signals equally for the baseline accuracy metric; surface the breakdown separately so admin can see source mix.

6. **Spam handling escalation (Q6).** What's the threshold for adding a spam sender to the `blocked` trust tier (B6) automatically? Recommendation: 3 spam classifications with confidence ≥0.95 within 30 days. Below that threshold, admin reviews via the daily digest.

7. **Reply-chain false positives (Q7).** What if a sender starts a NEW submission by replying to an old thread because that's the most recent email from us in their inbox? The classifier should still detect this from the content. But the `is_reply_to_our_thread=true` flag might bias toward correction. Recommendation: surface this case in admin queue with both interpretations until we have enough data to tune.

8. **Sender feedback scanner-click handling (Q8).** Microsoft Safe Links and other email security products pre-fetch links. We don't want their clicks counted as feedback. Recommendation: maintain a known-scanner UA list; clicks from those UAs consume the token (mark `used_at`) but don't write a feedback row. Surface scanner-click rate in admin so we can detect new scanners as they emerge.

9. **CAN-SPAM compliance for feedback emails (Q9).** Feedback links don't make the email "marketing" per CAN-SPAM, but worth a legal check. The `List-Unsubscribe` header should be present on all auto-reply emails regardless.

10. **Extension to extraction-quality feedback (Q10).** Should the "Looks good" / "Something needs fixing" buttons on the approval email be in scope for this spec (Part D.3) or a follow-up? Recommendation: in scope. The approval-email button is the highest-leverage piece of D.3 because it's the moment when the sender has the most stake. Even if the classifier feedback loop (receipt button) ships first, the approval-email button should follow soon after.

---

## Reference: canonical test cases

### Classifier-routing test cases (drawn from real submissions)

| Inbound email                                                                             | Expected classification                            | Notes                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `jtarboxme@gmail.com` → `submit@`, body `https://near-fest.com/`                          | `new_event` / `single_url` / conf ≥0.9             | The original Phase 2 canonical case; classifier should pick this confidently              |
| `jtarboxme@gmail.com` → `submit@`, body `https://www.ham-con.org/`                        | `new_event` / `single_url` / conf ≥0.9             | Currently fails at fetch step (A5 fix queued); classifier should still classify correctly |
| `scott@cfnparts.com` → `corrections@`, "NHAC is not sponsoring any events on June 7th"    | `correction` / conf ≥0.85                          | Elizabeth Marston's real correction email 2026-05-18                                      |
| `jtarboxme@gmail.com` → `submit@`, body has Starling Hall event URL + extra prose details | `new_event` / `single_url` or `mixed` / conf ≥0.85 | Garden & Craft Fair / Breakfast with Bake Sale series                                     |

### Sender feedback test cases (forward-looking)

When the next NEAR-Fest XXXIX-style submission goes through the full pipeline:

1. Sender clicks ✅ on receipt → row in `inbound_email_intent_feedback` with `feedback_source='sender_feedback'`, `original_intent='new_event'`, `corrected_intent='new_event'` (confirming).
2. After admin approves and sends the approval email, sender clicks ✏️ "Something needs fixing" → follow-up form launches, sender writes "wrong end date" → row in `inbound_email_sender_feedback` with `feedback_moment='approval'`, `feedback_value='needs_fixing'`, `free_text='wrong end date'`, AND admin gets notified that a live event needs review.

### Workflow outcome inference test cases

Already-shipped events in the database that can validate the Part D.2 logic:

- Event `8b75454a` (NEAR-Fest XXXIX) — manually corrected, then approved. Would be implicit positive for `new_event` classification.
- Event `3b4c0694` (NHAC Gun Collectors Show June, REJECTED 2026-05-18) — implicit negative for `new_event` because the rejection reason was "not a real event" (phantom from multi-row PDF conflation).
- Event `1df6b84` (Lilac Festival Augusta duplicate, REJECTED 2026-05-19) — implicit negative for `new_event` because rejection reason was "duplicate of canonical row." Useful test of C.9 disambiguation handling latent duplicates.

### Multi-intent canonical case (Lilac Festival email, 2026-05-19)

The email that prompted the spec edits in this revision:

```
Body: "I discovered a website listing several events at https://www.mainemade.com/events/
       I also found a new event at https://www.facebook.com/groups/.../posts/.../
       Finally the date you have for the Lilac Festival at Viles Arboretum appears
       to be incorrect.
       Thank you"
```

Expected classifier output (v2 multi-intent):

```json
{
  "intents": [
    {
      "intent": "source_suggestion",
      "ref_url": "https://www.mainemade.com/events/",
      "confidence": 0.92
    },
    {
      "intent": "new_event",
      "sub_intent": "single_url",
      "ref_url": "https://www.facebook.com/groups/1153215062185626/posts/1659624181544709/",
      "confidence": 0.88
    },
    {
      "intent": "correction",
      "ref_event_clue": "Lilac Festival at Viles Arboretum",
      "ref_field": "date",
      "confidence": 0.91
    }
  ]
}
```

Expected downstream behavior:

1. **C.8 source_suggestion handler:** queries discovery_candidates for mainemade.com (no match) → queries events.source_url (62 matches) → replies with "we already use this informally, registering formally" + auto-inserts row in discovery_candidates with `status='pending_review'`.
2. **A5 + Facebook fallback:** standard fetch fails (FB 403) → A5 Browser Rendering also fails (FB fingerprints managed Chrome) → graceful failure reply "we can't read Facebook URLs; please paste details into [B4 form]."
3. **C.9 correction handler (pre-2026-05-19 state):** lookup returns 2 matches for "Lilac Festival at Viles Arboretum" → triggers disambiguation prompt → surfaces latent duplicate to admin → admin resolves (as done manually 2026-05-19: rejected duplicate, applied A3 noon-UTC backfill to canonical row).
4. **Multi-intent receipt template:** single email to John with 3 sections + per-intent feedback widgets.

After 2026-05-19's manual cleanup, only step 3 produces a different outcome (single match now). Steps 1, 2, 4 are independent of the database state at the moment of email receipt and would behave identically.

---

## Effort summary

| Phase            | Component                                                                  | Effort                           |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------- |
| C.1              | Classifier + prompt + routing gate (multi-intent output)                   | ~3 hrs                           |
| C.1              | Spam handling + admin daily digest                                         | ~1 hr                            |
| C.1              | Reply-chain detection                                                      | ~1 hr                            |
| C.1              | Trusted-sender fastpath + regex pre-check (C.5)                            | ~1 hr                            |
| C.1              | Multi-intent child-row spawning                                            | ~1.5 hrs                         |
| C.1              | `source_suggestion` workflow handler (C.8 dedup-cross-check)               | ~1.5 hrs                         |
| C.1              | `correction` workflow handler with disambiguation (C.9 + C.10 drift check) | ~2 hrs                           |
| C.1              | Schema migrations for Part C                                               | ~30 min                          |
| C.1              | Test cases + production validation                                         | ~1.5 hrs                         |
| **C.1 subtotal** |                                                                            | **~11–14 hrs (~1.5 days)**       |
| D.1              | Schema migrations for Part D                                               | ~30 min                          |
| D.1              | Admin reclassification UI                                                  | ~3 hrs                           |
| D.1              | Workflow outcome inference job                                             | ~3 hrs                           |
| D.1              | Initial accuracy dashboard                                                 | ~3 hrs                           |
| **D.1 subtotal** |                                                                            | **~9–10 hrs (~1 day)**           |
| D.3              | Token table + HMAC signing util                                            | ~1 hr                            |
| D.3              | Public feedback endpoints                                                  | ~2 hrs                           |
| D.3              | Email template additions (receipt + approval)                              | ~1 hr                            |
| D.3              | Follow-up form integration                                                 | ~1 hr                            |
| D.3              | Rate-limit + scanner-click handling                                        | ~1 hr                            |
| **D.3 subtotal** |                                                                            | **~4–6 hrs (~½–1 day)**          |
| **TOTAL**        |                                                                            | **~24–30 hrs (~3–3.5 dev days)** |

D.4 quarterly refinement is operational (no fixed dev time; ~2 hrs of admin/Cowork time per cycle).

---

## Dependency notes

**Hard dependencies on already-shipped infrastructure:**

- B6 sender trust system (shipped 2026-05-18) — Part C reads `sender_trust_tier`
- Inbound email pipeline + `inbound_emails` table (shipped 2026-05-17) — Part C adds columns; Part D adds related tables
- Approval-notification email infrastructure (shipped 2026-05-18 as a bonus) — D.3 adds buttons to it
- `/admin/inbound-emails` page (shipped 2026-05-18) — D.1 adds affordances to it

**Soft dependencies on queued work:**

- Phase 2A.5 (A2 follow-up, A4 JSON-LD, A5 Browser Rendering) — independent of this spec; can ship in any order
- Phase 2B (B1 multi-URL, B2 free-text, B3 confidence tiers, B4 pre-filled form) — Part C provides the routing branch B1/B2/B7 need; ideally Part C ships first so those workflows have a classifier to dispatch them
- B7 (attachment OCR, Phase 3) — needs `new_event` / `attachment_only` sub-intent from Part C to route correctly

**No new dependencies introduced.**

---

## Why this matters

Today the email pipeline is a single workflow that assumes its input shape. Tomorrow it's a routing system with feedback loops that gets better over time. Three distinct values:

1. **Recoverability.** Misdirected emails (correction to submit@, etc.) stop falling on the floor. Sender behavior doesn't have to match our address taxonomy.
2. **Capability unlock.** B1, B2, B7 need a routing branch; the classifier provides it. Without Part C, those features each need to do their own classification, duplicating work.
3. **Compounding accuracy.** Every quarter the classifier (and eventually extraction, JSON-LD parser, etc.) gets measurably better because the feedback substrate makes the improvement loop concrete instead of anecdotal. The first improvement is the smallest; future ones build on a richer dataset.

The sender feedback widgets specifically are the load-bearing element of the long-term flywheel. Admin labels age out as admin attention shifts; sender feedback is durable ground truth. A small but consistent stream of sender clicks over 12 months produces a dataset that no amount of admin labeling time can match for trustworthiness.
