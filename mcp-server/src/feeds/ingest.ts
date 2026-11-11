/**
 * OPE-1613 — one read of a promoter's feed, applied.
 *
 * For each feed item:
 *  1. record it in `promoter_feed_items` (first/last seen, inclusion verdict);
 *  2. link it to an MMATF event (prior link → source_url → same promoter + same
 *     start date + name containment). Unlinked + included → `awaiting_review`.
 *     NOT created as an event in this slice — creation goes through review;
 *  3. for a linked event we PUBLISH (the public reader's gate: APPROVED or
 *     TENTATIVE with a public lifecycle — OPE-1626), per tracked field:
 *     - a live pin → evaluate it (same wrong value / fixed / third value);
 *     - else a self-contradiction inside the feed item (an AM time whose own
 *       description says PM, a location that is only a state code, a
 *       "cancelled" in the text the feed's status doesn't carry), or a plain
 *       disagreement with our value → an `organizer_feed` discrepancy.
 *     The feed WRITES nothing to the event. Every discrepancy is asked of the
 *     validated contact in a batch (batch.ts).
 *
 * `dryRun` computes the same report and writes nothing. Every write in this
 * file is behind a `!dryRun` check, so a dry run is the real code path minus
 * the writes rather than a parallel imitation of it.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte } from "drizzle-orm";
import {
  adminActions,
  eventDiscrepancies,
  events,
  promoterEventFeeds,
  promoterFeedItems,
} from "../schema.js";
import { chunkIds, createSlug } from "@takemetothefair/utils";
import { isPubliclyVisible } from "@takemetothefair/constants";
import type { Db } from "../db.js";
import type { FeedEvent } from "./tec.js";
import {
  detectSelfContradictions as sharedSelfContradictions,
  to12h,
} from "@takemetothefair/utils/feeds";
import { decideInclusion, parseInclusionRules } from "./inclusion.js";
import {
  FEED_FIELDS,
  FIELD_CLASS,
  evaluatePin,
  feedFieldValues,
  getActivePin,
  readEventFieldValues,
  releasePin,
  sameValue,
  type FeedField,
} from "./provenance.js";

export const FEED_DETECTOR = "organizer_feed" as const;

/** What a discrepancy row's `notes` JSON carries for this detector. */
export interface FeedDiscrepancyNotes {
  field: FeedField;
  kind:
    | "am_pm_slip"
    | "state_only_location"
    | "cancelled_in_text"
    | "feed_differs"
    | "third_value"
    // OPE-1617 — the feed itself marks the event cancelled (iCal STATUS:CANCELLED,
    // schema.org EventCancelled, TEC status), or a later read no longer carries it.
    | "feed_cancelled"
    | "feed_dropped";
  feed_item_external_id: string;
  feed_url: string | null;
  /** One line the contact can answer at a glance. */
  question: string;
  /** One line naming where the feed is wrong, for their web person. */
  feed_fix_note: string;
  /** For self-contradictions: the value the item's own text implies. */
  hint?: string | null;
  pin_id?: string;
}

export function parseFeedNotes(notes: string | null): FeedDiscrepancyNotes | null {
  if (!notes) return null;
  try {
    const n = JSON.parse(notes) as FeedDiscrepancyNotes;
    return n && typeof n === "object" && typeof n.field === "string" ? n : null;
  } catch {
    return null;
  }
}

const display = (field: FeedField, v: string | null): string => {
  if (v === null) return "nothing";
  if (field === "start_time" || field === "end_time") return to12h(v);
  return v;
};

const fieldLabel: Record<FeedField, string> = {
  start_date: "start date",
  end_date: "end date",
  start_time: "start time",
  end_time: "end time",
  venue: "location",
  status: "status",
};

interface Finding {
  field: FeedField;
  kind: FeedDiscrepancyNotes["kind"];
  ourValue: string | null;
  feedValue: string | null;
  hint: string | null;
  question: string;
  feedFixNote: string;
  pinId?: string;
}

/**
 * Contradictions inside ONE feed item — its own fields against its own text.
 * Shared with the main app's test-submission engine since OPE-1625.
 */
export function detectSelfContradictions(ev: FeedEvent): Finding[] {
  return sharedSelfContradictions(ev);
}

export interface IngestItemReport {
  external_id: string;
  title: string;
  included: boolean;
  inclusion_reason: string;
  event_id: string | null;
  link_basis: "prior" | "source_url" | "promoter_date_name" | null;
  /** OPE-1630 — `rejected`: a reviewer said no; kept across reads, never re-queued. */
  review_state: "awaiting_review" | "linked" | "dropped" | "rejected";
  published: boolean;
  findings: Array<{ field: FeedField; kind: string; action: "opened" | "refreshed" | "replaced" }>;
  pins: Array<{ field: FeedField; verdict: string; action: string }>;
}

