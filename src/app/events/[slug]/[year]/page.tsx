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
import EventDetailPage, { generateMetadata as eventGenerateMetadata } from "../page";
import { resolveOccurrenceSlug } from "@/lib/series/get-occurrence";

export const revalidate = 300;

interface OccurrenceProps {
  params: Promise<{ slug: string; year: string }>;
}

export async function generateMetadata({ params }: OccurrenceProps): Promise<Metadata> {
  const { slug, year } = await params;
  const occSlug = await resolveOccurrenceSlug(slug, year);
  if (!occSlug) return {};
  return eventGenerateMetadata({ params: Promise.resolve({ slug: occSlug }) });
}

export default async function OccurrencePage({ params }: OccurrenceProps) {
  const { slug, year } = await params;
  const occSlug = await resolveOccurrenceSlug(slug, year);
  if (!occSlug) notFound();
  return <EventDetailPage params={Promise.resolve({ slug: occSlug })} />;
}
