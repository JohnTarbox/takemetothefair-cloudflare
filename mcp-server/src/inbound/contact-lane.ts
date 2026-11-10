/**
 * OPE-1510 — the contact-mail lane. John's rulings: information from a known
 * contact is our most trusted source, every contact who sends us information
 * gets a thank-you, and every reply to one is drafted for his approval.
 *
 * For a known contact's message whose reply would have been a generic ack:
 *   - the ack does not go, and nothing automatic goes in its place;
 *   - one `contact` obligation opens, due in one business day;
 *   - one draft is queued in the operator draft queue.
 *
 * ── One message, one obligation ─────────────────────────────────────────────
 * A multi-intent email is a parent row plus a child per intent, each child with
 * its own workflow, racing. Every child runs this and they all converge: the
 * obligation is the one on the parent (an open one a handler opened is moved
 * there), duplicates in the family close as `duplicate`, and the draft is unique
 * on the inbound id. A later message on a thread already owed a reply joins that
 * obligation instead of opening another.
 *
 * ── The draft-only rule is absolute ─────────────────────────────────────────
 * Nothing here sends. A draft reaches a person only through
 * review_operator_draft, on John's approval.
 */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { extractEmailAddress, replySubject } from "@takemetothefair/utils";
import {
  adminActions,
  events,
  inboundEmails,
  operatorOutboundDrafts,
  PENDING_REPLY_STATUS,
  SUPPORT_OBLIGATION_KIND,
  SUPPORT_OBLIGATION_STATUS,
  supportObligations,
} from "../schema.js";
import type { Db } from "../db.js";
import { ledgerEmailSend } from "../mailer.js";
import { isZeroConfidenceUnclear } from "../email-handlers/automated-mail.js";
import type { AppliedField } from "../email-handlers/enrich-auto-apply.js";
import { ENRICH_APPLIED_ACTION } from "../email-handlers/enrich-auto-apply.js";
import type { ReplyKind } from "../email-handlers/types.js";
import { isEmailSuppressed } from "../tools/admin-send-vendor-email.js";
import { ref } from "./crossing-ledger.js";
import { contactObligationTarget } from "./business-days.js";
import { resolveKnownContact, type KnownContact } from "./known-contact.js";

/** John's Decision 1 (A), 2026-11-10: the acks a known contact never receives. */
export const CONTACT_LANE_ACK_KINDS: readonly ReplyKind[] = [
  "correction-ack",
  "support-ack",
  "press-ack",
  "thread-reply-ack",
  "source-suggestion-ack",
  "vendor-inquiry-ack",
  "claim-request-ack",
  "problem-report-ack",
];

export const CONTACT_LANE_COMPOSER = "system:contact-lane";
const SITE = "https://meetmeatthefair.com";

// ── The draft (template approved verbatim by John, 2026-11-10) ───────────────

const ORGANIZATION_WORD =
  /\b(inc|llc|fairs?|festivals?|events?|association|assoc|club|society|committee|foundation|company|co|markets?|shows?|productions?|expo|info|team|office|admin)\b/i;