export interface IngestReport {
  feed_id: string;
  dry_run: boolean;
  items_read: number;
  included: number;
  linked: number;
  awaiting_review: number;
  discrepancies_opened: number;
  discrepancies_refreshed: number;
  pins_kept: number;
  pins_released: number;
  third_values: number;
  /** OPE-1617 — items new or different since the last read (content hash). */
  items_changed: number;
  /** OPE-1617 — previously-seen items this read no longer carries. */
  dropped: Array<{
    external_id: string;
    title: string | null;
    start_local: string | null;
    event_id: string | null;
    action: "opened" | "refreshed" | "replaced" | "noted" | "pinned_kept";
  }>;
  items: IngestItemReport[];
}

/**
 * OPE-1626 — "an event we publish" is the PUBLIC READER's gate, not
 * `status === "APPROVED"`: editorial APPROVED or TENTATIVE, and a public
 * lifecycle (`isPubliclyVisible`, the in-memory twin of `publicEventWhere`). A
 * TENTATIVE event is on the site, so a feed contradicting it is worth asking.
 */
async function isPublishedEvent(db: Db, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: events.status, lifecycle: events.lifecycleStatus })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return !!row && isPubliclyVisible(row.status, row.lifecycle ?? "SCHEDULED");
}

/** A comparison key, not a stored slug: createSlug (#120) with the hyphens dropped. */
const nameKey = (s: string) => createSlug(s).replace(/-/g, "");

async function linkItem(
  db: Db,
  feed: { id: string; promoterId: string },
  ev: FeedEvent,
  priorEventId: string | null
): Promise<{ eventId: string | null; basis: IngestItemReport["link_basis"] }> {
  if (priorEventId) return { eventId: priorEventId, basis: "prior" };
  if (ev.url) {
    const [byUrl] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.sourceUrl, ev.url), eq(events.promoterId, feed.promoterId)))
      .limit(1);
    if (byUrl) return { eventId: byUrl.id, basis: "source_url" };
  }
  if (ev.startDate) {
    const candidates = await db
      .select({ id: events.id, name: events.name, startDate: events.startDate })
      .from(events)
      .where(eq(events.promoterId, feed.promoterId));
    const key = nameKey(ev.title);
    const hits = candidates.filter(
      (c) =>
        c.startDate?.toISOString().slice(0, 10) === ev.startDate &&
        key.length >= 6 &&
        (nameKey(c.name).includes(key) || key.includes(nameKey(c.name)))
    );
    // Only an unambiguous match links; two candidates stay for review.
    if (hits.length === 1) return { eventId: hits[0].id, basis: "promoter_date_name" };
  }
  return { eventId: null, basis: null };
}

async function upsertDiscrepancy(
  db: Db,
  args: {
    eventId: string;
    finding: Finding;
    ourValue: string | null;
    feedItem: FeedEvent;
    now: Date;
    dryRun: boolean;
  }
): Promise<"opened" | "refreshed" | "replaced"> {
  const { eventId, finding, now, dryRun } = args;
  const open = await db
    .select({
      id: eventDiscrepancies.id,
      divergentValue: eventDiscrepancies.divergentValue,
      notes: eventDiscrepancies.notes,
    })
    .from(eventDiscrepancies)
    .where(
      and(
        eq(eventDiscrepancies.eventId, eventId),
        eq(eventDiscrepancies.detectedBy, FEED_DETECTOR),
        eq(eventDiscrepancies.resolutionStatus, "open")
      )
    );
  const sameField = open.filter((r) => parseFeedNotes(r.notes)?.field === finding.field);
  const sameValueRow = sameField.find((r) =>
    sameValue(finding.field, r.divergentValue, finding.feedValue)
  );
  if (sameValueRow) {
    if (!dryRun) {
      await db
        .update(eventDiscrepancies)
        .set({ lastSeenAt: now })
        .where(eq(eventDiscrepancies.id, sameValueRow.id));
    }
    return "refreshed";
  }
  const notes: FeedDiscrepancyNotes = {
    field: finding.field,
    kind: finding.kind,
    feed_item_external_id: args.feedItem.externalId,
    feed_url: args.feedItem.url,
    question: finding.question,
    feed_fix_note: finding.feedFixNote,
    hint: finding.hint,
    ...(finding.pinId ? { pin_id: finding.pinId } : {}),
  };
  if (!dryRun) {
    if (sameField.length) {
      // The feed moved to yet another value: the old question is moot.
      // Chunked: one (event, field) rarely has more than one open row, but the
      // bind list must be provably bounded (OPE-1029).
      for (const ids of chunkIds(sameField.map((r) => r.id))) {
        await db
          .update(eventDiscrepancies)
          .set({ resolutionStatus: "superseded_by_reevaluation", resolvedAt: now })
          .where(inArray(eventDiscrepancies.id, ids));
      }
    }
    await db.insert(eventDiscrepancies).values({
      id: crypto.randomUUID(),
      eventId,
      fieldClass: FIELD_CLASS[finding.field],
      authoritativeValue: args.ourValue,
      authoritativeSourceKey: null,
      authoritativeSourceUrl: null,
      divergentValue: finding.feedValue,
      divergentSourceKey: null,
      divergentSourceUrl: args.feedItem.url,
      detectedBy: FEED_DETECTOR,
      detectedAt: now,
      lastSeenAt: now,
      confidence: null,
      resolutionStatus: "open",
      // Feed questions go out under their OWN limit (batch.ts), never through
      // the GW1d promoter-outreach queue and its pre-season cap.
      outreachCandidate: false,
      outreachSuppressed: true,
      notes: JSON.stringify(notes),
      createdAt: now,
    });
  }
  return sameField.length ? "replaced" : "opened";
}

