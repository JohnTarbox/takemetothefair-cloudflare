/**
 * OPE-1286 — the newsletter lane's creating half.
 *
 * OPE-1285 itemizes a newsletter and disposes of each dated item; an item with
 * no event of ours is recorded `unmatched` and nothing more. Once the lane OWNS
 * the email (`newsletterLaneOwns` — the submit pipeline no longer runs on it),
 * this step turns each `unmatched` item into a PENDING event.
 *
 * It creates through the submit lane's own chokepoints, not beside them:
 *   - the OPE-1253 floor (`refusalForCandidate` → `recordCandidateRefusal`);
 *   - the submit lane's dedup relay (`submitCheckDuplicate`), which is the one
 *     that honours a prior human adjudication (OPE-450) — the MCP-side
 *     `checkDuplicateViaMainApp` the dispose step uses does not parse
 *     `prior_adjudication`, so "unmatched" there is not "never rejected";
 *   - `submitEvent`, which grounds the dates, writes the inbound→event link and
 *     flags a blind-dedup creation. Status is the route's: PENDING for email.
 *
 * Each item's outcome is written back onto `items_json` as soon as it is known,
 * and an item that already carries one is skipped — so a step retry after a
 * partial run never creates the same event twice.
 */
import { eq } from "drizzle-orm";
import { classifyDedupTier } from "@takemetothefair/utils";
import type { Db } from "../db.js";
import { inboundEmails, inboundNewsletters, promoters } from "../schema.js";
import { recordWorkflowStep } from "../workflow-run-log.js";
import type { SenderTrustTier } from "../intent-classifier.js";
import {
  SUBMIT_REFUSED_PREFIX,
  isClickTrackerUrl,
  recordCandidateRefusal,
  refusalForCandidate,
  submitCheckDuplicate,
  submitEvent,
  type SubmitCheckDuplicateResult,
  type SubmitEventContext,
  type SubmitEventResult,
  type SubmitExtractResult,
} from "../email-handlers/submit.js";
import type { HandlerEnv } from "../email-handlers/types.js";
import type { CandidateOutcome, DisposeDeps, DisposedItem } from "./newsletter-dispose.js";
import {
  newsletterCitationConfidence,
  newsletterCitationWriter,
  newsletterSourceUrl,
  type NewsletterItemsRecord,
} from "./newsletter-process.js";

/**
 * Does the newsletter lane own this email — i.e. does it replace the submit
 * pipeline rather than shadow it? A newsletter we can attribute to a promoter
 * (sender domain, or the lists+<slug>@ subscription), or one a trusted
 * submitter forwarded. Anything else stays on the submit pipeline, as today.
 */
export function newsletterLaneOwns(
  newsletter: { isNewsletter: boolean; promoterId: string | null },
  senderTrust: SenderTrustTier
): boolean {
  return newsletter.isNewsletter && (newsletter.promoterId !== null || senderTrust === "trusted");
}

/**
 * The candidate's `source_url`: the promoter's own website, never a tracker
 * host (OPE-1253), never a non-http value. Empty string when there is none —
 * submitEvent then omits it, which is the free-text convention.
 */
export function candidateSourceUrl(website: string | null | undefined): string {
  if (!website) return "";
  try {
    const u = new URL(website);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  } catch {
    return "";
  }
  return isClickTrackerUrl(website) ? "" : website;
}

export interface CandidateDeps {
  checkDuplicate: (extracted: SubmitExtractResult) => Promise<SubmitCheckDuplicateResult>;
  submit: (extracted: SubmitExtractResult, ctx: SubmitEventContext) => Promise<SubmitEventResult>;
  recordRefusal: (extracted: SubmitExtractResult, reason: string) => Promise<void>;
  writeCitations: DisposeDeps["writeCitations"];
}

