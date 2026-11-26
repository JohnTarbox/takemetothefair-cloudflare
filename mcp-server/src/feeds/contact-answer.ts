/**
 * OPE-1613 — a contact's answer to one feed-discrepancy question.
 *
 * Only a VALIDATED contact of the event's own promoter, writing in a message
 * that passed aligned DMARC (`inbound_emails.sender_auth = 'pass'`, the same
 * bar OPE-1506 holds), can set and pin a value. Anyone else's answer is STAGED:
 * recorded on the discrepancy and the audit log, nothing written, discrepancy
 * left open for an operator.
 *
 * A pinned answer writes the value (date/time fields; see provenance.ts),
 * records a `validated_contact` citation ("confirmed by <contact>, validated
 * <date>, inbound <id>"), releases any earlier pin on the field as
 * `superseded`, pins the field with the feed's then-wrong value beside it, and
 * resolves the discrepancy as `promoter_reply`.
 *
 * This takes ONE answer for ONE discrepancy. Splitting a reply email into
 * answers is the caller's job (an operator or agent reading the reply) — the
 * automatic reply parser is not in this slice.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  adminActions,
  eventDiscrepancies,
  eventFieldPins,
  events,
  inboundEmails,
  promoterContacts,
} from "../schema.js";
import type { Db } from "../db.js";
import { FEED_DETECTOR, parseFeedNotes } from "./ingest.js";
import {
  applyFieldValue,
  getActivePin,
  normalizeAnswer,
  releasePin,
  writeProvenanceCitation,
  type FeedField,
} from "./provenance.js";

export type ContactAnswerResult =
  | {
      outcome: "pinned";
      discrepancy_id: string;
      field: FeedField;
      value: string;
      applied: boolean;
      apply_note: string;
      pin_id: string;
      citation_id: string;
    }
  | { outcome: "staged"; discrepancy_id: string; reason: string }
  | { outcome: "refused"; reason: string };

const bareAddress = (from: string) => {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
};

export async function recordContactAnswer(
  db: Db,
  args: {
    discrepancyId: string;
    answer: string;
    inboundEmailId: string;
    actor: string;
    now: Date;
  }
): Promise<ContactAnswerResult> {
  const { now } = args;
  const [d] = await db
    .select()
    .from(eventDiscrepancies)
    .where(eq(eventDiscrepancies.id, args.discrepancyId))
    .limit(1);
  if (!d) return { outcome: "refused", reason: "discrepancy not found" };
  if (d.detectedBy !== FEED_DETECTOR) {
    return { outcome: "refused", reason: `discrepancy is ${d.detectedBy}, not ${FEED_DETECTOR}` };
  }
  if (d.resolutionStatus !== "open") {
    return { outcome: "refused", reason: `discrepancy is already ${d.resolutionStatus}` };
  }
  const notes = parseFeedNotes(d.notes);
  if (!notes) return { outcome: "refused", reason: "discrepancy has no feed notes" };
  const field = notes.field;
  const value = normalizeAnswer(field, args.answer);
  if (value === null) {
    return { outcome: "refused", reason: `"${args.answer}" is not a usable ${field}` };
  }

  const [ev] = await db
    .select({ promoterId: events.promoterId })
    .from(events)
    .where(eq(events.id, d.eventId))
    .limit(1);
  const [mail] = await db
    .select({
      id: inboundEmails.id,
      fromAddress: inboundEmails.fromAddress,
      senderAuth: inboundEmails.senderAuth,
      receivedAt: inboundEmails.receivedAt,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, args.inboundEmailId))
    .limit(1);
  if (!ev || !mail) {
    return { outcome: "refused", reason: !ev ? "event not found" : "inbound email not found" };
  }
  const from = bareAddress(mail.fromAddress);
  const [contact] = await db
    .select({
      id: promoterContacts.id,
      email: promoterContacts.email,
      firstValidatedAt: promoterContacts.firstValidatedAt,
    })
    .from(promoterContacts)
    .where(
      and(
        eq(promoterContacts.promoterId, ev.promoterId),
        sql`lower(${promoterContacts.email}) = ${from}`,
        eq(promoterContacts.status, "validated")
      )
    )
    .limit(1);

  const stageReason = !contact
    ? `${from} is not a validated contact of this event's promoter`
    : mail.senderAuth !== "pass"
      ? `the message's sender_auth is ${mail.senderAuth ?? "NULL"}, not an aligned DMARC pass`
      : null;
  if (stageReason) {
    const staged = {
      answer: args.answer,
      normalized: value,
      from,
      inbound_email_id: mail.id,
      at: now.toISOString(),
      reason: stageReason,
    };
    const prev = parseFeedNotes(d.notes) as
      (Record<string, unknown> & { staged_answers?: unknown[] }) | null;
    await db
      .update(eventDiscrepancies)
      .set({
        notes: JSON.stringify({
          ...prev,
          staged_answers: [...(prev?.staged_answers ?? []), staged],
        }),
      })
      .where(eq(eventDiscrepancies.id, d.id));
    await db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action: "feed.answer_staged",
      actorUserId: args.actor,
      targetType: "event_discrepancy",
      targetId: d.id,
      payloadJson: JSON.stringify(staged),
      createdAt: now,
    });
    return { outcome: "staged", discrepancy_id: d.id, reason: stageReason };
  }

  const validated = contact!.firstValidatedAt?.toISOString().slice(0, 10) ?? "unknown date";
  const applied = await applyFieldValue(db, d.eventId, field, value);
  const citationId = await writeProvenanceCitation(db, {
    eventId: d.eventId,
    field,
    value,
    sourceUrl: `mailto:${contact!.email}`,
    sourceName: `confirmed by ${contact!.email}, validated ${validated}, inbound ${mail.id}`,
    sourceType: "user_submitted",
    provenanceKind: "validated_contact",
    notes: `OPE-1613 — answer to feed discrepancy ${d.id}`,
    now,
  });
  const prior = await getActivePin(db, d.eventId, field);
  if (prior) await releasePin(db, prior.id, "superseded", now);
  const pinId = crypto.randomUUID();
  await db.insert(eventFieldPins).values({
    id: pinId,
    eventId: d.eventId,
    fieldName: field,
    pinnedValue: value,
    feedValueAtPin: d.divergentValue,
    contactId: contact!.id,
    inboundEmailId: mail.id,
    citationId,
    discrepancyId: d.id,
    status: "active",
    stillWrongNotesSent: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(eventDiscrepancies)
    .set({
      resolutionStatus:
        d.authoritativeValue !== null && d.authoritativeValue === value
          ? "resolved_authoritative"
          : "resolved_divergent",
      resolvedValue: value,
      resolutionSource: "promoter_reply",
      resolvedAt: now,
    })
    .where(eq(eventDiscrepancies.id, d.id));
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action: "feed.answer_pinned",
    actorUserId: args.actor,
    targetType: "event",
    targetId: d.eventId,
    payloadJson: JSON.stringify({
      discrepancy_id: d.id,
      field,
      old_value: d.authoritativeValue,
      feed_value: d.divergentValue,
      value,
      applied: applied.applied,
      apply_note: applied.reason,
      pin_id: pinId,
      citation_id: citationId,
      contact_id: contact!.id,
      inbound_email_id: mail.id,
    }),
    createdAt: now,
  });
  return {
    outcome: "pinned",
    discrepancy_id: d.id,
    field,
    value,
    applied: applied.applied,
    apply_note: applied.reason,
    pin_id: pinId,
    citation_id: citationId,
  };
}
