/**
 * OPE-1630 — the feed review step.
 *
 * The scheduled reader (OPE-1626) marks a new organizer-feed event
 * `awaiting_review` in `promoter_feed_items`. This module is what acts on one:
 *
 *   approve               — create the listing from the item's snapshot through
 *                           the SAME writer the spreadsheet import and the
 *                           promoter API use (`createEvent`: dedup, slug, venue
 *                           matching, the category allow-list, series attach),
 *                           every value cited to the item URL with provenance `feed` (OPE-1613's rung).
 *                           Then link the item, so later reads keep it current.
 *   approve_as_occurrence — the same, attached to a named existing series (an
 *                           organizer that alternates a show's name must not get
 *                           a second hub).
 *   link                  — the item IS one of our listings the automatic match
 *                           missed. Link it; no event field changes.
 *   reject                — `rejected`, with a reason, remembered by external_id:
 *                           the ingest never re-queues or links it again.
 *
 * Every action writes an `admin_actions` row (`feed_item.<action>`). Nothing here
 * sends email: the approval notification the admin approve route sends is
 * deliberately NOT called (a feed item has no submitter to notify).
 *
 * Status of an approved item: the existing approval gate decides —
 * `eventApprovalBlockReason` (no venue and not statewide). Passing it → APPROVED;
 * failing it → TENTATIVE. `approve` refuses an item whose venue does not match an
 * existing venue (returns candidates instead), so in practice approve → APPROVED.
 *
 * The two refusals have explicit reviewer answers (added after the first live
 * use, 2026-11-12): `venueId` — the reviewer picks the venue (the feed spelled it
 * differently, gave no town, or we hold two same-named rows); and
 * `notDuplicateOf` — dedup's venue/town ±7-day stages matched a DIFFERENT show
 * (Gurley's Bath Antique Sale vs the Bath Spirit of Christmas Fair a day apart),
 * and the reviewer names that one event as not-the-same. Neither loosens dedup
 * for anyone else.
 */
import { and, asc, eq, isNull, like, or, type SQL } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import {
  adminActions,
  eventSeries,
  events,
  promoterEventFeeds,
  promoterFeedItems,
  promoters,
  venues,
} from "@/lib/db/schema";
import type { FeedEvent } from "@takemetothefair/utils/feeds";
import { eventApprovalBlockReason } from "@takemetothefair/utils";
import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { autoLinkVenue } from "@/lib/venue-matching";
import { parseApiRow } from "@/lib/promoter-api/fields";
import { createEvent, previewRows, type CommitContext } from "@/lib/promoter-import/run";
import { feedToCells } from "@/lib/test-submission/engine";
import { trackEventStatusChange } from "@/lib/server-analytics";

type Db = ReturnType<typeof getCloudflareDb>;

