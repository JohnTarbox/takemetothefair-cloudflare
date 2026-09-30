/**
 * `corrections@` handler — sender claims an event listing is wrong.
 *
 * Two-tier disambiguation (spec §C.9). First-match-wins.
 *
 *   Tier 1 (slug): exact slug match. If the body contains a
 *           `meetmeatthefair.com/events/<slug>` URL, look up that event
 *           directly. Cheapest + most reliable signal — senders who
 *           clicked through to an approval-notification email and hit
 *           Reply will land here.
 *
 *   Tier 2 (fuzzy name): when no slug, use the email subject as a name
 *           candidate (correction subjects are most often the event name
 *           itself: "Boxboro", "Chester Greenwood Day" — Gmail preserves
 *           the original subject on reply). Run combinedSimilarity
 *           against events.name across the recent-events set. Two sub-
 *           thresholds:
 *             ≥0.85: single match → auto-resolve to that event id.
 *             ≥0.75: ALL matches surfaced as candidates for admin
 *                    disambiguation via the existing waitForEvent flow.
 *           No auto-resolve at the lower threshold — admin still calls
 *           the shot since correction.applied edits events.
 *
 * Spec mentioned a separate "Tier 3 name + state" tier; we collapsed it
 * into Tier 2 because `inbound_email_senders` doesn't actually store a
 * dominant-state field. If a per-sender state signal lands later, this
 * is the seam to slot a state-filtered tier above Tier 2.
 *
 * In all tiers, the handler writes admin_actions with the candidate list
 * (one entry for confident single matches, multiple for ambiguous) and
 * the workflow's existing waitForEvent flow picks up admin's decision
 * over the next 7 days. Auto-resolve happens ONLY on Tier 1 (exact slug
 * match) and on Tier 2 when there's exactly one match — for everything
 * else admin disambiguates.
 *
 * --- C.10 (date-drift cross-check) — still deferred ---
 * Not in this handler. Drift check requires fetching the canonical
 * source URL + parsing dates, which lives in the main app's url-import
 * pipeline. When wired, it'll fire as a follow-up step on rows with a
 * single resolved targetEventId + a date-field clue in body text.
 *
 * Failure handling: D1 errors propagate as plain Error. The workflow's
 * dispatch step retries:{limit:2} so a transient D1 blip gets a second
 * attempt. If both fail, the outer catch records status='failed' and
 * emits a generic-failure reply (acknowledging a correction we never
 * recorded misleads the sender).
 */

import { adminActions, events } from "../schema.js";
import { getDb } from "../db.js";
import { unsafeSlug } from "../helpers.js";
import { eq, isNotNull } from "drizzle-orm";
import { combinedSimilarity, isListingQuestion } from "@takemetothefair/utils";
import type { HandlerFn, HandlerResult } from "./types.js";
import { resolveHeldPhotosFromReply } from "../photo/resolve-held-photos.js";
import { openObligationIfOwed } from "./open-obligation.js";

const SOURCE = "mcp:email-handler:correction";

const SLUG_URL_RE = /https?:\/\/(?:www\.)?meetmeatthefair\.com\/events\/([a-z0-9][a-z0-9-]*)/i;

/** Auto-resolve when there's exactly one fuzzy match at or above this
 *  similarity AND no other event scores within 0.10 of it. */
const AUTO_RESOLVE_THRESHOLD = 0.85;
/** Surface as a candidate for admin disambiguation at or above this. */
const CANDIDATE_THRESHOLD = 0.75;
/** Cap on candidates surfaced in admin_actions payload. */
const MAX_CANDIDATES = 5;

