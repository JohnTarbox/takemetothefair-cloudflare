/**
 * OPE-1613 — one batched question email per validated contact per cycle,
 * composed into the OPERATOR DRAFT QUEUE. Nothing here sends: a draft goes out
 * only when John approves it through `review_operator_draft` (2026-10-20 rule:
 * every reply to a contact is drafted for approval).
 *
 * The limit is the feed's own (`promoter_event_feeds.batch_min_interval_days`,
 * default 7 = one batch per contact per week). It reads ONLY
 * `feed_discrepancy_batches` — never `promoter_outreach_attempts`, so the
 * 5-per-week pre-season outreach cap and this limit cannot consume each other
 * (John 2026-11-10: "their own limit").
 *
 * A pinned field whose feed still shows the wrong value gets ONE "your feed
 * still says X" line in a later batch, at most once (`still_wrong_notes_sent`).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  eventDiscrepancies,
  eventFieldPins,
  events,
  feedDiscrepancyBatches,
  operatorOutboundDrafts,
  promoterContacts,
  promoterEventFeeds,
  promoterFeedItems,
  promoters,
} from "../schema.js";
import type { Db } from "../db.js";
import { FEED_DETECTOR, parseFeedNotes } from "./ingest.js";
import { feedFieldValues, sameValue, type FeedField } from "./provenance.js";
import type { FeedEvent } from "./tec.js";

export const FEED_BATCH_COMPOSER = "developer-claude-code:feed-discrepancy";

export type BatchResult =
  | {
      composed: true;
      dry_run: boolean;
      batch_id: string | null;
      draft_id: string | null;
      to: string;
      subject: string;
      body: string;
      questions: number;
      still_wrong_notes: number;
    }
  | { composed: false; reason: string; next_allowed_at?: string };

const DAY_MS = 86_400_000;

export async function composeFeedDiscrepancyBatch(
  db: Db,
  args: { promoterId: string; now: Date; dryRun: boolean }
): Promise<BatchResult> {
  const { promoterId, now, dryRun } = args;
  const [promoter] = await db
    .select({ id: promoters.id, name: promoters.companyName })
    .from(promoters)
    .where(eq(promoters.id, promoterId))
    .limit(1);
  if (!promoter) return { composed: false, reason: "promoter not found" };

  const feeds = await db
    .select({ interval: promoterEventFeeds.batchMinIntervalDays, id: promoterEventFeeds.id })
    .from(promoterEventFeeds)
    .where(eq(promoterEventFeeds.promoterId, promoterId));
  if (!feeds.length) return { composed: false, reason: "promoter has no registered feed" };
  // The strictest configured interval wins when a promoter has several feeds.
  const intervalDays = Math.max(...feeds.map((f) => f.interval));

  const [contact] = await db
    .select({ id: promoterContacts.id, email: promoterContacts.email, name: promoterContacts.name })
    .from(promoterContacts)
    .where(
      and(eq(promoterContacts.promoterId, promoterId), eq(promoterContacts.status, "validated"))
    )
    .orderBy(desc(promoterContacts.lastHeardAt))
    .limit(1);
  if (!contact) {
    return {
      composed: false,
      reason: "no validated contact for this promoter — questions stay open",
    };
  }

  const [last] = await db
    .select({ composedAt: feedDiscrepancyBatches.composedAt })
    .from(feedDiscrepancyBatches)
    .where(eq(feedDiscrepancyBatches.contactId, contact.id))
    .orderBy(desc(feedDiscrepancyBatches.composedAt))
    .limit(1);
  if (last && now.getTime() - last.composedAt.getTime() < intervalDays * DAY_MS) {
    const next = new Date(last.composedAt.getTime() + intervalDays * DAY_MS);
    return {
      composed: false,
      reason: `limit: one batch per ${intervalDays} days; last batch ${last.composedAt.toISOString()}`,
      next_allowed_at: next.toISOString(),
    };
  }

  const promoterEvents = await db
    .select({ id: events.id, name: events.name })
    .from(events)
    .where(eq(events.promoterId, promoterId));
  const eventIds = promoterEvents.map((e) => e.id);
  if (!eventIds.length) return { composed: false, reason: "promoter has no events" };

  // Already-asked discrepancy ids, so a question is never batched twice.
  const priorBatches = await db
    .select({ ids: feedDiscrepancyBatches.discrepancyIds })
    .from(feedDiscrepancyBatches)
    .where(eq(feedDiscrepancyBatches.promoterId, promoterId));
  const asked = new Set(priorBatches.flatMap((b) => JSON.parse(b.ids) as string[]));

  // D1 caps bound parameters at 100; chunk the event-id IN list.
  const open: Array<typeof eventDiscrepancies.$inferSelect> = [];
  const livePins: Array<typeof eventFieldPins.$inferSelect> = [];
  for (let i = 0; i < eventIds.length; i += 90) {
    const chunk = eventIds.slice(i, i + 90);
    open.push(
      ...(await db
        .select()
        .from(eventDiscrepancies)
        .where(
          and(
            inArray(eventDiscrepancies.eventId, chunk),
            eq(eventDiscrepancies.detectedBy, FEED_DETECTOR),
            eq(eventDiscrepancies.resolutionStatus, "open")
          )
        ))
    );
    livePins.push(
      ...(await db
        .select()
        .from(eventFieldPins)
        .where(and(inArray(eventFieldPins.eventId, chunk), eq(eventFieldPins.status, "active"))))
    );
  }
  const toAsk = open
    .filter((d) => !asked.has(d.id))
    .map((d) => ({ d, n: parseFeedNotes(d.notes) }))
    .filter(
      (x): x is { d: (typeof open)[number]; n: NonNullable<ReturnType<typeof parseFeedNotes>> } =>
        !!x.n
    )
    .sort((a, b) => a.d.detectedAt.getTime() - b.d.detectedAt.getTime());

  // Still-wrong pins: the latest snapshot of the linked feed item still shows
  // the value the contact corrected.
  const stillWrong: Array<{ pin: (typeof livePins)[number]; line: string }> = [];
  for (const pin of livePins.filter((p) => p.stillWrongNotesSent < 1)) {
    const [item] = await db
      .select({ snapshot: promoterFeedItems.snapshot })
      .from(promoterFeedItems)
      .where(eq(promoterFeedItems.eventId, pin.eventId))
      .orderBy(desc(promoterFeedItems.lastSeenAt))
      .limit(1);
    if (!item?.snapshot) continue;
    const feedVal = feedFieldValues(JSON.parse(item.snapshot) as FeedEvent)[
      pin.fieldName as FeedField
    ];
    if (
      feedVal !== undefined &&
      sameValue(pin.fieldName as FeedField, feedVal, pin.feedValueAtPin)
    ) {
      const evName = promoterEvents.find((e) => e.id === pin.eventId)?.name ?? "an event";
      stillWrong.push({
        pin,
        line: `${evName}: thanks for confirming ${pin.pinnedValue}. Your calendar still shows ${pin.feedValueAtPin}, in case your web person wants to fix it.`,
      });
    }
  }

  if (!toAsk.length && !stillWrong.length) return { composed: false, reason: "nothing to ask" };

  const greeting = contact.name ? `Hi ${contact.name.split(/\s+/)[0]},` : "Hello,";
  const lines: string[] = [
    greeting,
    "",
    `We list ${promoter.name}'s events on Meet Me at the Fair and read them from your website calendar. A few entries look off. Could you tell us which is right? We'll update our listing from your answer, even if the calendar isn't changed yet.`,
    "",
  ];
  toAsk.forEach((x, i) => {
    lines.push(`${i + 1}. ${x.n.question}`);
    lines.push(`   (For your web person: ${x.n.feed_fix_note})`);
  });
  if (stillWrong.length) {
    if (toAsk.length) lines.push("");
    for (const s of stillWrong) lines.push(`- ${s.line}`);
  }
  lines.push("", "Thank you,", "Meet Me at the Fair");
  const body = lines.join("\n");
  const subject = toAsk.length
    ? `Quick check on ${toAsk.length} of your calendar entr${toAsk.length === 1 ? "y" : "ies"}`
    : "Your calendar entries — a note";

  if (dryRun) {
    return {
      composed: true,
      dry_run: true,
      batch_id: null,
      draft_id: null,
      to: contact.email,
      subject,
      body,
      questions: toAsk.length,
      still_wrong_notes: stillWrong.length,
    };
  }

  const draftId = crypto.randomUUID();
  await db.insert(operatorOutboundDrafts).values({
    id: draftId,
    toAddress: contact.email,
    subject,
    bodyText: body,
    reason: `OPE-1613 — ${toAsk.length} feed discrepancy question(s) and ${stillWrong.length} still-wrong note(s) for ${promoter.name}'s validated contact. Answers are recorded with record_feed_discrepancy_answer.`,
    relatedEntityType: "promoter",
    relatedEntityId: promoterId,
    composedBy: FEED_BATCH_COMPOSER,
    composedAt: now,
    status: "pending",
  });
  const batchId = crypto.randomUUID();
  await db.insert(feedDiscrepancyBatches).values({
    id: batchId,
    promoterId,
    contactId: contact.id,
    draftId,
    discrepancyIds: JSON.stringify(toAsk.map((x) => x.d.id)),
    stillWrongPinIds: JSON.stringify(stillWrong.map((s) => s.pin.id)),
    composedAt: now,
  });
  for (const s of stillWrong) {
    await db
      .update(eventFieldPins)
      .set({ stillWrongNotesSent: s.pin.stillWrongNotesSent + 1, updatedAt: now })
      .where(eq(eventFieldPins.id, s.pin.id));
  }
  return {
    composed: true,
    dry_run: false,
    batch_id: batchId,
    draft_id: draftId,
    to: contact.email,
    subject,
    body,
    questions: toAsk.length,
    still_wrong_notes: stillWrong.length,
  };
}

/** OPE-1511 inputs for the feed lane, over an optional promoter. */
export async function feedDiscrepancyMetrics(db: Db, args: { promoterId?: string }) {
  const evRows = args.promoterId
    ? await db.select({ id: events.id }).from(events).where(eq(events.promoterId, args.promoterId))
    : null;
  const allowed = evRows ? new Set(evRows.map((e) => e.id)) : null;
  const disc = (
    await db
      .select({
        id: eventDiscrepancies.id,
        eventId: eventDiscrepancies.eventId,
        detectedAt: eventDiscrepancies.detectedAt,
        resolvedAt: eventDiscrepancies.resolvedAt,
        resolutionSource: eventDiscrepancies.resolutionSource,
        notes: eventDiscrepancies.notes,
      })
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.detectedBy, FEED_DETECTOR))
  ).filter((d) => !allowed || allowed.has(d.eventId));
  const batches = (
    await db
      .select({
        ids: feedDiscrepancyBatches.discrepancyIds,
        draftId: feedDiscrepancyBatches.draftId,
        composedAt: feedDiscrepancyBatches.composedAt,
        promoterId: feedDiscrepancyBatches.promoterId,
      })
      .from(feedDiscrepancyBatches)
  ).filter((b) => !args.promoterId || b.promoterId === args.promoterId);
  const draftIds = batches.map((b) => b.draftId).filter((x): x is string => !!x);
  const sentDrafts = new Set<string>();
  for (let i = 0; i < draftIds.length; i += 90) {
    const rows = await db
      .select({ id: operatorOutboundDrafts.id })
      .from(operatorOutboundDrafts)
      .where(
        and(
          inArray(operatorOutboundDrafts.id, draftIds.slice(i, i + 90)),
          eq(operatorOutboundDrafts.status, "sent")
        )
      );
    rows.forEach((r) => sentDrafts.add(r.id));
  }
  const askedAt = new Map<string, Date>();
  for (const b of batches) {
    if (!b.draftId || !sentDrafts.has(b.draftId)) continue;
    for (const id of JSON.parse(b.ids) as string[])
      if (!askedAt.has(id)) askedAt.set(id, b.composedAt);
  }
  const answered = disc.filter((d) => d.resolutionSource === "promoter_reply" && askedAt.has(d.id));
  const hours = answered
    .map((d) => (d.resolvedAt!.getTime() - askedAt.get(d.id)!.getTime()) / 3_600_000)
    .sort((a, b) => a - b);
  const pins = (
    await db
      .select({
        eventId: eventFieldPins.eventId,
        status: eventFieldPins.status,
        reason: eventFieldPins.releaseReason,
      })
      .from(eventFieldPins)
  ).filter((p) => !allowed || allowed.has(p.eventId));
  return {
    discrepancies_raised: disc.length,
    questions_sent: askedAt.size,
    questions_answered: answered.length,
    answer_rate: askedAt.size ? answered.length / askedAt.size : null,
    median_hours_to_answer: hours.length ? hours[Math.floor(hours.length / 2)] : null,
    pins_created: pins.length,
    pins_released_feed_fixed: pins.filter((p) => p.reason === "feed_fixed").length,
    third_value_changes: disc.filter((d) => parseFeedNotes(d.notes)?.kind === "third_value").length,
    batches_composed: batches.length,
    batches_sent: batches.filter((b) => b.draftId && sentDrafts.has(b.draftId)).length,
  };
}
