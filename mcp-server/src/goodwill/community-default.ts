/**
 * OPE-1622 — John's 2026-11-10 ruling on the "$0 admission unsupported" class
 * (record: OPE-86, 2026-11-10 comment).
 *
 * 1. An uncited $0 admission is KEPT on a free-by-nature community event — a
 *    street fair or festival on a public way, a village-common, church, school
 *    or grange fair, a porchfest, an open-air market — when nothing signals a
 *    paid ticket. It is recorded as the "unsourced community default" and is
 *    not a defect.
 * 2. A paid-ticket signal defeats the default: the $0 must be verified or
 *    stripped. (Maynard Porchfest was stripped over an unverified ShoWare page.)
 *    Ancillary charges such as parking or ride bracelets are not admission and
 *    are not read here.
 *
 * Before this, that class was 10 of 14 open citation_flag rows for six weeks,
 * re-minted by every verification pass on events where $0 is plainly right.
 *
 * ## Conservative by construction
 *
 * The ticket asks for an explicit category list, not inference from venue
 * text. An event qualifies only when it carries at least one FREE category and
 * NO gated one, and its venue is not a fairgrounds. Anything else files as
 * before. A miss here costs one queue row a human dismisses; a false "free"
 * keeps a wrong $0 on a public page. So every doubt files.
 */

import { and, eq } from "drizzle-orm";
import { eventDataCitations, eventInternalNotes, events, venues } from "../schema.js";
import type { Db } from "../db.js";

/** Categories that make an event free-by-nature under ruling 1. Measured on
 *  prod 2026-11-10: these are the categories the ten hand-ruled rows carried. */
export const FREE_BY_NATURE_CATEGORIES: ReadonlySet<string> = new Set([
  "community event",
  "craft fair",
  "craft show",
  "art fair",
  "art walk",
  "festival",
  "food festival",
  "harvest festival",
  "cultural festival",
  "holiday market",
  "market",
  "makers market",
  "farmers market",
  "porchfest",
  "parade",
]);

/** Categories that usually charge at the gate. One of these anywhere on the
 *  event and the default never applies (scope 2: "the event class is gated"). */
export const GATED_CATEGORIES: ReadonlySet<string> = new Set([
  "fair",
  "agricultural fair",
  "trade show",
  "home show",
  "bridal show",
  "gun show",
  "hobby show",
  "antique show",
  "gem & mineral show",
  "senior expo",
  "convention",
  "comic con",
  "pop culture convention",
  "music festival",
  "beer festival",
  "car show",
]);

/** Hosts whose presence anywhere in an event's links signals a paid ticket. */
export const TICKETING_HOSTS: readonly string[] = [
  "eventbrite.",
  "ticketmaster.",
  "showare.",
  "showaretix.",
  "etix.com",
  "ticketleap.",
  "brownpapertickets.",
  "universe.com",
  "tix.com",
  "ticketweb.",
  "seetickets.",
  "axs.com",
  "ticketsauce.",
  "ticketspice.",
  "purplepass.",
  "simpletix.",
  "tickettailor.",
  "humanitix.",
  "zeffy.com",
];

export const COMMUNITY_DEFAULT_MARKER =
  "[OPE-1622] $0 admission kept as the unsourced community default (John's 2026-11-10 ruling, OPE-86): free-by-nature event, no paid-ticket signal.";

/** The fields this rule covers. Only the admission price, never vendor fees. */
export function isAdmissionPriceField(field: string): boolean {
  const f = field.trim().toLowerCase();
  return f === "ticket_price_min" || f === "ticket_price_max" || f === "admission";
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isTicketingUrl(url: string | null | undefined): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return TICKETING_HOSTS.some((h) => host === h || host.includes(h));
}

function parseCategories(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((c) => String(c).trim().toLowerCase()) : [];
  } catch {
    return [];
  }
}

export interface CommunityDefaultVerdict {
  applies: boolean;
  /** Why it does or does not apply, for the tool response. */
  reason: string;
}

/**
 * Does ruling 1 keep this event's $0? Reads the event itself; never trusts a
 * caller-supplied live value.
 */
export async function communityDefaultVerdict(
  db: Db,
  eventId: string
): Promise<CommunityDefaultVerdict> {
  const [ev] = await db
    .select({
      categories: events.categories,
      ticketUrl: events.ticketUrl,
      sourceUrl: events.sourceUrl,
      min: events.ticketPriceMinCents,
      max: events.ticketPriceMaxCents,
      venueName: venues.name,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!ev) return { applies: false, reason: "event not found" };

  if (ev.min !== 0) return { applies: false, reason: "live ticket_price_min is not $0" };
  if (ev.max != null && ev.max > 0) {
    return { applies: false, reason: "a paid ticket price is stored (ticket_price_max > 0)" };
  }
  if (ev.ticketUrl && ev.ticketUrl.trim() !== "") {
    return { applies: false, reason: "the event has a ticket_url" };
  }

  const cats = parseCategories(ev.categories);
  const gated = cats.find((c) => GATED_CATEGORIES.has(c));
  if (gated) return { applies: false, reason: `gated category "${gated}"` };
  if (!cats.some((c) => FREE_BY_NATURE_CATEGORIES.has(c))) {
    return { applies: false, reason: "no free-by-nature category" };
  }
  if (ev.venueName && /fairground/i.test(ev.venueName)) {
    return { applies: false, reason: "the venue is a fairgrounds" };
  }

  if (isTicketingUrl(ev.sourceUrl)) {
    return { applies: false, reason: "the event's source_url is a ticketing platform" };
  }
  const cited = await db
    .select({ url: eventDataCitations.sourceUrl })
    .from(eventDataCitations)
    .where(and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, "active")));
  const ticketCite = cited.find((c) => isTicketingUrl(c.url));
  if (ticketCite) {
    return {
      applies: false,
      reason: `an active citation links a ticketing platform (${hostOf(ticketCite.url)})`,
    };
  }

  return { applies: true, reason: "free-by-nature category, no paid-ticket signal" };
}

/** Append the marker to the event's private notes, once. */
export async function recordCommunityDefault(db: Db, eventId: string): Promise<void> {
  const [prior] = await db
    .select({ notes: eventInternalNotes.notes })
    .from(eventInternalNotes)
    .where(eq(eventInternalNotes.eventId, eventId))
    .limit(1);
  if (prior?.notes.includes("[OPE-1622]")) return;
  const now = new Date();
  const next = prior?.notes
    ? `${prior.notes}\n${COMMUNITY_DEFAULT_MARKER}`
    : COMMUNITY_DEFAULT_MARKER;
  await db
    .insert(eventInternalNotes)
    .values({ eventId, notes: next, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: eventInternalNotes.eventId,
      set: { notes: next, updatedAt: now },
    });
}

/** Ruling 3, attached to every hours flag. The data cannot tell an organizer's
 *  own site from a venue calendar (`source_type` has only `official_website`),
 *  so this proposes rather than decides. */
export const HOURS_RULING_PROPOSAL =
  "Ruling 3 (John, 2026-11-10, OPE-86): if the organizer publishes no hours and this conflict is between non-organizer sources (venue calendar, aggregator), clear the hours to 'not yet confirmed' rather than keep either.";
