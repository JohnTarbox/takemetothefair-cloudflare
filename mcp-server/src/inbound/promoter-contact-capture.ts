/**
 * OPE-1330 — capture a promoter contact from an inbound email.
 *
 * The workflow side of `promoter_contacts`: read the row, find the promoter(s)
 * this sender is evidence for, decide domain verification, apply the shared
 * write rule, record the step. Kept out of the workflow file so it is testable
 * against a real database (same split as newsletter-record.ts).
 *
 * A sender becomes a contact of a promoter in exactly three ways:
 *
 *   1. `contact-email` — the From address IS the promoter's `contact_email`.
 *   2. `reply-to-our-mail` — the message is a threaded reply (In-Reply-To /
 *      References) to mail WE sent to that promoter: a blog-mention notice,
 *      promoter outreach, or an operator email. The ledger row names the
 *      recipient; the recipient is traced to the promoter we wrote to. A
 *      recipient that traces to more than one promoter captures nothing.
 *   3. `website-domain` (OPE-1330 rework, 2026-10-15) — the From address's
 *      ORGANIZATIONAL domain is the promoter's own website domain. Without it,
 *      Dan Smith's three 10-14 emails from his company domain — which the
 *      sender resolver matched to bold-media on exactly this key — captured
 *      nothing, and every run read `ok`. Never for a free-mail / shared host
 *      (`isNonOwnableDomain`, on either side), and never when the domain is
 *      the website of more than one promoter (ambiguous, like a thread that
 *      traces to two). `candidate` unless the DMARC conditions in
 *      `decidePromoterContactDomain` hold, exactly as for the other two.
 *
 * All three are facts about the SENDER (its address, its domain, its thread),
 * never about the body. A fair-goer who merely mentions a promoter matches
 * none of them, and no name or title is ever parsed out of the body — the
 * display name is the only name.
 *
 * Every run records an `outcome`: `captured`, `no_promoter_match`,
 * `matched_not_captured` (≥1 promoter was matched — by the sender resolver's
 * `matched_entities` or by capture itself — and no contact was written or
 * kept; recorded as step status `skipped` with per-promoter reasons, never a
 * plain `ok`), or `skipped`.
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
import { isNonOwnableDomain, organizationalDomain } from "@takemetothefair/utils";
import { recordWorkflowStep } from "../workflow-run-log.js";

/** Outbound sources addressed to a promoter (verified against the senders). */
export const PROMOTER_OUTBOUND_SOURCES = [
  "content-links-sync.promoter-mention", // src/lib/content-links-sync.ts
  "email:promoter-outreach", // tools/admin-send-promoter-email.ts
  "operator:outbound", // tools/admin-operator-outbound.ts OPERATOR_OUTBOUND_SOURCE
] as const;

export const CAPTURE_ACTOR = "system:inbound-capture";
/** The workflow step — the heartbeat probe `promoter-contact-capture` keys on it. */
export const CAPTURE_STEP = "promoter-contacts/capture";
/** The admin re-capture tool's step name: deliberately NOT the heartbeat's. */
export const RECAPTURE_STEP = "promoter-contacts/recapture";
const OWN_DOMAIN = "meetmeatthefair.com";
/** Long References chains: the newest ids are the ones that name our mail. */
const MAX_THREAD_IDS = 20;
const MAX_PROMOTERS = 10;

export type CaptureBasis = "contact-email" | "reply-to-our-mail" | "website-domain";

export type CaptureOutcome = "captured" | "no_promoter_match" | "matched_not_captured" | "skipped";

/**
 * A promoter the sender resolver matched that capture did not take, and why.
 * `expected` reasons are by design (a brand-name hit says nothing about the
 * sender); anything else is the 10-14 shape — a match capture should have
 * taken and did not — and the workflow logs it as a warning.
 */
export interface NotCaptured {
  promoterId: string;
  /** The resolver's basis (`matched_entities[].basis`). */
  basis: string;
  reason: string;
  expected: boolean;
}

export interface CaptureSummary {
  outcome: CaptureOutcome;
  promoters: number;
  inserted: number;
  promoted: number;
  refreshed: number;
  unchanged: number;
  ambiguousThreads: number;
  /** 1 when the sender's org domain is the website of >1 promoter (no domain basis). */
  ambiguousDomain: number;
  /** Distinct promoters the sender resolver put in `matched_entities`. */
  resolverPromoters: number;
  notCaptured: NotCaptured[];
  /**
   * DMARC passed on an ownable domain that is no promoter's website and the
   * resolver matched no promoter — the 2026-10-14 "an organizer we don't list
   * yet is dropped" gap. Counted here; keeping such senders is deferred.
   */
  alignedUnknownDomain: boolean;
  skipped: string | null;
}

