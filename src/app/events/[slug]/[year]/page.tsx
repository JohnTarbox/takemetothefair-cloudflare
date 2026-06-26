/**
 * EH3 P2.3b — per-year occurrence route: /events/<series-slug>/<year>.
 *
 * Resolves (series canonical_slug, year) to the occurrence event's slug and
 * renders it by REUSING the full event-detail page (no renderer duplication).
 * Option A: this URL is self-canonical permanently — getEvent's series branch
 * already canonicalizes a series occurrence to /events/<series>/<year> and emits
 * schema.org superEvent, so delegating here produces the correct canonical +
 * structured data automatically.
 *
 * Inert until the gated P1 backfill: resolveOccurrenceSlug returns null for every
 * (slug, year) today, so this route 404s exactly like any unknown path.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import EventDetailPage from "../page";
import { buildEventMetadata } from "../event-detail-data";
import { resolveOccurrenceSlug } from "@/lib/series/get-occurrence";

export const revalidate = 300;

interface OccurrenceProps {
  params: Promise<{ slug: string; year: string }>;
}

export async function generateMetadata({ params }: OccurrenceProps): Promise<Metadata> {
  const { slug, year } = await params;
  const occSlug = await resolveOccurrenceSlug(slug, year);
  if (!occSlug) return {};
  // K46 — asOccurrence forces the occurrence's Event-detail metadata (canonical
  // /events/<series>/<year>), not the series-landing metadata. Without it a
  // single-occurrence series whose canonical_slug == the occurrence slug would
  // resolve back to the landing and emit a duplicate canonical.
  return buildEventMetadata(occSlug, true);
}

export default async function OccurrencePage({ params }: OccurrenceProps) {
  const { slug, year } = await params;
  const occSlug = await resolveOccurrenceSlug(slug, year);
  if (!occSlug) notFound();
  // K46 — render the occurrence Event detail (with superEvent), not the series
  // landing, so each URL emits exactly one EventSeries block. Called as a plain
  // function (not JSX) to pass the 2nd positional `asOccurrence` arg.
  return EventDetailPage({ params: Promise.resolve({ slug: occSlug }) }, true);
}
