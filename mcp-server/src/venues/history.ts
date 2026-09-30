/**
 * OPE-1180 — a venue's cited history: lifecycle citations, series↔venue
 * periods, time-scoped name variants, and the "where these events went"
 * fan-out.
 *
 * Fan-out: for each series held at venue V (by `series_id`, or by
 * case-insensitive `series_name` for a historical series with no MMATF row),
 * every OTHER venue that series was held at. A closed venue has no single
 * successor (John's ruling) — its events may scatter to several venues, or none,
 * so this returns a list per series and never picks one.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { seriesVenuePeriods, venueClaimCitations, venueNameVariants, venues } from "../schema.js";
import type { Db } from "../db.js";

type Citation = {
  id: string;
  field: string | null;
  source_url: string;
  source_type: string;
  certainty: string;
  notes: string | null;
};

export interface VenueFanOut {
  series_id: string | null;
  series_name: string | null;
  here: { from_edtf: string | null; to_edtf: string | null };
  other_venues: Array<{
    venue_id: string;
    name: string;
    status: string;
    from_edtf: string | null;
    to_edtf: string | null;
  }>;
}

export interface VenueHistory {
  lifecycle_citations: Citation[];
  periods: Array<{
    id: string;
    series_id: string | null;
    series_name: string | null;
    from_edtf: string | null;
    to_edtf: string | null;
    certainty: string;
    notes: string | null;
    citations: Citation[];
  }>;
  name_variants: Array<{
    id: string;
    name: string;
    from_edtf: string | null;
    to_edtf: string | null;
    certainty: string;
    citations: Citation[];
  }>;
  fan_out: VenueFanOut[];
  /** Unique destination venues across the fan-out — 0 when the series ended here. */
  destination_venue_count: number;
}

function toCitation(r: typeof venueClaimCitations.$inferSelect): Citation {
  return {
    id: r.id,
    field: r.field,
    source_url: r.sourceUrl,
    source_type: r.sourceType,
    certainty: r.certainty,
    notes: r.notes,
  };
}

export async function loadVenueHistory(db: Db, venueId: string): Promise<VenueHistory> {
  const periods = await db
    .select()
    .from(seriesVenuePeriods)
    .where(eq(seriesVenuePeriods.venueId, venueId));
  const variants = await db
    .select()
    .from(venueNameVariants)
    .where(eq(venueNameVariants.venueId, venueId));

  // Subqueries, not inArray(ids): the id lists grow with rows, and D1 caps a
  // statement at 100 bound parameters (scripts/check-d1-inarray-params.ts).
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

  // Fan-out: other venues for the same series.
  const fanOut: VenueFanOut[] = [];
  for (const p of periods) {
    const sameSeries = p.seriesId
      ? eq(seriesVenuePeriods.seriesId, p.seriesId)
      : sql`lower(${seriesVenuePeriods.seriesName}) = lower(${p.seriesName ?? ""})`;
    const others = await db
      .select({
        venueId: seriesVenuePeriods.venueId,
        name: venues.name,
        status: venues.status,
        fromEdtf: seriesVenuePeriods.fromEdtf,
        toEdtf: seriesVenuePeriods.toEdtf,
      })
      .from(seriesVenuePeriods)
      .innerJoin(venues, eq(venues.id, seriesVenuePeriods.venueId))
      .where(and(sameSeries, ne(seriesVenuePeriods.venueId, venueId)));
    fanOut.push({
      series_id: p.seriesId,
      series_name: p.seriesName,
      here: { from_edtf: p.fromEdtf, to_edtf: p.toEdtf },
      other_venues: others.map((o) => ({
        venue_id: o.venueId,
        name: o.name,
        status: o.status,
        from_edtf: o.fromEdtf,
        to_edtf: o.toEdtf,
      })),
    });
  }

  return {
    lifecycle_citations: citations.filter((c) => c.venueId === venueId).map(toCitation),
    periods: periods.map((p) => ({
      id: p.id,
      series_id: p.seriesId,
      series_name: p.seriesName,
      from_edtf: p.fromEdtf,
      to_edtf: p.toEdtf,
      certainty: p.certainty,
      notes: p.notes,
      citations: citations.filter((c) => c.seriesVenuePeriodId === p.id).map(toCitation),
    })),
    name_variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      from_edtf: v.fromEdtf,
      to_edtf: v.toEdtf,
      certainty: v.certainty,
      citations: citations.filter((c) => c.venueNameVariantId === v.id).map(toCitation),
    })),
    fan_out: fanOut,
    destination_venue_count: new Set(fanOut.flatMap((f) => f.other_venues.map((o) => o.venue_id)))
      .size,
  };
}
