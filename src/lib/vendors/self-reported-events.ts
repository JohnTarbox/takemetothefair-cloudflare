/**
 * OPE-239 — vendor self-attested event participation.
 *
 * The vendor tells us which of our fairs they've sold at. This is the ONLY
 * roster signal that reaches events whose organizer publishes no exhibitor
 * list, which is most of them.
 *
 * ## The invariant this module exists to protect
 *
 * Self-attestation must never be mistaken for organizer confirmation — not in
 * the UI, not in `get_roster_coverage`, not in schema.org output, not in an
 * export. That is enforced STRUCTURALLY: these rows live in their own table and
 * nothing here ever writes `event_vendors`. Promotion to a confirmed roster
 * entry stays an organizer's word, forever.
 *
 * ## Positive-only
 *
 * A link boosts a claim's trust signal (OPE-237). Its absence proves nothing —
 * roster coverage is too sparse for silence to be evidence — so absence never
 * penalizes. Keep-all.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { events, vendorSelfReportedEvents, venues } from "@/lib/db/schema";
import type { Db } from "@/lib/analytics-overview/shared";

/** How many fairs one vendor may assert. A generous ceiling, not a quota. */
export const MAX_SELF_REPORTED_PER_VENDOR = 100;

export interface SelfReportedEventItem {
  eventId: string;
  eventName: string;
  eventSlug: string;
  startDate: Date | null;
  city: string | null;
  state: string | null;
  status: "SELF_REPORTED" | "CORROBORATED" | "DISPUTED";
  evidenceNote: string | null;
  createdAt: Date | null;
}

/**
 * A vendor's self-reported appearances, newest event first.
 *
 * DISPUTED rows are returned so admin surfaces can see them; callers rendering
 * anything public must filter them out — use {@link listPublicSelfReported}.
 */
export async function listSelfReportedEvents(
  db: Db,
  vendorId: string
): Promise<SelfReportedEventItem[]> {
  const rows = await db
    .select({
      eventId: vendorSelfReportedEvents.eventId,
      eventName: events.name,
      eventSlug: events.slug,
      startDate: events.startDate,
      city: venues.city,
      state: venues.state,
      status: vendorSelfReportedEvents.status,
      evidenceNote: vendorSelfReportedEvents.evidenceNote,
      createdAt: vendorSelfReportedEvents.createdAt,
    })
    .from(vendorSelfReportedEvents)
    .innerJoin(events, eq(events.id, vendorSelfReportedEvents.eventId))
    .leftJoin(venues, eq(venues.id, events.venueId))
    .where(eq(vendorSelfReportedEvents.vendorId, vendorId))
    .orderBy(desc(events.startDate));

  return rows.map((r) => ({
    eventId: r.eventId,
    eventName: r.eventName,
    eventSlug: String(r.eventSlug),
    startDate: r.startDate ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    status: (r.status ?? "SELF_REPORTED") as SelfReportedEventItem["status"],
    evidenceNote: r.evidenceNote ?? null,
    createdAt: r.createdAt ?? null,
  }));
}

/**
 * Public-facing subset: DISPUTED assertions are withheld.
 *
 * A disputed claim is one an operator has actively judged wrong. Showing it —
 * even labeled — would republish a false statement about a third party's event.
 */
export async function listPublicSelfReported(
  db: Db,
  vendorId: string
): Promise<SelfReportedEventItem[]> {
  const all = await listSelfReportedEvents(db, vendorId);
  return all.filter((r) => r.status !== "DISPUTED");
}

/**
 * Replace a vendor's self-reported set with `eventIds`.
 *
 * Set-semantics rather than add/remove calls: the picker is a multi-select, so
 * the client naturally holds the whole set, and a diffing write keeps the two
 * from drifting. Idempotent — submitting the same set twice changes nothing.
 *
 * Returns the applied delta so the caller can audit-log it.
 */
export async function setSelfReportedEvents(
  db: Db,
  args: {
    vendorId: string;
    eventIds: string[];
    sourceContext?: "claim" | "profile" | "admin";
  },
  now: Date = new Date()
): Promise<{ added: string[]; removed: string[]; kept: number }> {
  const desired = Array.from(new Set(args.eventIds)).slice(0, MAX_SELF_REPORTED_PER_VENDOR);

  // Only accept ids that are real events. A bogus id would otherwise hit the FK
  // and fail the whole request; silently dropping it keeps one stale row in the
  // client's cache from breaking an honest save.
  const valid =
    desired.length === 0
      ? []
      : (await db.select({ id: events.id }).from(events).where(inArray(events.id, desired))).map(
          (e) => e.id
        );
  const validSet = new Set(valid);

  const existing = await db
    .select({ eventId: vendorSelfReportedEvents.eventId })
    .from(vendorSelfReportedEvents)
    .where(eq(vendorSelfReportedEvents.vendorId, args.vendorId));
  const existingSet = new Set(existing.map((e) => e.eventId));

  const added = valid.filter((id) => !existingSet.has(id));
  const removed = [...existingSet].filter((id) => !validSet.has(id));

  if (added.length > 0) {
    await db
      .insert(vendorSelfReportedEvents)
      .values(
        added.map((eventId) => ({
          id: crypto.randomUUID(),
          vendorId: args.vendorId,
          eventId,
          sourceContext: args.sourceContext ?? "profile",
          status: "SELF_REPORTED" as const,
          createdAt: now,
        }))
      )
      .onConflictDoNothing();
  }

  if (removed.length > 0) {
    await db
      .delete(vendorSelfReportedEvents)
      .where(
        and(
          eq(vendorSelfReportedEvents.vendorId, args.vendorId),
          inArray(vendorSelfReportedEvents.eventId, removed)
        )
      );
  }

  return { added, removed, kept: validSet.size - added.length };
}

/**
 * Count of non-disputed assertions — the OPE-237 trust input.
 *
 * Deliberately a COUNT and not a list: the realness score should reward "this
 * vendor can name fairs they worked" without letting a long list dominate a
 * score built from independent signals.
 */
export async function countSelfReportedForTrust(db: Db, vendorId: string): Promise<number> {
  const rows = await db
    .select({ eventId: vendorSelfReportedEvents.eventId })
    .from(vendorSelfReportedEvents)
    .where(eq(vendorSelfReportedEvents.vendorId, vendorId));
  return rows.length;
}
