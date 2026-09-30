/**
 * OPE-977 — resolve a meetmeatthefair.com event URL to the event it names.
 *
 * The inbound briefing compared `parsed_url` only against `events.source_url`
 * — the ORGANIZER's site — so a reader who linked OUR page matched nothing and
 * the briefing fell back to subject tokens. Both 2026-09-13 reader emails did
 * exactly that (`/events/marlborough-gun-show-september/2026`,
 * `/events/a-different-drummer-craft-fair-september/2026`) and both came back
 * `matchedEvent: null`, while the warning claimed a URL attempt that could not
 * have matched.
 *
 * URL shapes, as the site serves them:
 *   /events/<series-canonical-slug>/<year>  → the series' occurrence that year
 *                                              (same rule as the public route,
 *                                              src/lib/series/get-occurrence.ts)
 *   /events/<slug>                           → the event with that slug, or its
 *                                              slug-history successor, or the
 *                                              keeper a merge tombstone points to
 * A `<series>/<year>` URL whose series has no occurrence that year also tries
 * the flat `<series>-<year>` slug, which is how occurrence slugs are minted.
 */
import { and, eq, isNull } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { events, eventSeries, eventSlugHistory } from "../schema.js";
import type { Db } from "../db.js";

const OWN_HOSTS = new Set(["meetmeatthefair.com", "www.meetmeatthefair.com"]);

export type OwnEventUrlResolution =
  | { status: "absent" }
  | { status: "not-ours"; host: string }
  | { status: "ours-not-an-event-page"; path: string }
  | { status: "ours-unresolved"; path: string }
  | {
      status: "resolved";
      event: { id: string; slug: string; name: string };
      via: "series-year" | "slug" | "slug-history" | "merged-into";
      path: string;
    };

type EventRow = { id: string; slug: string; name: string; mergedInto: string | null };

async function bySlug(db: Db, slug: string): Promise<EventRow | null> {
  const [row] = await db
    .select({ id: events.id, slug: events.slug, name: events.name, mergedInto: events.mergedInto })
    .from(events)
    .where(eq(events.slug, unsafeSlug(slug)))
    .limit(1);
  return row ?? null;
}

async function byId(db: Db, id: string): Promise<EventRow | null> {
  const [row] = await db
    .select({ id: events.id, slug: events.slug, name: events.name, mergedInto: events.mergedInto })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  return row ?? null;
}

/** Follow merge tombstones to the keeper (bounded — a cycle is data corruption, not a loop). */
async function keeperOf(db: Db, row: EventRow): Promise<{ row: EventRow; merged: boolean }> {
  let cur = row;
  let merged = false;
  for (let i = 0; i < 5 && cur.mergedInto; i++) {
    const next = await byId(db, cur.mergedInto);
    if (!next) break;
    cur = next;
    merged = true;
  }
  return { row: cur, merged };
}

export async function resolveOwnEventUrl(
  db: Db,
  rawUrl: string | null | undefined
): Promise<OwnEventUrlResolution> {
  if (!rawUrl || !rawUrl.trim()) return { status: "absent" };
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return { status: "not-ours", host: "(unparseable)" };
  }
  const host = u.hostname.toLowerCase();
  if (!OWN_HOSTS.has(host)) return { status: "not-ours", host };

  const path = u.pathname.replace(/\/+$/, "");
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  if (parts[0] !== "events" || parts.length < 2 || parts.length > 3) {
    return { status: "ours-not-an-event-page", path };
  }

  const done = (row: EventRow, via: "series-year" | "slug" | "slug-history", merged: boolean) =>
    ({
      status: "resolved",
      event: { id: row.id, slug: row.slug, name: row.name },
      via: merged ? "merged-into" : via,
      path,
    }) as const;

  if (parts.length === 3 && /^\d{4}$/.test(parts[2])) {
    const [, seriesSlug, yearStr] = parts;
    const year = Number(yearStr);
    const [series] = await db
      .select({ id: eventSeries.id })
      .from(eventSeries)
      .where(eq(eventSeries.canonicalSlug, unsafeSlug(seriesSlug)))
      .limit(1);
    if (series) {
      const occ = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          mergedInto: events.mergedInto,
          startDate: events.startDate,
        })
        .from(events)
        .where(and(eq(events.seriesId, series.id), isNull(events.mergedInto)));
      const hit = occ.find((o) => o.startDate && new Date(o.startDate).getUTCFullYear() === year);
      if (hit) return done(hit, "series-year", false);
    }
    const flat = await bySlug(db, `${seriesSlug}-${yearStr}`);
    if (flat) {
      const k = await keeperOf(db, flat);
      return done(k.row, "slug", k.merged);
    }
    return { status: "ours-unresolved", path };
  }
  if (parts.length === 3) return { status: "ours-not-an-event-page", path };

  const slug = parts[1];
  const direct = await bySlug(db, slug);
  if (direct) {
    const k = await keeperOf(db, direct);
    return done(k.row, "slug", k.merged);
  }
  const [hist] = await db
    .select({ eventId: eventSlugHistory.eventId })
    .from(eventSlugHistory)
    .where(eq(eventSlugHistory.oldSlug, unsafeSlug(slug)))
    .limit(1);
  if (hist) {
    const row = await byId(db, hist.eventId);
    if (row) {
      const k = await keeperOf(db, row);
      return done(k.row, "slug-history", k.merged);
    }
  }
  return { status: "ours-unresolved", path };
}
