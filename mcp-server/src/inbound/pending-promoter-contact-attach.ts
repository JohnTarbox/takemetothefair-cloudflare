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
import {
  decidePromoterContactDomain,
  matchableDomainsFor,
  planPromoterContactWrite,
} from "@takemetothefair/db-schema";
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
import { addByRedirect, type FetchLike } from "./org-domain-discovery.js";

export const PENDING_ATTACH_SOURCE = "mcp:inbound:pending-contact-attach";
/** Bounds one run; older rows go first, and the next run continues. */
const MAX_PER_RUN = 100;
/**
 * OPE-1614 — redirect checks per run, and how often one domain is re-checked.
 * Bounded so the hourly job's outbound fetches stay small.
 */
const MAX_PROBES_PER_RUN = 10;
const PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PendingAttachSummary {
  examined: number;
  attached: number;
  /** A promoter owns the domain but the verdict no longer qualifies. */
  notQualified: number;
  /** OPE-1614 — unowned domains redirect-checked this run, and how many that added. */
  probed: number;
  redirectAdded: number;
  /** The domain is on several promoters' lists: left for an operator. */
  shared: number;
}

export async function attachPendingPromoterContacts(
  db: Db,
  now: Date = new Date(),
  /** OPE-1614 — when given, unowned domains are redirect-checked. */
  fetchImpl?: FetchLike
): Promise<PendingAttachSummary> {
  const pending = await db
    .select()
    .from(pendingPromoterContacts)
    .where(eq(pendingPromoterContacts.status, "pending"))
    .orderBy(asc(pendingPromoterContacts.createdAt))
    .limit(MAX_PER_RUN);
  const summary: PendingAttachSummary = {
    examined: pending.length,
    attached: 0,
    notQualified: 0,
    probed: 0,
    redirectAdded: 0,
    shared: 0,
  };

  for (const p of pending) {
    // Exactly one owner: an ambiguous (shared) domain waits, as at capture.
    let owners = await promotersFromDomain(db, p.orgDomain);
    if (owners.ambiguous) {
      summary.shared++;
      continue;
    }
    // OPE-1614: no owner yet — does the domain redirect to one promoter's
    // domain (ohtm.org → owlshead.org)? That adds it to that promoter's list.
    const due =
      !p.domainProbedAt || now.getTime() - p.domainProbedAt.getTime() >= PROBE_INTERVAL_MS;
    if (owners.ids.length === 0 && fetchImpl && due && summary.probed < MAX_PROBES_PER_RUN) {
      summary.probed++;
      const r = await addByRedirect(db, "promoter", p.orgDomain, fetchImpl, now);
      await db
        .update(pendingPromoterContacts)
        .set({ domainProbedAt: now })
        .where(eq(pendingPromoterContacts.id, p.id));
      if (r.added) summary.redirectAdded++;
      owners = await promotersFromDomain(db, p.orgDomain);
    }
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
      .select({ id: promoters.id })
      .from(promoters)
      .where(eq(promoters.id, promoterId))
      .limit(1);
    if (!inbound || !promoter) continue;

    const verdict = decidePromoterContactDomain(
      { fromAddress: p.email, ...inbound },
      await matchableDomainsFor(db, "promoter", promoterId)
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
  const s = await attachPendingPromoterContacts(getDb(env.DB), new Date(), (u, i) => fetch(u, i));
  await logError(env.DB, {
    level: "info",
    source: PENDING_ATTACH_SOURCE,
    message: `pending contact attach: examined ${s.examined}, attached ${s.attached}, not qualified ${s.notQualified}, shared ${s.shared}, redirect-probed ${s.probed}, redirect-added ${s.redirectAdded}`,
  });
}