export const REVIEW_ACTIONS = ["approve", "approve_as_occurrence", "link", "reject"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_STATES = ["none", "awaiting_review", "linked", "dropped", "rejected"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The ledger key `createEvent` claims: one item can create at most one event. */
export const feedItemLedgerKey = (itemId: string) => `feed-item:${itemId}`;

export interface ReviewInput {
  feedItemId: string;
  action: ReviewAction;
  /** link: the existing event. */
  eventId?: string | null;
  /** approve_as_occurrence: the existing series. */
  seriesId?: string | null;
  /** Required for reject (the reason); optional otherwise. */
  note?: string | null;
  /**
   * approve / approve_as_occurrence: the venue the reviewer PICKED — the answer to
   * a `venue_unmatched` refusal (its venue_candidates). The listing takes this
   * venue's name and location; the feed's venue text is not re-resolved.
   */
  venueId?: string | null;
  /**
   * approve / approve_as_occurrence: the event dedup matched, which the reviewer
   * checked and says is a DIFFERENT event (same venue or town within a week, a
   * different show). Overrides that one refusal only: a match on any other event
   * still refuses, so a stale or blanket override cannot wave a real duplicate
   * through.
   */
  notDuplicateOf?: string | null;
  actorUserId: string | null;
  now: Date;
}

export type ReviewResult =
  | {
      ok: true;
      action: ReviewAction;
      feed_item_id: string;
      review_state: ReviewState;
      event?: { id: string; slug: string; name: string; status: string; series_id: string | null };
      warnings?: string[];
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "bad_request"
        | "already_reviewed"
        | "invalid_item"
        | "venue_unmatched"
        | "duplicate"
        | "listed_by_another_organizer"
        | "event_not_found"
        | "series_not_found"
        | "venue_not_found"
        | "skipped";
      message: string;
      /** duplicate: the event to `link` instead. */
      suggest?: { action: "link"; event_id: string; event_name: string; event_slug: string };
      /** venue_unmatched: what the operator might mean. */
      venue_candidates?: Array<{
        id: string;
        name: string;
        city: string | null;
        state: string | null;
      }>;
      errors?: string[];
    };

const fail = (
  code: Extract<ReviewResult, { ok: false }>["code"],
  message: string,
  extra: Partial<Extract<ReviewResult, { ok: false }>> = {}
): ReviewResult => ({ ok: false, code, message, ...extra });

async function loadItem(db: Db, id: string) {
  const [row] = await db
    .select({
      item: promoterFeedItems,
      feedUrl: promoterEventFeeds.feedUrl,
      promoterId: promoterEventFeeds.promoterId,
      promoterName: promoters.companyName,
    })
    .from(promoterFeedItems)
    .innerJoin(promoterEventFeeds, eq(promoterEventFeeds.id, promoterFeedItems.feedId))
    .innerJoin(promoters, eq(promoters.id, promoterEventFeeds.promoterId))
    .where(eq(promoterFeedItems.id, id))
    .limit(1);
  return row ?? null;
}

function parseSnapshot(snapshot: string | null): FeedEvent | null {
  if (!snapshot) return null;
  try {
    return JSON.parse(snapshot) as FeedEvent;
  } catch {
    return null;
  }
}

async function eventSummary(db: Db, id: string) {
  const [e] = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      status: events.status,
      series_id: events.seriesId,
    })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  return e ? { ...e, slug: String(e.slug) } : undefined;
}

async function audit(
  db: Db,
  input: ReviewInput,
  itemId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await db.insert(adminActions).values({
    action: `feed_item.${input.action}`,
    actorUserId: input.actorUserId,
    targetType: "promoter_feed_item",
    targetId: itemId,
    payloadJson: JSON.stringify({ note: input.note ?? null, ...payload }),
    createdAt: input.now,
  });
}

async function markItem(
  db: Db,
  itemId: string,
  input: ReviewInput,
  set: { reviewState: ReviewState; eventId: string | null }
): Promise<void> {
  await db
    .update(promoterFeedItems)
    .set({
      ...set,
      reviewNote: input.note ?? null,
      reviewedAt: input.now,
      reviewedBy: input.actorUserId,
    })
    .where(eq(promoterFeedItems.id, itemId));
}

