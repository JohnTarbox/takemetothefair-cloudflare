/**
 * OPE-1264 — the workflow side of newsletter classification: read the row,
 * detect, attribute, write `inbound_newsletters`, and record the step. Kept out
 * of the workflow file so it is testable against a real database.
 */
import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db.js";
import { inboundEmails, inboundNewsletters, promoterListArrivals, promoters } from "../schema.js";
import { attributeNewsletter, detectNewsletter, type NewsletterMatchBasis } from "./newsletter.js";
import { recordWorkflowStep } from "../workflow-run-log.js";

export async function classifyAndRecordNewsletter(
  db: Db,
  inboundEmailId: string,
  instanceId: string
): Promise<{
  isNewsletter: boolean;
  basis: NewsletterMatchBasis | null;
  promoterId: string | null;
}> {
  const [row] = await db
    .select({
      bodyText: inboundEmails.bodyText,
      bodyTextExcerpt: inboundEmails.bodyTextExcerpt,
      bodyHtml: inboundEmails.bodyHtml,
      fromAddress: inboundEmails.fromAddress,
      originalSenderAddress: inboundEmails.originalSenderAddress,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundEmailId))
    .limit(1);
  if (!row) return { isNewsletter: false, basis: null, promoterId: null };

  const text = row.bodyText ?? row.bodyTextExcerpt ?? null;
  const verdict = detectNewsletter(text, row.bodyHtml ?? null);
  let basis: NewsletterMatchBasis | null = null;
  let promoterId: string | null = null;

  if (verdict.isNewsletter) {
    // A lists+<slug>@ arrival (OPE-1265) already knows its promoter.
    const [arrival] = await db
      .select({ promoterId: promoterListArrivals.promoterId })
      .from(promoterListArrivals)
      .where(eq(promoterListArrivals.inboundEmailId, inboundEmailId))
      .limit(1);
    const promoterRows = arrival?.promoterId
      ? []
      : await db
          .select({
            id: promoters.id,
            companyName: promoters.companyName,
            website: promoters.website,
            contactEmail: promoters.contactEmail,
          })
          .from(promoters)
          .where(isNotNull(promoters.companyName));
    // Forwarded: the original sender (OPE-944) is the newsletter's sender.
    const senderAddress = row.originalSenderAddress ?? row.fromAddress ?? null;
    ({ promoterId, basis } = attributeNewsletter(
      { senderAddress, text, subscriptionPromoterId: arrival?.promoterId ?? null },
      promoterRows
    ));
    await db
      .insert(inboundNewsletters)
      .values({
        inboundEmailId,
        markers: verdict.markers.join(","),
        promoterId,
        matchBasis: basis,
        senderAddress,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }

  await recordWorkflowStep(db, {
    instanceId,
    workflowName: "inbound-email",
    inboundEmailId,
    stepName: "newsletter/classify",
    status: "ok",
    detail: { isNewsletter: verdict.isNewsletter, markers: verdict.markers, basis, promoterId },
  });
  return { isNewsletter: verdict.isNewsletter, basis, promoterId };
}
