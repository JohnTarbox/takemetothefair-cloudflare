/**
 * OPE-1285 — the workflow side of itemize + dispose: read the newsletter, ask
 * the model for its dated items, ground them, dispose of each against our
 * events, persist the list to `inbound_newsletters.items_json`, and record the
 * step. Every write here is additive (citations, discrepancies, the item list);
 * nothing edits an event and nothing creates one.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { eventDataCitations, events, inboundEmails, inboundNewsletters } from "../schema.js";
import type { AiBinding } from "../intent-classifier.js";
import { checkDuplicateViaMainApp } from "../duplicates/check-duplicate.js";
import { captureDiscrepancy } from "../goodwill/capture.js";
import { recordWorkflowStep } from "../workflow-run-log.js";
import { itemizeNewsletter, ITEMIZER_VERSION, type DroppedItem } from "./newsletter-itemize.js";
import { disposeItems, type DisposeDeps, type DisposedItem } from "./newsletter-dispose.js";

/**
 * Citation confidence, capped by what we know of the sender. A forwarded
 * newsletter's original sender is almost always `unverifiable_inline_forward`
 * (OPE-944): we hold the forwarder's word for the bytes, not the promoter's.
 */
export function newsletterCitationConfidence(originalSenderAuth: string | null): number {
  return originalSenderAuth === "verified" ? 0.6 : 0.3;
}

export interface NewsletterItemsRecord {
  version: string;
  proposed: number;
  items: DisposedItem[];
  dropped: DroppedItem[];
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export async function processNewsletter(
  db: Db,
  env: { AI?: AiBinding; MAIN_APP_URL?: string; INTERNAL_API_KEY?: string; DB?: D1Database },
  inboundEmailId: string,
  instanceId: string,
  overrides: Partial<DisposeDeps> = {}
): Promise<{ status: "ok" | "skipped" | "failed"; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const record = (status: "ok" | "skipped" | "failed", detail: Record<string, unknown>) =>
    recordWorkflowStep(db, {
      instanceId,
      workflowName: "inbound-email",
      inboundEmailId,
      stepName: "newsletter/itemize",
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

  // A replay must not cite twice or re-ask the model: the list is the receipt.
  if (!row || row.itemsJson !== null) {
    await record("skipped", { reason: row ? "already-itemized" : "not-a-newsletter" });
    return { status: "skipped", counts };
  }
  if (!env.AI || !row.bodyText) {
    await record("skipped", { reason: env.AI ? "no-body" : "no-ai-binding" });
    return { status: "skipped", counts };
  }

  const receivedAt = row.receivedAt ?? new Date();
  // Unique per email: idempotent on replay, and never collides with the submit
  // pipeline's `email://<sender>` body citations for the same event.
  const sourceUrl = `email://${row.fromAddress}/newsletter/${inboundEmailId}`;
  const confidence = newsletterCitationConfidence(row.originalSenderAuth ?? null);

  const deps: DisposeDeps = {
    checkDuplicate: (input) => checkDuplicateViaMainApp(env, input),
    loadEventDates: async (eventId) => {
      const [e] = await db
        .select({ start: events.startDate, end: events.endDate })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      const start = ymd(e?.start);
      return start ? { start, end: ymd(e?.end) } : null;
    },
    writeCitations: async ({ eventId, fields, excerpt }) => {
      let n = 0;
      for (const f of fields) {
        const [dupe] = await db
          .select({ id: eventDataCitations.id })
          .from(eventDataCitations)
          .where(
            and(
              eq(eventDataCitations.eventId, eventId),
              eq(eventDataCitations.fieldName, f.fieldName),
              eq(eventDataCitations.sourceUrl, sourceUrl)
            )
          )
          .limit(1);
        if (dupe) continue;
        // One row per insert: well inside D1's 100-bound-parameter cap.
        await db.insert(eventDataCitations).values({
          eventId,
          fieldName: f.fieldName,
          value: f.value,
          year: null,
          sourceUrl,
          sourceName: `Promoter newsletter (forwarded by ${row.fromAddress})`,
          sourceType: "user_submitted",
          confidence,
          state: "active",
          createdBy: null,
          sourceExcerpt: excerpt.slice(0, 600),
          sourceFetchedAt: receivedAt,
        });
        n++;
      }
      return n;
    },
    writeDiscrepancy: async ({ eventId, stored, newsletter }) => {
      await captureDiscrepancy(db, {
        eventId,
        fieldClass: "date",
        detectedBy: "newsletter",
        authoritativeValue: stored,
        divergentValue: newsletter,
        divergentSourceUrl: sourceUrl,
        forceOutreachCandidate: false,
        notes: `OPE-1285: a promoter newsletter (inbound ${inboundEmailId}) gives ${newsletter}; we hold ${stored}.`,
      });
    },
    ...overrides,
  };

  try {
    const { items, dropped, proposed } = await itemizeNewsletter(env.AI, row.bodyText, receivedAt);
    const disposed = await disposeItems(items, { promoterId: row.promoterId, receivedAt }, deps);
    for (const d of disposed) counts[d.disposition.kind] = (counts[d.disposition.kind] ?? 0) + 1;
    counts.dropped = dropped.length;
    const out: NewsletterItemsRecord = {
      version: ITEMIZER_VERSION,
      proposed,
      items: disposed,
      dropped,
    };
    await db
      .update(inboundNewsletters)
      .set({ itemsJson: JSON.stringify(out) })
      .where(eq(inboundNewsletters.id, row.newsletterId));
    await record("ok", { proposed, ...counts });
    return { status: "ok", counts };
  } catch (err) {
    // A model timeout costs the itemization, never the email: items_json stays
    // NULL, so the email can be itemized again by a later replay.
    await record("failed", { error: err instanceof Error ? err.message : String(err) });
    return { status: "failed", counts };
  }
}
