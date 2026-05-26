# Reply to the analyst — inbound-email work cluster

Hi —

All four items shipped today, plus the five follow-ups we'd flagged. 15 PRs landed (`#184–#198`, no gaps). Production is in the state you'd hoped for, with some surprises along the way worth knowing about.

## Item 1 — Stale-sweep "regression"

**Not actually a regression.** Diagnosis against prod D1 showed the row you flagged (`2f5f0c74`, Boxboro) had in fact been recovered four times by the sweep before settling at `status=failed reply_kind=extract-failed` — auto-reply went out, no row stuck. The real cost was five wasted workflow runs on a deterministic `hamxposition.org` AI-extract failure (the root URL has no extractable event content; the AI keeps returning `NonRetryableError: extract-upstream`).

**What shipped (PR-A #184):**

- `drizzle/0082` adds `inbound_emails.recovery_attempt_n`. Sweep increments per recovery.
- At `recovery_attempt_n >= 3`, sweep marks the row terminally failed with new reply kind `sweep-exceeded` and sends a final auto-reply. Cuts the loop the sweep docblock was already warning about.
- Per-run heartbeat row in `error_logs` (info level). Source `mcp:inbound-email:stale-sweep` previously had zero rows across 2 days of healthy operation because the code only logged on errors — indistinguishable from a non-running cron. Now visible.

## Item 2 — JSON-LD priority extraction

**Shipped (PR-B #185).** The HTML parser already extracted JSON-LD; the missing piece was the bypass. Now `/api/admin/import-url/extract` returns the JSON-LD-derived event directly with `extractionMethod='json-ld'` when a valid Event-schema node has `name + startDate + ≥1 of {location, description}`. The AI call is skipped entirely on those pages. `drizzle/0083` adds `inbound_emails.extraction_method`. Surfaced in `/admin/inbound-emails`.

Subtype detection widened from substring `.includes("Event")` (which false-positive matched `EventReservation`) to an explicit set: `Event`, `Festival`, `MusicEvent`, `FoodEvent`, `BusinessEvent`, `SocialEvent`, `ChildrensEvent`, `ComedyEvent`, and the rest of the schema.org Event subclass tree. Per your A-note: ticketUrl does NOT default to sourceUrl on the JSON-LD path.

## Item 3 — Intelligence audit + follow-ups

**Audit answers (verified against source 2026-05-21):**

| Piece                         | Status at audit time | After this PR cluster                         |
| ----------------------------- | -------------------- | --------------------------------------------- |
| (a) Multi-intent splitting    | Built                | Unchanged                                     |
| (b) source_suggestion 3-tier  | Partial              | **Full 3-tier shipped, PR-D #187**            |
| (c) correction Tier 2+3       | Partial              | **Tier 2 fuzzy shipped, PR-K #194**           |
| (d) Spam handling             | Built                | Unchanged                                     |
| (e) Reply-chain detection     | Built                | Unchanged                                     |
| (f) Admin reclassification UI | Built                | Unchanged                                     |
| (g) Accuracy dashboard        | Partial              | **Weekly trend + heatmap shipped, PR-O #198** |

**(b) 3-tier source_suggestion** (PR-D): new `email_source_suggestions` table (renamed from `discovery_candidates` after a prod collision — see incidents below), Tier 1 lookup, Tier 2 informal `events.source_url` check, Tier 3 fresh-suggestion INSERT. Admin endpoint at `/api/admin/email-source-suggestions` for approve/reject; full UI page deferred.

**(c) correction Tier 2 fuzzy** (PR-K): when no slug URL in body, use the email subject as a name candidate (Gmail preserves it on reply) and run `combinedSimilarity` against `events.name`. Single match ≥0.85 with clear runner-up gap auto-resolves; matches ≥0.75 surface as candidates in `admin_actions` payload for waitForEvent disambiguation. Spec's separate Tier 3 collapsed into Tier 2 — `inbound_email_senders` doesn't actually have a dominant-state field, so the state-filtered tier had no input. If that signal lands later, easy seam.

**(g) weekly accuracy dashboard** (PR-O): new page `/admin/classifier-accuracy`, new endpoint `/api/admin/inbound-emails/classifier-stats/weekly`. Inline SVG line chart per classifier_version over 12 weeks (no charting dep), top-5 disagreement pairs, CSS-grid heatmap of the full disagreement matrix.

**Classifier model/timeout (your one-issue):** This was the biggest surprise — see the incidents section. Net result: reverted to `llama-3.1-8b-instruct` at 4000ms timeout. `CLASSIFIER_VERSION` = `c-2026-05-21-v3`. The 3B model wasn't usable for this prompt without more work than was scoped here; the cost-saving swap is deferred until someone can trace its actual response shape.

## Item 4 — Phase 2 remainder

All five sub-items shipped:

- **A2 venue fuzzy** (PR-C #186): `autoLinkVenue` now has a Tier 3 between exact-name and address-only — same-bag (token-set equality) for reorderings + `combinedSimilarity` for typos. 2+ candidates write an `admin_actions` row tagged `venue.ambiguous_match` instead of silently picking. First main-app test that runs against in-memory better-sqlite3 (pattern at `src/lib/__tests__/venue-matching-autolink.test.ts` if it's useful elsewhere).
- **B1 multi-URL** (PR-M #196): when classifier flags `sub_intent='multi_url'` AND ≥2 URLs extracted, workflow runs `submit/multi[i]/{fetch,extract,dedup,submit}` per URL sequentially and sends ONE combined `ok-multi` reply listing all outcomes. Cap 10; overflow note appended at 10+. Deferred to a follow-up: writing per-URL child rows with `parent_email_id` (the analyst's full spec). Current "parent row + first-event link + per-URL source_url lookup" is good enough for v1.
- **B2 free-text** (PR-E #188): when classifier flags `sub_intent='free_text'` AND no URL AND body has substantive text, body fed directly to AI extract with signature stripping (RFC 3676 `-- ` + iOS/Outlook mobile sigs). `extractionMethod='free-text'`.
- **B3 confidence-aware reply** (PR-E #188): three new reply kinds — `ok` (HIGH), `ok-medium`, `ok-low`. Tier picked from min field confidence over `name + startDate + venueName`. MEDIUM/LOW templates name the unsure fields. Per the real-world `nobarc.org` test, PR-L #195 also dropped the quoted event name from the opening when name is unsure (avoiding the "Thanks for submitting 'Next Business Meeting' … the event name was hard to pin down" contradiction).
- **B4 pre-filled form** (PR-N #197): `drizzle/0085 submission_correction_tokens` (32-byte random base64url, 30-day TTL, one-time use). New public route `/submit-event/[token]` renders an edit form pre-filled with the event's extracted values; POST atomically consumes the token and updates the events row. MEDIUM/LOW reply templates now include the form link when issuance succeeds (fall back to prose ask on failure).

## Production incidents caught + resolved

Three issues surfaced during deploys. Each got hotfixed; all are in this PR ladder.

1. **`discovery_candidates` table collision (~10 min impact, no traffic).** PR-D's `drizzle/0084` tried to CREATE a table that already existed in prod (24 rows, owned by an unrelated harvest-rules feature). The migration silently failed and the source-suggestion code path would have crashed on the next email. Caught by post-deploy verification, not by CI (no integration test against the real prod schema). PR-F #189 renamed to `email_source_suggestions` and ALSO added a missing `db:migrate:prod` job to `.github/workflows/deploy.yml` — prior to today, schema migrations were applied manually. Memory entry: `feedback_verify_table_doesnt_exist_before_create.md`.

2. **Classifier crash on the new 3B model (~3hr impact, ~3 emails lost).** PR-D swapped the classifier model from llama-3.1-8b to llama-3.2-3b. The 3B model returned `.response` as a non-string in some cases (likely a structured-output array); the previous code did an unsafe `as { response?: string }` cast and the non-string crashed `parseClassifierResponse` on `.replace`. Every inbound email between 15:01 UTC (deploy) and 16:35 UTC (hotfix deploy) crashed at the entrypoint, dropping the email entirely (no inbound_emails row, no auto-reply). Cloudflare Email Routing auto-retried some after the fix landed. PR-H #191 added a typeof guard for crash safety; PR-J #193 reverted to the 8B model since the 3B wasn't actually returning parseable JSON. Memory entry: `feedback_workers_ai_response_shape_varies_by_model.md`.

3. **Widget allowlist missed for new reply kinds (cosmetic).** PR-E added `ok-medium`/`ok-low` to the `ReplyKind` union and the buildReply switch but I forgot to add them to `RECEIPT_WIDGET_KINDS` in the workflow. First real-world `ok-medium` reply went out without the "was this what you wanted?" voting links. PR-I #192 fixed. Memory entry: `feedback_receipt_widget_allowlist_when_adding_reply_kinds.md`.

## Schema changes (all applied to prod)

- `drizzle/0082` — `inbound_emails.recovery_attempt_n`
- `drizzle/0083` — `inbound_emails.extraction_method`
- `drizzle/0084` — `email_source_suggestions` table (originally `discovery_candidates`)
- `drizzle/0085` — `submission_correction_tokens` table

Post-PR-F all four apply automatically via the new `d1-migrate` job. Verified end-to-end on PR-G's, PR-H's, PR-N's deploys.

## What's worth verifying in prod

I haven't sent test emails since shipping (you're the one driving those). Worth exercising:

- **B1**: 2-URL email → expect combined `ok-multi` reply with both outcomes
- **B4**: deliberately-vague URL → expect `ok-medium` reply with correction-form link; click it, edit, submit, verify event row updates and token marked used
- **Dashboard**: `/admin/classifier-accuracy` → expect chart showing per-version trends; verify the 3-hour outage window during PR-D→PR-J shows as zero/null buckets for `c-2026-05-22-v2`
- **Correction Tier 2**: send a correction-intent email with subject only ("Boxboro"), no slug URL → verify `admin_actions` payload has `tier='fuzzy-name'` and `candidates: [...]` with the HamXposition event

## Open follow-ups (nothing blocking)

- Per-URL child rows with `parent_email_id` for B1 (analyst's full spec; currently one parent row + first-event link).
- Per-event feedback widgets in `ok-multi` replies (currently one widget for the batch).
- 3B classifier model exploration: trace the actual `.response` shape, see if a `response_format` directive or prompt tweak can coerce plain JSON. PR-J reverted to 8B for correctness; 3B is cheaper if it can be made to work.
- AI extraction quality on generic-domain-root pages (the `nobarc.org` → "Next Business Meeting" case). PR-L's reply-template fix mitigated; a deeper fix would refuse extraction on a homepage URL with no event slug.

Three memory entries written for future me (and any other agent on the codebase) — see the `feedback_*` files in the project memory for each lesson.

Thanks for the brief — it was well-scoped enough that the work mostly fell out of the spec, even with the production surprises.