export const handle: HandlerFn = async (env, ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);

  // OPE-254 Defect 2 — a reply naming the fair on a held photo-intake
  // notification lands here as intent=correction. When it threads back to a
  // held `photo-intake-unresolved` batch AND names a resolvable fair, resolve
  // + attach those photos and reply with the outcome — no re-send needed.
  // Returns null for everything else (normal corrections fall through).
  const photo = await resolveHeldPhotosFromReply(env, db, ctx, row);
  if (photo) {
    return {
      replyKind: "photo-intake-resolved",
      replyParams: {
        subject: row.subject ?? "",
        resolvedEventName: photo.event.name,
        resolvedEventSlug: photo.event.slug,
        photoCount: photo.attached,
        galleryAttached: photo.attached,
        galleryFailed: photo.failed,
        emailCount: photo.resolvedParents,
      },
      resultingEventId: photo.event.id,
      status: "replied",
      // The photos are attached already. Parking this behind the correction
      // lane's admin-decision pause would discard this result and make the
      // sender wait up to 7 days to hear that it worked.
      skipAdminDecision: true,
    };
  }

  // OPE-1085 — a reader ASKING about a listing, acknowledged as if they had
  // reported an error in it.
  //
  // The classifier returns `correction` on every arrival of the event-page
  // mailto where it has run (6 of 6). An ablation against the real model showed
  // it is a conjunction of two things we supply: our `Question about …` subject
  // and our own event URL in the body. Either alone reads `support` at 0.90;
  // together they read `correction` at 0.85 and clear a `>= 0.85` gate with zero
  // margin. So Corey, who asked whether he could rent a wheelchair, was told
  // seven seconds later that we had recorded his correction request.
  //
  // What changes here is only what the READER is told. The row keeps
  // `classified_intent='correction'`, still writes `email.correction_request`
  // below via the normal path when it is not a question, and the classifier's
  // verdict is left intact so the D.1 accuracy dashboard can still see it being
  // wrong. Overwriting the verdict would fix the symptom and hide the defect.
  //
  // `support-ack` is NOT new copy: it is the text John approved 2026-08-13 for
  // OPE-367, every clause of which is true of a question, and it is already what
  // this exact shape receives when the model happens to land below the gate
  // (`6a9a7373`, 0.82). This makes an accident consistent rather than inventing
  // a lane. Bespoke question copy is a separate ask on OPE-1085; it lands here
  // when John rules.
  if (isListingQuestion({ subject: row.subject, body: row.bodyTextExcerpt })) {
    await db.insert(adminActions).values({
      action: "email.listing_question",
      actorUserId: null,
      targetType: "inbound_email",
      targetId: row.id,
      payloadJson: JSON.stringify({
        from: row.fromAddress,
        subject: row.subject ?? null,
        bodyExcerpt: row.bodyTextExcerpt ?? null,
        receivedAt: row.receivedAt,
        classifiedIntent: "correction",
        note: "reader question routed to the correction lane; acked as support, not as a correction",
      }),
      createdAt: new Date(),
    });

    // Scope 3 — a question does not belong on the correction lane's 7-day
    // admin `waitForEvent`. `fbd5b1fc` sat in `status: waiting` while the
    // festival he asked about ran and closed. The obligation row is what
    // surfaces it to an operator; the 7-day pause only delays the reply.
    const questionObligation = await openObligationIfOwed(env, db, row, SOURCE);

    return {
      replyKind: "support-ack",
      replyParams: { subject: row.subject ?? "" },
      status: "replied",
      skipAdminDecision: true,
      crossingDestinationRef: questionObligation,
    };
  }

  const bodyForScan = `${row.subject ?? ""}\n${row.bodyTextExcerpt ?? ""}`;
  const slug = extractEventSlug(bodyForScan);

  let targetEventId: string | null = null;
  let targetEventStatus: string | null = null;
  let tier: "slug" | "fuzzy-name" | "no-match" = "no-match";
  let candidates: Array<{ id: string; name: string; state: string | null; similarity: number }> =
    [];

  // ---- Tier 1: exact slug ----
  if (slug) {
    const matches = await db
      .select({ id: events.id, status: events.status })
      .from(events)
      .where(eq(events.slug, unsafeSlug(slug)))
      .limit(1);
    if (matches.length === 1) {
      targetEventId = matches[0].id;
      targetEventStatus = matches[0].status;
      tier = "slug";
    }
  }

  // ---- Tier 2: fuzzy name match ----
  // Only run when slug-tier didn't resolve. Subject is the primary
  // name candidate (Gmail preserves it on reply); body excerpt is the
  // fallback when subject is empty / generic-reply-prefix-only.
  //
  // Auto-resolve criteria: exactly one candidate at AUTO_RESOLVE_THRESHOLD
  // AND the next-best candidate (if any) is materially lower (≥0.10 gap).
  // Otherwise: surface all candidates ≥ CANDIDATE_THRESHOLD for admin
  // disambiguation via the existing waitForEvent flow.
  if (!targetEventId) {
    const nameCandidate = pickNameCandidate(row.subject, row.bodyTextExcerpt);
    if (nameCandidate && nameCandidate.length >= 3) {
      // Single SELECT against ALL events — bounded enough at current
      // volumes that scanning is cheaper than building tokenized indices.
      // The combinedSimilarity helper short-circuits cheaply for very
      // dissimilar pairs via the Levenshtein early-exit.
      const eventRows = await db
        .select({ id: events.id, name: events.name, state: events.stateCode })
        .from(events)
        .where(isNotNull(events.name))
        .limit(2000);

      const scored = scoreCandidates(eventRows, nameCandidate);
      const surfaceable = scored.filter((c) => c.similarity >= CANDIDATE_THRESHOLD);

      if (surfaceable.length > 0) {
        tier = "fuzzy-name";
        candidates = surfaceable.slice(0, MAX_CANDIDATES);

        // Auto-resolve when the top candidate is strong AND clearly
        // beats the runner-up. "Clearly" = at least 0.10 similarity gap;
        // that empirically separates "this is obviously the event" from
        // "two similarly-named events that admin should disambiguate".
        const top = surfaceable[0];
        const runnerUp = surfaceable[1];
        if (
          top.similarity >= AUTO_RESOLVE_THRESHOLD &&
          (!runnerUp || top.similarity - runnerUp.similarity >= 0.1)
        ) {
          targetEventId = top.id;
          // We didn't SELECT status in this batch; admin's UI will fetch
          // it fresh from the events table when rendering the row.
          targetEventStatus = null;
        }
      }
    }
  }

  await db.insert(adminActions).values({
    action: "email.correction_request",
    actorUserId: null,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({
      from: row.fromAddress,
      subject: row.subject ?? null,
      bodyExcerpt: row.bodyTextExcerpt ?? null,
      receivedAt: row.receivedAt,
      // C.9 resolution metadata
      extractedSlug: slug,
      targetEventId,
      targetEventStatus,
      tier,
      candidates, // [] when tier='slug' or 'no-match'
    }),
    createdAt: new Date(),
  });

  // OPE-1066 — the ack is a promise, so record it. Deliberately placed AFTER the
  // photo-intake branch above: that path resolves the sender's request outright
  // and tells them the outcome, so nothing is still owed. Everything reaching
  // here has been acknowledged and deferred to an admin decision that may take
  // up to seven days, which is exactly the shape OPE-365 made durable.
  //
  // This covers `claim_request` too — it rides this handler by design.
  const obligationRef = await openObligationIfOwed(env, db, row, SOURCE);

  return {
    // OPE-1134 — a claim_request rides this handler but is not a correction.
    replyKind: row.classifiedIntent === "claim_request" ? "claim-request-ack" : "correction-ack",
    replyParams: { subject: row.subject ?? "" },
    status: "replied",
    crossingDestinationRef: obligationRef,
  };
};