/** A first name only when the name plainly belongs to a person. */
export function firstNameFrom(name: string | null | undefined): string | null {
  const cleaned = (name ?? "").replace(/"/g, "").trim();
  if (!cleaned || cleaned.includes("@") || ORGANIZATION_WORD.test(cleaned)) return null;
  const parts = cleaned.split(/\s+/);
  if (parts.length > 3) return null;
  return /^\p{Lu}[\p{L}'’-]+$/u.test(parts[0]) ? parts[0] : null;
}

export function draftSubject(subject: string | null | undefined): string {
  return replySubject(subject, "your note to Meet Me at the Fair");
}

function fieldLabel(field: string): string {
  const words = field.replace(/_cents$/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fieldValue(field: string, value: unknown): string {
  if (field.endsWith("_cents") && typeof value === "number") {
    return `$${(value / 100).toFixed(2)}`;
  }
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

export interface DraftListing {
  eventName: string;
  eventSlug: string;
  fields: AppliedField[];
}

export function composeContactDraft(input: {
  subject: string | null | undefined;
  firstName: string | null;
  listings: DraftListing[];
}): { subject: string; bodyText: string } {
  const blocks: string[] = [
    input.firstName ? `Hello ${input.firstName},` : "Hello,",
    "Thank you for writing.",
  ];

  for (const listing of input.listings) {
    const lines = listing.fields.map((f) => {
      const was =
        f.old !== null && f.old !== undefined && f.old !== ""
          ? ` (was ${fieldValue(f.field, f.old)})`
          : "";
      return `– ${fieldLabel(f.field)}: ${fieldValue(f.field, f.new)}${was}`;
    });
    blocks.push(
      [
        `I've updated ${listing.eventName} on Meet Me at the Fair with what you sent:`,
        ...lines,
        `${SITE}/events/${listing.eventSlug}`,
      ].join("\n")
    );
    for (const f of listing.fields) {
      if (f.conflictWithSourceUrl) {
        blocks.push(
          `Your page at ${f.conflictWithSourceUrl} still shows ${fieldValue(f.field, f.old)}. ` +
            `You may want to update it so the two match.`
        );
      }
    }
  }

  if (input.listings.length === 0) {
    blocks.push("I've read your note and will follow up if I need anything more.");
  }

  blocks.push(`John\n${SITE}`);
  return { subject: draftSubject(input.subject), bodyText: blocks.join("\n\n") };
}

/** Every field auto-applied from this message, grouped by the listing it changed. */
async function loadAppliedListings(db: Db, familyIds: string[]): Promise<DraftListing[]> {
  const rows = await db
    .select({ eventId: adminActions.targetId, payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, ENRICH_APPLIED_ACTION),
        inArray(
          sql<string>`json_extract(${adminActions.payloadJson}, '$.inboundEmailId')`,
          familyIds
        )
      )
    );
  const byEvent = new Map<string, AppliedField[]>();
  for (const r of rows) {
    if (!r.eventId || !r.payloadJson) continue;
    let fields: AppliedField[] = [];
    try {
      const parsed = JSON.parse(r.payloadJson) as { fields?: AppliedField[] };
      fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    } catch {
      continue; // one unreadable audit row must not cost the person their draft
    }
    byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), ...fields]);
  }
  if (byEvent.size === 0) return [];
  const eventRows = await db
    .select({ id: events.id, name: events.name, slug: events.slug })
    .from(events)
    .where(inArray(events.id, [...byEvent.keys()]));
  return eventRows.map((e) => ({
    eventName: e.name,
    eventSlug: e.slug,
    fields: byEvent.get(e.id) ?? [],
  }));
}

// ── The lane ─────────────────────────────────────────────────────────────────

export type ContactLaneSkip =
  | "no-row"
  | "unknown-sender"
  | "not-a-generic-ack"
  | "conversation-closed"
  | "newsletter"
  | "zero-confidence-unclear"
  | "suppressed";

export interface ContactLaneOutcome {
  fired: boolean;
  skip: ContactLaneSkip | null;
  basis: KnownContact["basis"] | null;
  obligationRef: string | null;
  draftId: string | null;
}

interface ObligationRow {
  id: string;
  inboundEmailId: string;
  kind: string;
  targetAt: Date | null;
}

/** The single open obligation for this message, created or converted. */
async function settleObligation(
  db: Db,
  args: {
    rootId: string;
    familyIds: string[];
    threadId: string | null;
    fromAddress: string;
    subject: string | null;
    classifiedConfidence: number | null;
    openedAt: Date;
    targetAt: Date;
  }
): Promise<ObligationRow | null> {
  const open = (await db
    .select({
      id: supportObligations.id,
      inboundEmailId: supportObligations.inboundEmailId,
      kind: supportObligations.kind,
      targetAt: supportObligations.targetAt,
    })
    .from(supportObligations)
    .where(
      and(
        eq(supportObligations.status, SUPPORT_OBLIGATION_STATUS.OPEN),
        or(
          inArray(supportObligations.inboundEmailId, args.familyIds),
          args.threadId
            ? inArray(
                supportObligations.inboundEmailId,
                db
                  .select({ id: inboundEmails.id })
                  .from(inboundEmails)
                  .where(eq(inboundEmails.threadId, args.threadId))
              )
            : undefined
        )
      )
    )
    .orderBy(asc(supportObligations.openedAt), asc(supportObligations.id))) as ObligationRow[];

  // The parent's row wins when it exists, so concurrent siblings pick the same
  // one; otherwise the oldest, which is also deterministic.
  const keep = open.find((o) => o.inboundEmailId === args.rootId) ?? open[0];
  if (!keep) {
    await db
      .insert(supportObligations)
      .values({
        id: crypto.randomUUID(),
        inboundEmailId: args.rootId,
        fromAddress: extractEmailAddress(args.fromAddress),
        subject: args.subject,
        classifiedConfidence: args.classifiedConfidence,
        openedAt: args.openedAt,
        status: SUPPORT_OBLIGATION_STATUS.OPEN,
        kind: SUPPORT_OBLIGATION_KIND.CONTACT,
        targetAt: args.targetAt,
      })
      .onConflictDoNothing();
    const [row] = await db
      .select({
        id: supportObligations.id,
        inboundEmailId: supportObligations.inboundEmailId,
        kind: supportObligations.kind,
        targetAt: supportObligations.targetAt,
        status: supportObligations.status,
      })
      .from(supportObligations)
      .where(eq(supportObligations.inboundEmailId, args.rootId))
      .limit(1);
    // Already closed (a replay of a message someone has answered): owe nothing new.
    return row && row.status === SUPPORT_OBLIGATION_STATUS.OPEN ? row : null;
  }

  const familySet = new Set(args.familyIds);
  for (const dup of open) {
    if (dup.id === keep.id || !familySet.has(dup.inboundEmailId)) continue;
    await db
      .update(supportObligations)
      .set({
        status: SUPPORT_OBLIGATION_STATUS.DUPLICATE,
        closedAt: new Date(),
        closedBy: CONTACT_LANE_COMPOSER,
        closeNote: `Same message as obligation ${keep.id} (OPE-1510: one message, one obligation).`,
      })
      .where(
        and(
          eq(supportObligations.id, dup.id),
          eq(supportObligations.status, SUPPORT_OBLIGATION_STATUS.OPEN)
        )
      );
  }

  const inboundEmailId =
    familySet.has(keep.inboundEmailId) && keep.inboundEmailId !== args.rootId
      ? args.rootId
      : keep.inboundEmailId;
  const targetAt =
    keep.kind === SUPPORT_OBLIGATION_KIND.CONTACT && keep.targetAt ? keep.targetAt : args.targetAt;
  await db
    .update(supportObligations)
    .set({ inboundEmailId, kind: SUPPORT_OBLIGATION_KIND.CONTACT, targetAt })
    .where(eq(supportObligations.id, keep.id));
  return { ...keep, inboundEmailId, kind: SUPPORT_OBLIGATION_KIND.CONTACT, targetAt };
}

export async function runContactLane(
  db: Db,
  input: {
    messageRowId: string;
    replyKind: ReplyKind | null;
    /** A fan-out loser (or similar) has no ack of its own to ledger as held. */
    replyAlreadySuppressed: boolean;
    closedBySender: boolean;
    isNewsletter: boolean;
    now?: Date;
  }
): Promise<ContactLaneOutcome> {
  const skipped = (
    skip: ContactLaneSkip,
    basis: KnownContact["basis"] | null = null
  ): ContactLaneOutcome => ({ fired: false, skip, basis, obligationRef: null, draftId: null });

  const now = input.now ?? new Date();
  const [row] = await db
    .select({
      fromAddress: inboundEmails.fromAddress,
      fromDisplayName: inboundEmails.fromDisplayName,
      subject: inboundEmails.subject,
      parentEmailId: inboundEmails.parentEmailId,
      threadId: inboundEmails.threadId,
      receivedAt: inboundEmails.receivedAt,
      classifiedIntent: inboundEmails.classifiedIntent,
      classifiedConfidence: inboundEmails.classifiedConfidence,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, input.messageRowId))
    .limit(1);
  if (!row) return skipped("no-row");

  // Runs after promoter-contact capture, not at insert: someone answering our
  // outreach for the first time becomes a contact in that step (Debra Gallo's
  // shape), and an insert-time check would have missed exactly her.
  const known = await resolveKnownContact(db, row.fromAddress);
  if (!known) return skipped("unknown-sender");
  await db
    .update(inboundEmails)
    .set({
      knownContactBasis: known.basis,
      knownContactEntityType: known.entityType,
      knownContactEntityId: known.entityId,
    })
    .where(eq(inboundEmails.id, input.messageRowId));

  if (!input.replyKind || !CONTACT_LANE_ACK_KINDS.includes(input.replyKind)) {
    return skipped("not-a-generic-ack", known.basis);
  }
  if (input.closedBySender) return skipped("conversation-closed", known.basis);
  if (input.isNewsletter) return skipped("newsletter", known.basis);
  if (isZeroConfidenceUnclear(row.classifiedIntent, row.classifiedConfidence)) {
    return skipped("zero-confidence-unclear", known.basis);
  }
  if (await isEmailSuppressed(db, row.fromAddress)) return skipped("suppressed", known.basis);

  const rootId = row.parentEmailId ?? input.messageRowId;
  const family = await db
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(or(eq(inboundEmails.id, rootId), eq(inboundEmails.parentEmailId, rootId)));
  const familyIds = [...new Set([rootId, input.messageRowId, ...family.map((f) => f.id)])];

  const received = row.receivedAt ?? now;
  const obligation = await settleObligation(db, {
    rootId,
    familyIds,
    threadId: row.threadId ?? null,
    fromAddress: row.fromAddress,
    subject: row.subject ?? null,
    classifiedConfidence: row.classifiedConfidence ?? null,
    openedAt: received,
    targetAt: contactObligationTarget(received),
  });

  let draftId: string | null = null;
  if (obligation) {
    const composed = composeContactDraft({
      subject: row.subject,
      firstName: firstNameFrom(known.personName ?? row.fromDisplayName),
      listings: await loadAppliedListings(db, familyIds),
    });
    await db
      .insert(operatorOutboundDrafts)
      .values({
        id: crypto.randomUUID(),
        toAddress: extractEmailAddress(row.fromAddress),
        subject: composed.subject,
        bodyText: composed.bodyText,
        reason:
          `A known contact wrote in (${known.basis}), so no automatic ack went out and a ` +
          `reply is owed within one business day (OPE-1510).`,
        relatedEntityType: known.entityType,
        relatedEntityId: known.entityId,
        composedBy: CONTACT_LANE_COMPOSER,
        composedAt: now,
        status: PENDING_REPLY_STATUS.PENDING,
        inboundEmailId: obligation.inboundEmailId,
      })
      .onConflictDoNothing();
    const [draft] = await db
      .select({ id: operatorOutboundDrafts.id })
      .from(operatorOutboundDrafts)
      .where(eq(operatorOutboundDrafts.inboundEmailId, obligation.inboundEmailId))
      .limit(1);
    draftId = draft?.id ?? null;
  }

  if (!input.replyAlreadySuppressed) {
    // Ledgered as `stubbed`, like every other withheld ack, so the suppression
    // sits next to the sends it replaced.
    await ledgerEmailSend(db, {
      messageId: `reply-${input.messageRowId}`,
      recipient: row.fromAddress,
      source: `reply:${input.replyKind}`,
      subject: row.subject ?? null,
      status: "stubbed",
      provider: "stub",
      error: `suppressed: known-contact (${known.basis})`,
      inboundEmailId: input.messageRowId,
    });
  }

  return {
    fired: true,
    skip: null,
    basis: known.basis,
    obligationRef: obligation ? ref.supportObligation(obligation.id) : null,
    draftId,
  };
}