/** A stable hash of the mapped item, for change detection between reads. */
async function contentHash(ev: FeedEvent): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(ev));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function ingestFeedItems(
  db: Db,
  args: {
    feedId: string;
    items: FeedEvent[];
    now: Date;
    dryRun: boolean;
    actor: string;
    /**
     * OPE-1617 — the local date range this read COMPLETELY covers. A previously
     * seen item starting inside it (and not before today) that this read does
     * not carry was dropped by the organizer: a cancellation signal. Omit it
     * when the read is partial (a failed page, a capped list) — a gap in our
     * read must never look like a cancellation.
     */
    dropScope?: { fromDate: string; toDate: string };
  }
): Promise<IngestReport> {
  const { feedId, items, now, dryRun } = args;
  const [feed] = await db
    .select()
    .from(promoterEventFeeds)
    .where(eq(promoterEventFeeds.id, feedId))
    .limit(1);
  if (!feed) throw new Error(`feed ${feedId} not found`);
  const rules = parseInclusionRules(feed.inclusionRules);

  const report: IngestReport = {
    feed_id: feedId,
    dry_run: dryRun,
    items_read: items.length,
    included: 0,
    linked: 0,
    awaiting_review: 0,
    discrepancies_opened: 0,
    discrepancies_refreshed: 0,
    pins_kept: 0,
    pins_released: 0,
    third_values: 0,
    items_changed: 0,
    dropped: [],
    items: [],
  };

  for (const ev of items) {
    const verdict = decideInclusion(ev, rules);
    const [prior] = await db
      .select({
        id: promoterFeedItems.id,
        eventId: promoterFeedItems.eventId,
        contentHash: promoterFeedItems.contentHash,
        reviewState: promoterFeedItems.reviewState,
      })
      .from(promoterFeedItems)
      .where(
        and(eq(promoterFeedItems.feedId, feedId), eq(promoterFeedItems.externalId, ev.externalId))
      )
      .limit(1);
    // OPE-1630 — a reviewer's rejection is remembered by external_id: the item
    // is never linked, never re-queued and never asked about. Its snapshot still
    // refreshes, so the record shows what the feed last said.
    const rejected = prior?.reviewState === "rejected";
    // Link EVERY item, filtered or not: the inclusion filter decides which NEW
    // items go to review. An item already matching an event we publish stays
    // watched even if the filter would not have picked it — otherwise a live
    // page silently stops being checked because a rule was tuned.
    const link = rejected
      ? { eventId: null, basis: null }
      : await linkItem(db, feed, ev, prior?.eventId ?? null);
    const reviewState: IngestItemReport["review_state"] = rejected
      ? "rejected"
      : link.eventId
        ? "linked"
        : verdict.included
          ? "awaiting_review"
          : "dropped";

    const item: IngestItemReport = {
      external_id: ev.externalId,
      title: ev.title,
      included: verdict.included,
      inclusion_reason: verdict.reason,
      event_id: link.eventId,
      link_basis: link.basis,
      review_state: reviewState,
      published: false,
      findings: [],
      pins: [],
    };
    if (verdict.included) report.included++;
    if (reviewState === "linked") report.linked++;
    if (reviewState === "awaiting_review") report.awaiting_review++;

    const hash = await contentHash(ev);
    if (!prior || prior.contentHash !== hash) report.items_changed++;
    if (!dryRun) {
      const snapshot = JSON.stringify(ev);
      const values = {
        contentHash: hash,
        missingSince: null,
        eventId: link.eventId,
        title: ev.title,
        url: ev.url,
        startLocal: ev.startDate
          ? `${ev.startDate}${ev.startTime ? ` ${ev.startTime}` : ""}`
          : null,
        included: verdict.included,
        exclusionReason: verdict.included ? null : verdict.reason,
        reviewState,
        snapshot,
        lastSeenAt: now,
      };
      if (prior) {
        await db.update(promoterFeedItems).set(values).where(eq(promoterFeedItems.id, prior.id));
      } else {
        await db.insert(promoterFeedItems).values({
          id: crypto.randomUUID(),
          feedId,
          externalId: ev.externalId,
          firstSeenAt: now,
          ...values,
        });
      }
    }

    if (link.eventId) item.published = await isPublishedEvent(db, link.eventId);

    // Discrepancies only for events we publish (the ruling).
    if (item.published && link.eventId) {
      const ours = await readEventFieldValues(db, link.eventId);
      const feedVals = feedFieldValues(ev);
      const contradictions = detectSelfContradictions(ev);
      for (const field of FEED_FIELDS) {
        const ourValue = ours?.[field] ?? null;
        const feedValue = feedVals[field];
        const pin = await getActivePin(db, link.eventId, field);
        let finding: Finding | null = null;
        if (pin) {
          const pv = evaluatePin(field, pin, feedValue);
          if (pv === "fixed") {
            if (!dryRun) await releasePin(db, pin.id, "feed_fixed", now);
            report.pins_released++;
            item.pins.push({
              field,
              verdict: pv,
              action: "released — the feed is authoritative again",
            });
          } else if (pv === "third_value") {
            report.third_values++;
            item.pins.push({ field, verdict: pv, action: "kept the pinned value; asked again" });
            finding = {
              field,
              kind: "third_value",
              ourValue,
              feedValue,
              hint: null,
              pinId: pin.id,
              question: `${ev.title}${ev.startDate ? `, ${ev.startDate}` : ""}: you told us the ${fieldLabel[field]} is ${display(field, pin.pinnedValue)}, and your feed now says ${display(field, feedValue)}. Has it changed?`,
              feedFixNote: `The calendar now shows ${display(field, feedValue)} for the ${fieldLabel[field]}.`,
            };
          } else {
            report.pins_kept++;
            item.pins.push({
              field,
              verdict: pv,
              action: "kept the pinned value; not asked again",
            });
          }
        } else {
          const c = contradictions.find((x) => x.field === field);
          if (c) {
            finding = { ...c, ourValue };
          } else if (
            field === "status" &&
            feedValue === "cancelled" &&
            ourValue !== null &&
            !sameValue(field, ourValue, feedValue)
          ) {
            // OPE-1617 — a cancellation SIGNAL for review, never a silent
            // lifecycle change: the event stays as we list it until the contact
            // or an operator confirms.
            finding = {
              field,
              kind: "feed_cancelled",
              ourValue,
              feedValue,
              hint: "cancelled",
              question: `${ev.title}${ev.startDate ? `, ${ev.startDate}` : ""}: your calendar now marks this as cancelled. Is it cancelled?`,
              feedFixNote: `The calendar entry is marked cancelled; we still list it as scheduled.`,
            };
          } else if (
            feedValue !== null &&
            ourValue !== null &&
            !sameValue(field, ourValue, feedValue)
          ) {
            finding = {
              field,
              kind: "feed_differs",
              ourValue,
              feedValue,
              hint: null,
              question: `${ev.title}${ev.startDate ? `, ${ev.startDate}` : ""}: we list the ${fieldLabel[field]} as ${display(field, ourValue)}; your feed says ${display(field, feedValue)}. Which is right?`,
              feedFixNote: `The calendar's ${fieldLabel[field]} (${display(field, feedValue)}) differs from what we list.`,
            };
          }
        }
        if (finding) {
          const action = await upsertDiscrepancy(db, {
            eventId: link.eventId,
            finding,
            ourValue,
            feedItem: ev,
            now,
            dryRun,
          });
          if (action === "refreshed") report.discrepancies_refreshed++;
          else report.discrepancies_opened++;
          item.findings.push({ field, kind: finding.kind, action });
        }
      }
    }
    report.items.push(item);
  }

  if (args.dropScope)
    await detectDropped(db, { feedId, items, now, dryRun, report, scope: args.dropScope });

  if (!dryRun) {
    await db
      .update(promoterEventFeeds)
      .set({ lastReadAt: now, lastReadStatus: `ok: ${items.length} items`, updatedAt: now })
      .where(eq(promoterEventFeeds.id, feedId));
    await db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action: "feed.ingested",
      actorUserId: args.actor,
      targetType: "promoter_event_feed",
      targetId: feedId,
      payloadJson: JSON.stringify({ ...report, items: undefined }),
      createdAt: now,
    });
  }
  return report;
}