/** Venues an unmatched feed venue might mean: same city+state, or a name that contains the feed's. */
async function venueCandidates(db: Db, venue: FeedEvent["venue"]) {
  const conds: SQL[] = [];
  const state = venue?.state?.trim().toUpperCase() || null;
  if (venue?.city && state)
    conds.push(and(eq(venues.city, venue.city.trim()), eq(venues.state, state))!);
  const word = (venue?.name ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter((w) => w.length >= 4 && !/^(the|center|centre|hall|school|hotel)$/i.test(w))[0];
  if (word) conds.push(like(venues.name, `%${word}%`));
  if (!conds.length) return [];
  return db
    .select({ id: venues.id, name: venues.name, city: venues.city, state: venues.state })
    .from(venues)
    .where(or(...conds))
    .limit(8);
}

export async function reviewFeedItem(db: Db, input: ReviewInput): Promise<ReviewResult> {
  if (!REVIEW_ACTIONS.includes(input.action))
    return fail("bad_request", `action must be one of ${REVIEW_ACTIONS.join(", ")}`);
  const loaded = await loadItem(db, input.feedItemId);
  if (!loaded) return fail("not_found", "No feed item with that id.");
  const { item } = loaded;

  if (item.reviewState === "linked" && item.eventId) {
    const e = await eventSummary(db, item.eventId);
    return fail(
      "already_reviewed",
      `This item is already linked to "${e?.name ?? item.eventId}". Nothing changed.`,
      e
        ? { suggest: { action: "link", event_id: e.id, event_name: e.name, event_slug: e.slug } }
        : {}
    );
  }

  // ---------------------------------------------------------------- reject
  if (input.action === "reject") {
    if (!input.note?.trim())
      return fail("bad_request", 'reject needs a note: the reason (e.g. "private event").');
    if (item.reviewState === "rejected")
      return fail("already_reviewed", "This item is already rejected. Nothing changed.");
    await markItem(db, item.id, input, { reviewState: "rejected", eventId: null });
    await audit(db, input, item.id, {
      feed_id: item.feedId,
      external_id: item.externalId,
      title: item.title,
      previous_state: item.reviewState,
    });
    return { ok: true, action: "reject", feed_item_id: item.id, review_state: "rejected" };
  }

  // ------------------------------------------------------------------ link
  if (input.action === "link") {
    if (!input.eventId) return fail("bad_request", "link needs event_id.");
    const [e] = await db
      .select({ id: events.id, mergedInto: events.mergedInto })
      .from(events)
      .where(eq(events.id, input.eventId))
      .limit(1);
    if (!e) return fail("event_not_found", "No event with that id.");
    // A merge tombstone 301s away (OPE-432); link the keeper.
    if (e.mergedInto)
      return fail(
        "event_not_found",
        `That event was merged into ${e.mergedInto}; link the keeper instead.`
      );
    await markItem(db, item.id, input, { reviewState: "linked", eventId: e.id });
    await audit(db, input, item.id, {
      feed_id: item.feedId,
      external_id: item.externalId,
      event_id: e.id,
      previous_state: item.reviewState,
    });
    return {
      ok: true,
      action: "link",
      feed_item_id: item.id,
      review_state: "linked",
      event: await eventSummary(db, e.id),
    };
  }

  // -------------------------------------------------- approve (+ occurrence)
  if (item.reviewState === "rejected")
    return fail(
      "already_reviewed",
      "This item was rejected. Approving it would reverse that decision; nothing changed."
    );
  if (input.action === "approve_as_occurrence") {
    if (!input.seriesId) return fail("bad_request", "approve_as_occurrence needs series_id.");
    const [s] = await db
      .select({ id: eventSeries.id })
      .from(eventSeries)
      .where(eq(eventSeries.id, input.seriesId))
      .limit(1);
    if (!s) return fail("series_not_found", "No series with that id.");
  }
  let picked: {
    id: string;
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null = null;
  if (input.venueId) {
    const [v] = await db
      .select({
        id: venues.id,
        name: venues.name,
        address: venues.address,
        city: venues.city,
        state: venues.state,
        zip: venues.zip,
      })
      .from(venues)
      .where(eq(venues.id, input.venueId))
      .limit(1);
    if (!v) return fail("venue_not_found", "No venue with that id.");
    picked = v;
  }
  const ev = parseSnapshot(item.snapshot);
  if (!ev) return fail("invalid_item", "The item has no readable snapshot; re-read the feed.");
  const cells = feedToCells(ev);
  if (picked) {
    // The picked venue replaces the feed's venue text whole — a feed that says
    // only "Boothbay Railway Village" (no town) still gets a complete row.
    for (const k of ["venue_name", "address", "city", "state", "zip"] as const) delete cells[k];
    const put = (k: "venue_name" | "address" | "city" | "state" | "zip", val: string | null) => {
      if (val?.trim()) cells[k] = val.trim();
    };
    put("venue_name", picked.name);
    put("address", picked.address);
    put("city", picked.city);
    put("state", picked.state);
    put("zip", picked.zip);
  }
  const { row } = parseApiRow(cells);
  if (!row.value)
    return fail("invalid_item", "The item is missing fields a listing needs.", {
      errors: row.errors,
    });

  const venue = picked
    ? { venueId: picked.id, decision: "picked" }
    : await autoLinkVenue(db, {
        venueName: row.value.venueName,
        venueAddress: row.value.address,
        venueCity: row.value.city,
        venueState: row.value.state,
      });
  if (!venue.venueId)
    return fail(
      "venue_unmatched",
      `The feed's venue (${[ev.venue?.name, ev.venue?.city, ev.venue?.state].filter(Boolean).join(", ") || "none"}) matches no venue we have with confidence (${venue.decision}). Create or pick the venue, then approve again — or link the item to an existing event.`,
      { venue_candidates: await venueCandidates(db, ev.venue) }
    );

  const ledger = feedItemLedgerKey(item.id);
  const [p] = await previewRows(db, {
    promoterId: loaded.promoterId,
    fileHash: ledger,
    rows: [row],
  });
  // The reviewer checked THIS match and says it is a different event.
  const overridden = !!p.event && !!input.notDuplicateOf && input.notDuplicateOf === p.event.id;
  if (p.status === "match" && p.event && !overridden)
    return fail("duplicate", `This is already listed as "${p.event.name}". Link it instead.`, {
      suggest: {
        action: "link",
        event_id: p.event.id,
        event_name: p.event.name,
        event_slug: String(p.event.slug),
      },
    });
  if (p.status === "error" && !overridden)
    return p.event
      ? fail(
          "listed_by_another_organizer",
          `This matches "${p.event.name}", which another organizer manages. Link it only if it is the same event.`,
          {
            suggest: {
              action: "link",
              event_id: p.event.id,
              event_name: p.event.name,
              event_slug: String(p.event.slug),
            },
            errors: p.errors,
          }
        )
      : fail("invalid_item", "The item failed validation.", { errors: p.errors });
  if (p.status === "already_imported" && p.event) {
    // A previous approve created the event but did not finish linking: finish it.
    await markItem(db, item.id, input, { reviewState: "linked", eventId: p.event.id });
    return {
      ok: true,
      action: input.action,
      feed_item_id: item.id,
      review_state: "linked",
      event: await eventSummary(db, p.event.id),
      warnings: ["This item had already created its event; it is now linked to it."],
    };
  }

  const ctx: CommitContext = {
    promoterId: loaded.promoterId,
    fileHash: ledger,
    fileName: null,
    uploadedBy: input.actorUserId,
    channel: "operator",
    now: input.now,
    source: {
      url: item.url ?? loaded.feedUrl,
      name: `${loaded.promoterName} calendar feed`,
      // OPE-1613's rung for an organizer feed (`organizer_feed` is its discrepancy detector).
      provenanceKind: "feed",
      notes: {
        feed_id: item.feedId,
        feed_item_id: item.id,
        external_id: item.externalId,
        reviewed_by: input.actorUserId,
      },
    },
    ...(input.action === "approve_as_occurrence" && input.seriesId
      ? { seriesId: input.seriesId }
      : {}),
    venueId: venue.venueId,
  };
  const created = await createEvent(db, ctx, row);
  if (created.outcome !== "created" || !created.event_id)
    return fail("skipped", created.reason ?? "The event could not be created.");

  // The existing approval gate decides the status (see the header).
  const [gate] = await db
    .select({
      venueId: events.venueId,
      isStatewide: events.isStatewide,
      stateCode: events.stateCode,
    })
    .from(events)
    .where(eq(events.id, created.event_id))
    .limit(1);
  const status = gate && !eventApprovalBlockReason(gate) ? "APPROVED" : "TENTATIVE";
  await db
    .update(events)
    .set({ status, updatedAt: input.now })
    .where(eq(events.id, created.event_id));
  await trackEventStatusChange(
    db,
    created.event_id,
    "PENDING",
    status,
    input.actorUserId ?? undefined
  );

  await markItem(db, item.id, input, { reviewState: "linked", eventId: created.event_id });
  await audit(db, input, item.id, {
    feed_id: item.feedId,
    external_id: item.externalId,
    event_id: created.event_id,
    status,
    series_id: input.seriesId ?? null,
    venue_id: venue.venueId,
    venue_picked: !!picked,
    not_duplicate_of: overridden ? input.notDuplicateOf : null,
    previous_state: item.reviewState,
  });
  return {
    ok: true,
    action: input.action,
    feed_item_id: item.id,
    review_state: "linked",
    event: await eventSummary(db, created.event_id),
  };
}

// ------------------------------------------------------------------- list

export interface ListFilters {
  feedId?: string | null;
  promoterId?: string | null;
  reviewState?: ReviewState | null;
  limit?: number;
  offset?: number;
}

export interface ListedFeedItem {
  id: string;
  feed_id: string;
  promoter_id: string;
  promoter: string;
  external_id: string;
  title: string | null;
  start_local: string | null;
  url: string | null;
  venue: string | null;
  included: boolean;
  inclusion_reason: string | null;
  review_state: ReviewState;
  event_id: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  /** Only for items not yet linked: the event dedup thinks this is, if any. */
  closest_event: { id: string; name: string; slug: string; match_type: string } | null;
}

export const LIST_MAX = 50;

export async function listFeedItems(db: Db, f: ListFilters): Promise<ListedFeedItem[]> {
  const limit = Math.min(Math.max(f.limit ?? 25, 1), LIST_MAX);
  const conds: SQL[] = [isNull(promoterFeedItems.missingSince)];
  if (f.feedId) conds.push(eq(promoterFeedItems.feedId, f.feedId));
  if (f.promoterId) conds.push(eq(promoterEventFeeds.promoterId, f.promoterId));
  if (f.reviewState) conds.push(eq(promoterFeedItems.reviewState, f.reviewState));
  const rows = await db
    .select({
      item: promoterFeedItems,
      promoterId: promoterEventFeeds.promoterId,
      promoter: promoters.companyName,
    })
    .from(promoterFeedItems)
    .innerJoin(promoterEventFeeds, eq(promoterEventFeeds.id, promoterFeedItems.feedId))
    .innerJoin(promoters, eq(promoters.id, promoterEventFeeds.promoterId))
    .where(and(...conds))
    .orderBy(asc(promoterFeedItems.startLocal), asc(promoterFeedItems.id))
    .limit(limit)
    .offset(Math.max(f.offset ?? 0, 0));

  const out: ListedFeedItem[] = [];
  for (const { item, promoterId, promoter } of rows) {
    const ev = parseSnapshot(item.snapshot);
    const venue = ev?.venue
      ? [ev.venue.name, ev.venue.city, ev.venue.state].filter(Boolean).join(", ") || null
      : null;
    let closest: ListedFeedItem["closest_event"] = null;
    if (
      ev?.startDate &&
      (item.reviewState === "awaiting_review" || item.reviewState === "dropped")
    ) {
      const dup = await findDuplicate(db, {
        sourceUrl: ev.url,
        name: ev.title,
        startDate: ev.startDate,
        venueName: ev.venue?.name ?? null,
        venueAddress: ev.venue?.address ?? null,
        venueCity: ev.venue?.city ?? null,
        venueState: ev.venue?.state ?? null,
      });
      if (dup.isDuplicate)
        closest = {
          id: dup.existingEvent.id,
          name: dup.existingEvent.name,
          slug: String(dup.existingEvent.slug),
          match_type: dup.matchType,
        };
    }
    out.push({
      id: item.id,
      feed_id: item.feedId,
      promoter_id: promoterId,
      promoter,
      external_id: item.externalId,
      title: item.title,
      start_local: item.startLocal,
      url: item.url,
      venue,
      included: item.included,
      inclusion_reason: item.exclusionReason,
      review_state: item.reviewState as ReviewState,
      event_id: item.eventId,
      review_note: item.reviewNote ?? null,
      reviewed_at: item.reviewedAt ? item.reviewedAt.toISOString() : null,
      closest_event: closest,
    });
  }
  return out;
}
