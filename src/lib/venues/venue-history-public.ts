/**
 * OPE-1181 — the public side of a venue's cited history (the OPE-1180 data
 * model): what the venue page renders, and the ONE rule for whether a FORMER
 * venue's page may be indexed.
 *
 * Indexability is a single SQL predicate used by the page's robots tag, the
 * venue sitemap and `getIndexableVenueSlugs`, so the three can never disagree
 * (a sitemap URL the page itself marks noindex is the soft contradiction search
 * consoles flag). A FORMER page is indexable when it has at least one CITED
 * series↔venue period, or a cited use-start AND a cited use-end. Otherwise it
 * still returns 200 — its URL never 404s — but with `noindex`.
 */
import { and, asc, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { edtfRangeLabel } from "@takemetothefair/utils";
import type { Database } from "@/lib/db";
import {
  eventSeries,
  events,
  seriesVenuePeriods,
  venueClaimCitations,
  venueNameVariants,
  venues,
} from "@/lib/db/schema";

/** Venues whose page may be indexed: every ACTIVE one, plus cited FORMER ones. */
export function indexableVenueWhere(): SQL {
  return or(
    eq(venues.status, "ACTIVE"),
    and(
      eq(venues.status, "FORMER"),
      or(
        sql`EXISTS (SELECT 1 FROM ${seriesVenuePeriods} p JOIN ${venueClaimCitations} c ON c.series_venue_period_id = p.id WHERE p.venue_id = ${venues.id})`,
        and(
          isNotNull(venues.useStartedEdtf),
          isNotNull(venues.useEndedEdtf),
          sql`EXISTS (SELECT 1 FROM ${venueClaimCitations} c WHERE c.venue_id = ${venues.id} AND c.field = 'use_started')`,
          sql`EXISTS (SELECT 1 FROM ${venueClaimCitations} c WHERE c.venue_id = ${venues.id} AND c.field = 'use_ended')`
        )
      )
    )
  )!;
}

export interface PublicCitation {
  id: string;
  sourceUrl: string;
  sourceType: string;
  certainty: string;
  notes: string | null;
}

export interface WhereItWent {
  /** Other venues this series was held at, with their period. */
  venues: Array<{ slug: string; name: string; status: string; range: string; current: boolean }>;
  /** The sentence, structured so the named venues can be rendered as links. */
  summary: WhereItWentText;
}

export interface HistoryRow {
  key: string;
  seriesName: string;
  seriesSlug: string | null;
  range: string;
  certainty: string | null;
  citations: PublicCitation[];
  whereItWent: WhereItWent | null;
  /** True for a row derived from this venue's own dated events, not a cited period. */
  fromListings: boolean;
}

export interface VenueHistoryPublic {
  rows: HistoryRow[];
  nameVariants: Array<{
    name: string;
    range: string;
    certainty: string;
    citations: PublicCitation[];
  }>;
  lifecycleCitations: Record<string, PublicCitation[]>;
}

const CERTAINTY_RANK: Record<string, number> = { certain: 0, "less-certain": 1, uncertain: 2 };
/** Highest-certainty source first; conflicts are all shown, never hidden. */
function byCertainty(a: PublicCitation, b: PublicCitation) {
  return (CERTAINTY_RANK[a.certainty] ?? 9) - (CERTAINTY_RANK[b.certainty] ?? 9);
}

export interface WhereItWentText {
  /** Leading words, e.g. "Now held at". */
  lead: string;
  /** Venue names the sentence refers to, in order (rendered as links). */
  targets: string[];
  /** Trailing words, e.g. "(since 1998)" or "; no longer held". */
  tail: string;
  /** The whole sentence, for tests and plain-text use. */
  text: string;
}

/**
 * "Now held at X (since 1998)" · "No longer held" · "Later held at X; no
 * longer held" — from the OTHER periods of the same series. Pure.
 */
export function describeWhereItWent(
  here: { to: string | null },
  others: Array<{ name: string; from: string | null; to: string | null }>
): WhereItWentText {
  const join = (n: string[]) =>
    n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
  const make = (lead: string, targets: string[], tail: string): WhereItWentText => ({
    lead,
    targets,
    tail,
    text: `${lead}${targets.length ? ` ${join(targets)}` : ""}${tail}`,
  });
  const current = others.filter((o) => !o.to);
  if (current.length > 0) {
    if (!here.to)
      return make(
        "Also held at",
        current.map((o) => o.name),
        ""
      );
    // "Now held at", not "moved to": from an EARLY venue the series may have
    // moved several times (Common Ground: Litchfield → Windsor → Unity).
    const since =
      current.length === 1 && current[0].from ? ` (${edtfRangeLabel(current[0].from, null)})` : "";
    return make(
      "Now held at",
      current.map((o) => o.name),
      since
    );
  }
  if (others.length > 0) {
    const last = others[others.length - 1];
    return here.to
      ? make("Later held at", [last.name], "; no longer held")
      : make("Earlier held at", [last.name], "");
  }
  return make(here.to ? "No longer held" : "Held here now", [], "");
}

export async function loadVenueHistoryPublic(
  db: Database,
  venueId: string,
  now: Date = new Date()
): Promise<VenueHistoryPublic> {
  const periods = await db
    .select({
      id: seriesVenuePeriods.id,
      seriesId: seriesVenuePeriods.seriesId,
      seriesName: seriesVenuePeriods.seriesName,
      linkedName: eventSeries.name,
      linkedSlug: eventSeries.canonicalSlug,
      from: seriesVenuePeriods.fromEdtf,
      to: seriesVenuePeriods.toEdtf,
      fromEarliest: seriesVenuePeriods.fromEarliest,
      certainty: seriesVenuePeriods.certainty,
    })
    .from(seriesVenuePeriods)
    .leftJoin(eventSeries, eq(eventSeries.id, seriesVenuePeriods.seriesId))
    .where(eq(seriesVenuePeriods.venueId, venueId))
    .orderBy(asc(seriesVenuePeriods.fromEarliest));

  const variants = await db
    .select()
    .from(venueNameVariants)
    .where(eq(venueNameVariants.venueId, venueId));

  const citations = await db
    .select()
    .from(venueClaimCitations)
    .where(
      or(
        eq(venueClaimCitations.venueId, venueId),
        inArray(
          venueClaimCitations.seriesVenuePeriodId,
          db
            .select({ id: seriesVenuePeriods.id })
            .from(seriesVenuePeriods)
            .where(eq(seriesVenuePeriods.venueId, venueId))
        ),
        inArray(
          venueClaimCitations.venueNameVariantId,
          db
            .select({ id: venueNameVariants.id })
            .from(venueNameVariants)
            .where(eq(venueNameVariants.venueId, venueId))
        )
      )
    );
  const toPublic = (c: (typeof citations)[number]): PublicCitation => ({
    id: c.id,
    sourceUrl: c.sourceUrl,
    sourceType: c.sourceType,
    certainty: c.certainty,
    notes: c.notes,
  });

  const rows: HistoryRow[] = [];
  for (const p of periods) {
    const sameSeries = p.seriesId
      ? eq(seriesVenuePeriods.seriesId, p.seriesId)
      : sql`lower(${seriesVenuePeriods.seriesName}) = lower(${p.seriesName ?? ""})`;
    const others = await db
      .select({
        slug: venues.slug,
        name: venues.name,
        status: venues.status,
        from: seriesVenuePeriods.fromEdtf,
        to: seriesVenuePeriods.toEdtf,
      })
      .from(seriesVenuePeriods)
      .innerJoin(venues, eq(venues.id, seriesVenuePeriods.venueId))
      .where(and(sameSeries, ne(seriesVenuePeriods.venueId, venueId)))
      .orderBy(asc(seriesVenuePeriods.fromEarliest));
    rows.push({
      key: p.id,
      seriesName: p.linkedName ?? p.seriesName ?? "Unnamed series",
      seriesSlug: p.linkedSlug ?? null,
      range: edtfRangeLabel(p.from, p.to),
      certainty: p.certainty,
      citations: citations
        .filter((c) => c.seriesVenuePeriodId === p.id)
        .map(toPublic)
        .sort(byCertainty),
      whereItWent: {
        venues: others.map((o) => ({
          slug: o.slug,
          name: o.name,
          status: o.status,
          range: edtfRangeLabel(o.from, o.to),
          current: !o.to,
        })),
        summary: describeWhereItWent({ to: p.to }, others),
      },
      fromListings: false,
    });
  }

  // The venue's own PAST listed events, grouped by series, for any series
  // no cited period already covers — so an active venue's history is not
  // empty just because nobody has researched it yet.
  const covered = new Set(periods.map((p) => p.seriesId).filter(Boolean));
  const past = await db
    .select({
      seriesId: events.seriesId,
      seriesName: eventSeries.name,
      seriesSlug: eventSeries.canonicalSlug,
      first: sql<number>`MIN(${events.startDate})`,
      last: sql<number>`MAX(${events.startDate})`,
    })
    .from(events)
    .innerJoin(eventSeries, eq(eventSeries.id, events.seriesId))
    .where(
      and(
        eq(events.venueId, venueId),
        inArray(events.status, ["APPROVED", "TENTATIVE"]),
        sql`${events.mergedInto} IS NULL`,
        sql`COALESCE(${events.endDate}, ${events.startDate}) < ${Math.floor(now.getTime() / 1000)}`
      )
    )
    .groupBy(events.seriesId, eventSeries.name, eventSeries.canonicalSlug);
  for (const r of past) {
    if (!r.seriesId || covered.has(r.seriesId)) continue;
    const y1 = new Date(Number(r.first) * 1000).getUTCFullYear();
    const y2 = new Date(Number(r.last) * 1000).getUTCFullYear();
    rows.push({
      key: `listing-${r.seriesId}`,
      seriesName: r.seriesName ?? "Unnamed series",
      seriesSlug: r.seriesSlug ?? null,
      range: y1 === y2 ? String(y1) : `${y1}–${y2}`,
      certainty: null,
      citations: [],
      whereItWent: null,
      fromListings: true,
    });
  }

  const lifecycleCitations: Record<string, PublicCitation[]> = {};
  for (const c of citations.filter((c) => c.venueId === venueId)) {
    const f = c.field ?? "other";
    (lifecycleCitations[f] ??= []).push(toPublic(c));
  }
  for (const f of Object.keys(lifecycleCitations)) lifecycleCitations[f].sort(byCertainty);

  return {
    rows,
    nameVariants: variants.map((v) => ({
      name: v.name,
      range: edtfRangeLabel(v.fromEdtf, v.toEdtf),
      certainty: v.certainty,
      citations: citations
        .filter((c) => c.venueNameVariantId === v.id)
        .map(toPublic)
        .sort(byCertainty),
    })),
    lifecycleCitations,
  };
}