/**
 * OPE-1617 — items we saw before that this complete read no longer carries.
 *
 * Only items whose start falls in the read's covered range AND is not in the
 * past: an event that has happened falls off a feed normally, and an item
 * outside the window was never asked for. A dropped item linked to an event we
 * publish opens a `feed_dropped` status discrepancy (asked of the contact like
 * every other); unlinked ones are only marked. `missing_since` is set once, so a
 * later read does not re-report it; the item's reappearance clears it.
 */
async function detectDropped(
  db: Db,
  args: {
    feedId: string;
    items: FeedEvent[];
    now: Date;
    dryRun: boolean;
    report: IngestReport;
    scope: { fromDate: string; toDate: string };
  }
): Promise<void> {
  const { feedId, now, dryRun, report } = args;
  const today = now.toISOString().slice(0, 10);
  const from = args.scope.fromDate > today ? args.scope.fromDate : today;
  const seen = new Set(args.items.map((i) => i.externalId));
  const candidates = await db
    .select({
      id: promoterFeedItems.id,
      externalId: promoterFeedItems.externalId,
      eventId: promoterFeedItems.eventId,
      title: promoterFeedItems.title,
      url: promoterFeedItems.url,
      startLocal: promoterFeedItems.startLocal,
      snapshot: promoterFeedItems.snapshot,
    })
    .from(promoterFeedItems)
    .where(
      and(
        eq(promoterFeedItems.feedId, feedId),
        isNull(promoterFeedItems.missingSince),
        isNotNull(promoterFeedItems.startLocal),
        gte(promoterFeedItems.startLocal, from),
        // start_local is "YYYY-MM-DD[ HH:MM]"; "<date>~" sorts after any time on that date.
        lte(promoterFeedItems.startLocal, `${args.scope.toDate}~`),
        lt(promoterFeedItems.lastSeenAt, now)
      )
    );
  for (const c of candidates) {
    if (seen.has(c.externalId)) continue;
    let action: IngestReport["dropped"][number]["action"] = "noted";
    if (c.eventId) {
      if (await isPublishedEvent(db, c.eventId)) {
        const ours = await readEventFieldValues(db, c.eventId);
        const pin = await getActivePin(db, c.eventId, "status");
        if (pin) {
          action = "pinned_kept";
        } else if (ours?.status !== "cancelled") {
          let prev: FeedEvent | null = null;
          try {
            prev = c.snapshot ? (JSON.parse(c.snapshot) as FeedEvent) : null;
          } catch {
            prev = null;
          }
          const when = `${c.title ?? "This event"}${c.startLocal ? `, ${c.startLocal.slice(0, 10)}` : ""}`;
          action = await upsertDiscrepancy(db, {
            eventId: c.eventId,
            finding: {
              field: "status",
              kind: "feed_dropped",
              ourValue: ours?.status ?? null,
              feedValue: "removed_from_feed",
              hint: "cancelled",
              question: `${when}: this event is no longer on your calendar. Is it cancelled or moved?`,
              feedFixNote: `The event was on the calendar and is now gone from it.`,
            },
            ourValue: ours?.status ?? null,
            feedItem: prev ?? {
              externalId: c.externalId,
              title: c.title ?? "",
              url: c.url,
              startDate: c.startLocal?.slice(0, 10) ?? null,
              endDate: null,
              startTime: null,
              endTime: null,
              allDay: false,
              timezone: null,
              venue: null,
              organizerEmails: [],
              imageUrl: null,
              description: "",
              categories: [],
              cost: null,
              statusCancelled: false,
            },
            now,
            dryRun,
          });
          if (action === "refreshed") report.discrepancies_refreshed++;
          else report.discrepancies_opened++;
        }
      }
    }
    report.dropped.push({
      external_id: c.externalId,
      title: c.title,
      start_local: c.startLocal,
      event_id: c.eventId,
      action,
    });
    if (!dryRun) {
      await db
        .update(promoterFeedItems)
        .set({ missingSince: now })
        .where(eq(promoterFeedItems.id, c.id));
    }
  }
}
