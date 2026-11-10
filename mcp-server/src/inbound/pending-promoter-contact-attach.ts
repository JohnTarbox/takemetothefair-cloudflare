/**
 * OPE-1610 — attach pending contacts to a promoter once one exists.
 *
 * A promoter row can be created from five places (registration, the admin API,
 * the suggest-event submit route and two MCP tools), and its website can be set
 * later. One hourly job that asks "does a promoter now own this domain?" covers
 * all of them, so no creation path can forget to call it. The cost is up to an
 * hour's delay, which nothing here needs to beat.
 *
 * The verdict is re-run against the real website rather than trusted from the
 * pending row, and goes through the same `planPromoterContactWrite` rule as
 * capture, so a contact a person has rejected stays rejected.
 */
import { and, asc, eq } from "drizzle-orm";
import { decidePromoterContactDomain, planPromoterContactWrite } from "@takemetothefair/db-schema";
import { getDb, type Db } from "../db.js";
import { logError } from "../logger.js";
import {
  adminActions,
  inboundEmails,
  pendingPromoterContacts,
  promoterContacts,
  promoters,
} from "../schema.js";
import { CAPTURE_ACTOR, promotersFromDomain } from "./promoter-contact-capture.js";

export const PENDING_ATTACH_SOURCE = "mcp:inbound:pending-contact-attach";
/** Bounds one run; older rows go first, and the next run continues. */
const MAX_PER_RUN = 100;

export interface PendingAttachSummary {
  examined: number;
  attached: number;
  /** A promoter owns the domain but the verdict no longer qualifies. */
  notQualified: number;
}

export async function attachPendingPromoterContacts(
  db: Db,
  now: Date = new Date()
): Promise<PendingAttachSummary> {
  const pending = await db
    .select()
    .from(pendingPromoterContacts)
    .where(eq(pendingPromoterContacts.status, "pending"))
    .orderBy(asc(pendingPromoterContacts.createdAt))
    .limit(MAX_PER_RUN);
  const summary: PendingAttachSummary = { examined: pending.length, attached: 0, notQualified: 0 };

  for (const p of pending) {
    // Exactly one owner: an ambiguous domain waits, as it does at capture.
    const owners = await promotersFromDomain(db, p.orgDomain);
    if (owners.ids.length !== 1 || !p.inboundEmailId) continue;
    const promoterId = owners.ids[0];

    const [inbound] = await db
      .select({
        dmarcResult: inboundEmails.dmarcResult,
        authResultsRaw: inboundEmails.authResultsRaw,
        originalSenderAuth: inboundEmails.originalSenderAuth,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, p.inboundEmailId))
      .limit(1);
    const [promoter] = await db
      .select({ website: promoters.website })
      .from(promoters)
      .where(eq(promoters.id, promoterId))
      .limit(1);
    if (!inbound || !promoter) continue;

    const verdict = decidePromoterContactDomain(
      { fromAddress: p.email, ...inbound },
      promoter.website
    );
    if (!verdict.qualifies) {
      summary.notQualified++;
      continue;
    }

    const [existing] = await db
      .select({
        id: promoterContacts.id,
        status: promoterContacts.status,
        firstValidatedAt: promoterContacts.firstValidatedAt,
        lastHeardAt: promoterContacts.lastHeardAt,
      })
      .from(promoterContacts)
      .where(and(eq(promoterContacts.promoterId, promoterId), eq(promoterContacts.email, p.email)))
      .limit(1);

    const plan = planPromoterContactWrite({
      writer: "capture",
      existing: existing ?? null,
      promoterId,
      email: p.email,
      fields: {
        name: p.name,
        validationMethod: "domain_verified",
        validationEvidence: `${p.validationEvidence ?? ""}; attached when promoter ${promoterId} appeared; ${verdict.reason}`,
        inboundEmailId: p.inboundEmailId,
        senderAuth: p.senderAuth,
        authDomain: verdict.authDomain,
        authDomainMatchesPromoter: verdict.matchesPromoter,
        status: "validated",
      },
      heardAt: p.lastHeardAt ?? p.firstValidatedAt,
      actor: CAPTURE_ACTOR,
      now,
    });

    let contactId: string | null = null;
    if (plan.kind === "insert") {
      contactId = crypto.randomUUID();
      await db
        .insert(promoterContacts)
        .values({ id: contactId, ...(plan.values as typeof promoterContacts.$inferInsert) })
        .onConflictDoNothing();
    } else if (plan.kind === "update") {
      contactId = plan.id;
      await db.update(promoterContacts).set(plan.set).where(eq(promoterContacts.id, plan.id));
    }

    await db
      .update(pendingPromoterContacts)
      .set({ status: "attached", attachedPromoterId: promoterId, attachedAt: now, updatedAt: now })
      .where(eq(pendingPromoterContacts.id, p.id));
    summary.attached++;

    if (contactId) {
      await db.insert(adminActions).values({
        action: "promoter_contact.auto_validated",
        actorUserId: null,
        targetType: "promoter_contact",
        targetId: contactId,
        payloadJson: JSON.stringify({
          promoterId,
          inboundEmailId: p.inboundEmailId,
          basis: ["pending-attach"],
          matchedEntityType: p.matchedEntityType,
          matchedEntityId: p.matchedEntityId,
          reason: verdict.reason,
        }),
        createdAt: now,
      });
    }
  }
  return summary;
}

/** Writes one info row per run as proof it ran; most runs attach nothing. */
export async function runScheduledPendingContactAttach(env: { DB: D1Database }): Promise<void> {
  const s = await attachPendingPromoterContacts(getDb(env.DB));
  await logError(env.DB, {
    level: "info",
    source: PENDING_ATTACH_SOURCE,
    message: `pending contact attach: examined ${s.examined}, attached ${s.attached}, not qualified ${s.notQualified}`,
  });
}