/** Pull the first `meetmeatthefair.com/events/<slug>` slug from text,
 *  or null if none found. Exported for unit tests. */
export function extractEventSlug(text: string): string | null {
  const m = text.match(SLUG_URL_RE);
  if (!m) return null;
  return (m[1] || "").toLowerCase().replace(/-+$/, "") || null;
}

/**
 * Pick a name candidate to fuzzy-match against events.name.
 *
 * Subject first — correction emails typically have the event name in the
 * subject (Gmail preserves it on reply). Falls back to the body excerpt's
 * first line if the subject is empty or matches one of the generic-reply
 * patterns ("Re:", "Fwd:", standalone "wrong date", etc.).
 *
 * Exported for unit tests.
 */
export function pickNameCandidate(
  subject: string | null,
  bodyExcerpt: string | null
): string | null {
  const subj = (subject ?? "").trim();
  // Strip standard reply prefixes from the subject, repeatedly (Re: Re: Fwd:).
  const cleanedSubj = subj.replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim();
  if (
    cleanedSubj &&
    cleanedSubj.length >= 3 &&
    !/^(wrong|incorrect|update|correction|fix|change|date)$/i.test(cleanedSubj)
  ) {
    return cleanedSubj;
  }
  // Fallback: first non-empty line of body, capped at 100 chars.
  const body = (bodyExcerpt ?? "").trim();
  if (!body) return null;
  const firstLine = body.split("\n").find((line) => line.trim().length >= 3);
  return firstLine ? firstLine.trim().slice(0, 100) : null;
}

interface ScoredCandidate {
  id: string;
  name: string;
  state: string | null;
  similarity: number;
}

function scoreCandidates(
  eventRows: Array<{ id: string; name: string; state: string | null }>,
  needle: string
): ScoredCandidate[] {
  return eventRows
    .map((e) => ({
      id: e.id,
      name: e.name,
      state: e.state,
      similarity: combinedSimilarity(needle, e.name),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}
