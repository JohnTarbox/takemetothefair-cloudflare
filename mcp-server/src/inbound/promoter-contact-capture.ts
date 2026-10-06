/**
 * OPE-1330 — capture a promoter contact from an inbound email.
 *
 * The workflow side of `promoter_contacts`: read the row, find the promoter(s)
 * this sender is evidence for, decide domain verification, apply the shared
 * write rule, record the step. Kept out of the workflow file so it is testable
 * against a real database (same split as newsletter-record.ts).
 *
 * A sender becomes a contact of a promoter in exactly two ways (scope item 3):
 *
 *   1. `contact-email` — the From address IS the promoter's `contact_email`.
 *   2. `reply-to-our-mail` — the message is a threaded reply (In-Reply-To /
 *      References) to mail WE sent to that promoter: a blog-mention notice,
 *      promoter outreach, or an operator email. The ledger row names the
 *      recipient; the recipient is traced to the promoter we wrote to. A
 *      recipient that traces to more than one promoter captures nothing.
 *
 * A fair-goer who merely mentions a promoter matches neither, and no name or
 * title is ever parsed out of the body — the display name is the only name.
 *
 * Nothing sends, blocks, routes or auto-applies anything because a row exists:
 * this builds the record only.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import {
  adminActions,
  emailSendLedger,
  inboundEmails,
  operatorOutboundDrafts,
  promoterContacts,
  promoterOutreachAttempts,
  promoters,
  users,
} from "../schema.js";
import {
  contactSenderAuth,
  decidePromoterContactDomain,
  normalizeEmailAddress,
  parseMessageIds,
  planPromoterContactWrite,
  type PromoterContactStatus,
} from "@takemetothefair/db-schema";
import { recordWorkflowStep } from "../workflow-run-log.js";

/** Outbound sources addressed to a promoter (verified against the senders). */
export const PROMOTER_OUTBOUND_SOURCES = [
  "content-links-sync.promoter-mention", // src/lib/content-links-sync.ts
  "email:promoter-outreach", // tools/admin-send-promoter-email.ts
  "operator:outbound", // tools/admin-operator-outbound.ts OPERATOR_OUTBOUND_SOURCE
] as const;

export const CAPTURE_ACTOR = "system:inbound-capture";
const OWN_DOMAIN = "meetmeatthefair.com";
/** Long References chains: the newest ids are the ones that name our mail. */
const MAX_THREAD_IDS = 20;
const MAX_PROMOTERS = 10;

export type CaptureBasis = "contact-email" | "reply-to-our-mail";

export interface CaptureSummary {
  promoters: number;
  inserted: number;
  promoted: number;
  refreshed: number;
  unchanged: number;
  ambiguousThreads: number;
  skipped: string | null;
}

/** Thread → the promoter each promoter-addressed send of ours went to. */
async function promotersFromThread(
  db: Db,
  inReplyTo: string | null,
  references: string | null
): Promise<{ ids: string[]; ambiguous: number }> {
  const parsed = parseMessageIds(inReplyTo, references).slice(-MAX_THREAD_IDS);
  if (parsed.length === 0) return { ids: [], ambiguous: 0 };
  // The ledger stores the id WITH angle brackets; some providers drop them.
  const forms = [...new Set(parsed.flatMap((id) => [id, `<${id}>`]))];
  const sent = await db
    .select({ recipient: emailSendLedger.recipient, source: emailSendLedger.source })
    .from(emailSendLedger)
    .where(
      and(
        inArray(emailSendLedger.providerMessageId, forms),
        inArray(emailSendLedger.source, [...PROMOTER_OUTBOUND_SOURCES])
      )
    );

  const ids = new Set<string>();
  let ambiguous = 0;
  for (const s of sent) {
    const to = normalizeEmailAddress(s.recipient);
    if (!to) continue;
    const found = new Set<string>();
    // Every promoter-addressed send goes to the promoter's contact_email or,
    // for a blog mention with none, to the promoter owner's account email.
    for (const r of await db
      .select({ id: promoters.id })
      .from(promoters)
      .where(sql`lower(${promoters.contactEmail}) = ${to}`))
      found.add(r.id);
    for (const r of await db
      .select({ id: promoters.id })
      .from(promoters)
      .innerJoin(users, eq(users.id, promoters.userId))
      .where(sql`lower(${users.email}) = ${to}`))
      found.add(r.id);
    if (s.source === "email:promoter-outreach") {
      for (const r of await db
        .select({ id: promoterOutreachAttempts.promoterId })
        .from(promoterOutreachAttempts)
        .where(sql`lower(${promoterOutreachAttempts.toAddress}) = ${to}`))
        found.add(r.id);
    }
    if (s.source === "operator:outbound") {
      for (const r of await db
        .select({ id: operatorOutboundDrafts.relatedEntityId })
        .from(operatorOutboundDrafts)
        .where(
          and(
            eq(operatorOutboundDrafts.relatedEntityType, "promoter"),
            sql`lower(${operatorOutboundDrafts.toAddress}) = ${to}`
          )
        ))
        if (r.id) found.add(r.id);
    }
    if (found.size === 1) ids.add([...found][0]);
    else if (found.size > 1) ambiguous++;
  }
  return { ids: [...ids], ambiguous };
}