/** One `unmatched` item → one outcome. Never throws. */
export async function createCandidate(
  item: DisposedItem,
  ctx: {
    promoterId: string | null;
    sourceUrl: string;
    bodyText: string;
    inboundEmailId: string;
  },
  deps: CandidateDeps
): Promise<CandidateOutcome> {
  const event = {
    name: item.name,
    startDate: item.startDate,
    endDate: item.endDate,
    venueName: item.venue,
    venueCity: item.city,
    venueState: item.state,
  };
  // The dedup check compares the ITEM, never the promoter's homepage: that URL
  // is the source of many of the promoter's events, so an exact-URL stage would
  // match an unrelated show and drop a real one.
  // `free-text`: the fields were read from the email body, not from a page.
  const shape = {
    event,
    extractionMethod: "free-text" as const,
    totalEventsDetected: 1,
    additionalEventNames: [],
    events: [event],
  };
  const forDedup: SubmitExtractResult = { ...shape, url: "" };
  const forSubmit: SubmitExtractResult = { ...shape, url: ctx.sourceUrl };
  try {
    const refusal = refusalForCandidate(forSubmit, [ctx.bodyText]);
    if (refusal) {
      await deps.recordRefusal(forSubmit, refusal);
      return { outcome: "refused", reason: refusal };
    }
    const dedup = await deps.checkDuplicate(forDedup);
    let possibleDuplicateOf: string | null = null;
    if (dedup.isDuplicate) {
      const tier = classifyDedupTier(dedup.matchType ?? "");
      if (tier === "high") {
        return {
          outcome: "exists",
          eventId: dedup.existingEventId ?? null,
          matchType: dedup.matchType ?? "",
        };
      }
      possibleDuplicateOf = dedup.existingEventId ?? null;
    }
    const created = await deps.submit(forSubmit, {
      inboundEmailId: ctx.inboundEmailId,
      dedupWasBlind: dedup.dedupWasBlind === true,
      possibleDuplicateOf,
      sourceTexts: [ctx.bodyText],
      promoterId: ctx.promoterId,
    });
    if (created.routed === "occurrence_exists") {
      return { outcome: "occurrence-exists", eventId: created.id };
    }
    // The excerpt is the citation (OPE-1285's source key and confidence cap).
    // An unmatched item always printed its year — dispose skips the rest.
    const fields: { fieldName: "start_date" | "end_date"; value: string }[] = [
      { fieldName: "start_date", value: item.startDate },
      ...(item.endDate ? [{ fieldName: "end_date" as const, value: item.endDate }] : []),
    ];
    let citedFields: string[] = [];
    try {
      await deps.writeCitations({ eventId: created.id, fields, excerpt: item.excerpt });
      citedFields = fields.map((f) => f.fieldName);
    } catch {
      // The event exists; a missing citation is visible on the item, not fatal.
    }
    return {
      outcome: "created",
      eventId: created.id,
      routed: created.routed,
      possibleDuplicateOf,
      citedFields,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // submitEvent's own floor throws after recording the refusal.
    if (message.startsWith(SUBMIT_REFUSED_PREFIX)) {
      return { outcome: "refused", reason: message.slice(SUBMIT_REFUSED_PREFIX.length) };
    }
    return { outcome: "failed", error: message.slice(0, 300) };
  }
}

/**
 * The workflow step: create a PENDING candidate for every `unmatched` item of
 * this email's newsletter that has none yet. Records its step on every run.
 */
export async function createNewsletterCandidates(
  db: Db,
  env: HandlerEnv,
  inboundEmailId: string,
  instanceId: string,
  overrides: Partial<CandidateDeps> = {}
): Promise<{ status: "ok" | "skipped"; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const record = (status: "ok" | "skipped", detail: Record<string, unknown>) =>
    recordWorkflowStep(db, {
      instanceId,
      workflowName: "inbound-email",
      inboundEmailId,
      stepName: "newsletter/candidates",
      status,
      detail,
    });

  const [row] = await db
    .select({
      bodyText: inboundEmails.bodyText,
      fromAddress: inboundEmails.fromAddress,
      receivedAt: inboundEmails.receivedAt,
      originalSenderAuth: inboundEmails.originalSenderAuth,
      newsletterId: inboundNewsletters.id,
      promoterId: inboundNewsletters.promoterId,
      itemsJson: inboundNewsletters.itemsJson,
    })
    .from(inboundEmails)
    .innerJoin(inboundNewsletters, eq(inboundNewsletters.inboundEmailId, inboundEmails.id))
    .where(eq(inboundEmails.id, inboundEmailId))
    .limit(1);
  if (!row || !row.itemsJson) {
    await record("skipped", { reason: row ? "not-itemized" : "not-a-newsletter" });
    return { status: "skipped", counts };
  }
  let parsed: NewsletterItemsRecord;
  try {
    parsed = JSON.parse(row.itemsJson) as NewsletterItemsRecord;
  } catch {
    await record("skipped", { reason: "items-unparseable" });
    return { status: "skipped", counts };
  }

  const website = row.promoterId
    ? await db
        .select({ website: promoters.website })
        .from(promoters)
        .where(eq(promoters.id, row.promoterId))
        .limit(1)
        .then((r) => r[0]?.website ?? null)
    : null;
  const receivedAt = row.receivedAt ?? new Date();
  const fromAddress = row.fromAddress ?? "";
  const deps: CandidateDeps = {
    checkDuplicate: (extracted) => submitCheckDuplicate(env, extracted),
    submit: (extracted, ctx) => submitEvent(env, extracted, fromAddress, ctx),
    recordRefusal: (extracted, reason) =>
      recordCandidateRefusal(
        env,
        extracted,
        [row.bodyText ?? ""],
        inboundEmailId,
        reason as Parameters<typeof recordCandidateRefusal>[4]
      ),
    writeCitations: newsletterCitationWriter(db, {
      sourceUrl: newsletterSourceUrl(row.fromAddress, inboundEmailId),
      fromAddress: row.fromAddress,
      confidence: newsletterCitationConfidence(row.originalSenderAuth ?? null),
      receivedAt,
    }),
    ...overrides,
  };
  const ctx = {
    promoterId: row.promoterId,
    sourceUrl: candidateSourceUrl(website),
    bodyText: row.bodyText ?? "",
    inboundEmailId,
  };

  let examined = 0;
  for (const item of parsed.items) {
    const d = item.disposition;
    if (d.kind !== "unmatched") continue;
    examined++;
    if (d.candidate) {
      counts.alreadyDone = (counts.alreadyDone ?? 0) + 1;
      continue;
    }
    d.candidate = await createCandidate(item, ctx, deps);
    counts[d.candidate.outcome] = (counts[d.candidate.outcome] ?? 0) + 1;
    // Persist each outcome before the next item: the receipt that stops a
    // retry from creating this one again.
    await db
      .update(inboundNewsletters)
      .set({ itemsJson: JSON.stringify(parsed) })
      .where(eq(inboundNewsletters.id, row.newsletterId));
  }
  // Positive landmark beside the counts: how many items were looked at.
  await record("ok", { items: parsed.items.length, unmatched: examined, ...counts });
  return { status: "ok", counts: { unmatched: examined, ...counts } };
}