/** The promoter whose website's org domain IS the sender's (own domains only). */
async function promotersFromDomain(
  db: Db,
  senderOrg: string | null
): Promise<{ ids: string[]; ambiguous: boolean; reason: string }> {
  if (!senderOrg) return { ids: [], ambiguous: false, reason: "no parseable sender domain" };
  if (isNonOwnableDomain(senderOrg))
    return { ids: [], ambiguous: false, reason: `${senderOrg} is a shared or free-mail domain` };
  // instr, not LIKE: the pattern is built from the SENDER's domain and D1
  // throws on a LIKE pattern over 50 chars. Only a prefilter — equality of
  // the organizational domains below is the match.
  const rows = await db
    .select({ id: promoters.id, website: promoters.website })
    .from(promoters)
    .where(sql`instr(lower(${promoters.website}), ${senderOrg}) > 0`)
    .limit(200);
  const ids = rows
    // senderOrg is already known ownable, so an equal site domain is too.
    .filter((r) => organizationalDomain(r.website) === senderOrg)
    .map((r) => r.id);
  if (ids.length > 1)
    return {
      ids: [],
      ambiguous: true,
      reason: `${senderOrg} is the website domain of ${ids.length} promoters (ambiguous)`,
    };
  return {
    ids,
    ambiguous: false,
    reason: ids.length ? "" : `${senderOrg} is no promoter's website`,
  };
}

/** `inbound_emails.matched_entities` → its promoter matches, tolerating junk. */
function resolverPromoterMatches(json: string | null): Array<{ entityId: string; basis: string }> {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{ entityId: string; basis: string }> = [];
  for (const m of arr as Array<Record<string, unknown> | null>) {
    if (m && m.entityType === "promoter" && typeof m.entityId === "string")
      out.push({ entityId: m.entityId, basis: String(m.basis ?? "unknown") });
  }
  return out;
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

/** The run's outcome, from its counts. Exported for the workflow's warning. */
export function captureOutcome(s: CaptureSummary): CaptureOutcome {
  if (s.skipped) return "skipped";
  const kept = s.inserted + s.promoted + s.refreshed + s.unchanged;
  if (kept > 0) return "captured";
  return s.promoters > 0 || s.resolverPromoters > 0 ? "matched_not_captured" : "no_promoter_match";
}

/**
 * Is this run worth a warning? Yes when a resolver match was dropped for a
 * reason that is not by design, or capture itself found a promoter and still
 * kept no contact. A by-design miss (brand-name, ambiguous/free-mail domain)
 * is recorded as `matched_not_captured` but does not warn.
 */
export function captureNeedsWarning(s: CaptureSummary): boolean {
  if (s.outcome === "skipped") return false;
  if (s.outcome === "matched_not_captured" && s.promoters > 0) return true;
  return s.notCaptured.some((n) => !n.expected);
}

export async function capturePromoterContacts(
  db: Db,
  inboundEmailId: string,
  instanceId: string,
  now: Date = new Date(),
  /**
   * The admin re-capture tool records under its OWN step name, so a manual
   * run can never stand in as heartbeat evidence that the workflow step runs.
   */
  stepName: string = CAPTURE_STEP
): Promise<CaptureSummary> {
  const summary: CaptureSummary = {
    outcome: "skipped",
    promoters: 0,
    inserted: 0,
    promoted: 0,
    refreshed: 0,
    unchanged: 0,
    ambiguousThreads: 0,
    ambiguousDomain: 0,
    resolverPromoters: 0,
    notCaptured: [],
    alignedUnknownDomain: false,
    skipped: null,
  };
  const done = async () => {
    summary.outcome = captureOutcome(summary);
    await recordWorkflowStep(db, {
      instanceId,
      workflowName: "inbound-email",
      inboundEmailId,
      stepName,
      // A match that captured nothing is NOT a plain ok: 28 runs of `ok` hid a
      // capture that never took a website-domain match (review, 2026-10-15).
      status:
        summary.outcome === "captured" || summary.outcome === "no_promoter_match"
          ? "ok"
          : "skipped",
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
      matchedEntities: inboundEmails.matchedEntities,
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
  const senderOrg = organizationalDomain(from);
  const byDomain = await promotersFromDomain(db, senderOrg);
  if (byDomain.ambiguous) summary.ambiguousDomain = 1;
  for (const id of byDomain.ids) add(id, "website-domain");

  const promoterIds = [...basisFor.keys()].slice(0, MAX_PROMOTERS);
  summary.promoters = promoterIds.length;

  // Every promoter the sender resolver matched that capture is NOT taking,
  // with its reason — "matched but captured 0" must never read as ok again.
  const resolverMatches = resolverPromoterMatches(row.matchedEntities);
  summary.resolverPromoters = new Set(resolverMatches.map((m) => m.entityId)).size;
  const taken = new Set(promoterIds);
  for (const m of resolverMatches) {
    if (taken.has(m.entityId) || summary.notCaptured.some((n) => n.promoterId === m.entityId))
      continue;
    let reason = `resolver matched on ${m.basis} but capture found no basis for this promoter`;
    let expected = false;
    if (m.basis === "brand-name") {
      reason = "a brand-name match is not evidence about the sender";
      expected = true;
    } else if (m.basis === "website-domain" && byDomain.reason) {
      reason = byDomain.reason;
      expected = true;
    }
    summary.notCaptured.push({ promoterId: m.entityId, basis: m.basis, reason, expected });
  }

  if (promoterIds.length === 0) {
    summary.alignedUnknownDomain =
      (row.dmarcResult ?? "").toLowerCase() === "pass" &&
      !!senderOrg &&
      !isNonOwnableDomain(senderOrg) &&
      !byDomain.ambiguous &&
      summary.resolverPromoters === 0;
    return done();
  }

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
        validationMethod: verdict.qualifies
          ? "domain_verified"
          : basis.length === 1 && basis[0] === "website-domain"
            ? // Only the From domain ties them to the promoter, unproven: it is
              // the sender's own assertion. (contact-email keeps its old value.)
              "self_asserted"
            : "replied_to_our_mail",
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