export async function capturePromoterContacts(
  db: Db,
  inboundEmailId: string,
  instanceId: string,
  now: Date = new Date()
): Promise<CaptureSummary> {
  const summary: CaptureSummary = {
    promoters: 0,
    inserted: 0,
    promoted: 0,
    refreshed: 0,
    unchanged: 0,
    ambiguousThreads: 0,
    skipped: null,
  };
  const done = async () => {
    await recordWorkflowStep(db, {
      instanceId,
      workflowName: "inbound-email",
      inboundEmailId,
      stepName: "promoter-contacts/capture",
      status: "ok",
      detail: summary,
    });
    return summary;
  };

  const [row] = await db
    .select({
      fromAddress: inboundEmails.fromAddress,
      fromDisplayName: inboundEmails.fromDisplayName,
      receivedAt: inboundEmails.receivedAt,
      dmarcResult: inboundEmails.dmarcResult,
      senderAuth: inboundEmails.senderAuth,
      authResultsRaw: inboundEmails.authResultsRaw,
      originalSenderAuth: inboundEmails.originalSenderAuth,
      inReplyTo: inboundEmails.inReplyTo,
      emailReferences: inboundEmails.emailReferences,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundEmailId))
    .limit(1);
  if (!row) {
    summary.skipped = "no-row";
    return done();
  }
  const from = normalizeEmailAddress(row.fromAddress);
  if (!from) {
    summary.skipped = "no-sender";
    return done();
  }
  if (from.endsWith(`@${OWN_DOMAIN}`) || from.endsWith(`.${OWN_DOMAIN}`)) {
    summary.skipped = "own-domain";
    return done();
  }

  const basisFor = new Map<string, CaptureBasis[]>();
  const add = (id: string, b: CaptureBasis) => basisFor.set(id, [...(basisFor.get(id) ?? []), b]);
  for (const r of await db
    .select({ id: promoters.id })
    .from(promoters)
    .where(sql`lower(${promoters.contactEmail}) = ${from}`))
    add(r.id, "contact-email");
  const thread = await promotersFromThread(db, row.inReplyTo, row.emailReferences);
  summary.ambiguousThreads = thread.ambiguous;
  for (const id of thread.ids) add(id, "reply-to-our-mail");

  const promoterIds = [...basisFor.keys()].slice(0, MAX_PROMOTERS);
  summary.promoters = promoterIds.length;
  if (promoterIds.length === 0) return done();

  const sites = new Map(
    (
      await db
        .select({ id: promoters.id, website: promoters.website })
        .from(promoters)
        .where(inArray(promoters.id, promoterIds))
    ).map((p) => [p.id, p.website])
  );
  const name = row.fromDisplayName?.trim().slice(0, 200) || null;

  for (const promoterId of promoterIds) {
    const basis = basisFor.get(promoterId)!;
    const verdict = decidePromoterContactDomain(
      {
        fromAddress: from,
        dmarcResult: row.dmarcResult,
        authResultsRaw: row.authResultsRaw,
        originalSenderAuth: row.originalSenderAuth,
      },
      sites.get(promoterId) ?? null
    );
    const status: PromoterContactStatus = verdict.qualifies ? "validated" : "candidate";
    const [existing] = await db
      .select({
        id: promoterContacts.id,
        status: promoterContacts.status,
        firstValidatedAt: promoterContacts.firstValidatedAt,
        lastHeardAt: promoterContacts.lastHeardAt,
      })
      .from(promoterContacts)
      .where(and(eq(promoterContacts.promoterId, promoterId), eq(promoterContacts.email, from)))
      .limit(1);

    const plan = planPromoterContactWrite({
      writer: "capture",
      existing: existing ?? null,
      promoterId,
      email: from,
      fields: {
        name,
        validationMethod: verdict.qualifies ? "domain_verified" : "replied_to_our_mail",
        validationEvidence: `inbound ${inboundEmailId}: ${basis.join(" + ")}; ${verdict.reason}`,
        inboundEmailId,
        senderAuth: contactSenderAuth(row.senderAuth),
        authDomain: verdict.authDomain,
        authDomainMatchesPromoter: verdict.matchesPromoter,
        status,
      },
      heardAt: row.receivedAt ?? null,
      actor: CAPTURE_ACTOR,
      now,
    });

    if (plan.kind === "insert") {
      const id = crypto.randomUUID();
      const res = await db
        .insert(promoterContacts)
        .values({ id, ...(plan.values as typeof promoterContacts.$inferInsert) })
        .onConflictDoNothing()
        .returning({ id: promoterContacts.id });
      if (res.length === 0) {
        summary.unchanged++; // lost a race to a concurrent writer; that row stands
        continue;
      }
      summary.inserted++;
      await db.insert(adminActions).values({
        action:
          status === "validated" ? "promoter_contact.auto_validated" : "promoter_contact.captured",
        actorUserId: null,
        targetType: "promoter_contact",
        targetId: id,
        payloadJson: JSON.stringify({
          promoterId,
          inboundEmailId,
          basis,
          status,
          reason: verdict.reason,
        }),
        createdAt: now,
      });
    } else if (plan.kind === "update") {
      await db.update(promoterContacts).set(plan.set).where(eq(promoterContacts.id, plan.id));
      if (plan.promoted) {
        summary.promoted++;
        await db.insert(adminActions).values({
          action: "promoter_contact.auto_validated",
          actorUserId: null,
          targetType: "promoter_contact",
          targetId: plan.id,
          payloadJson: JSON.stringify({
            promoterId,
            inboundEmailId,
            basis,
            reason: verdict.reason,
          }),
          createdAt: now,
        });
      } else summary.refreshed++;
    } else summary.unchanged++;
  }
  return done();
}
