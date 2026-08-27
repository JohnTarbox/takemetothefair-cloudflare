/**
 * OPE-586 — Maine facet pages (OPE-395 mesh, Phase 1).
 *
 * `[facet]` sits under the STATIC `maine/` segment, so it cannot
 * collide with the `/events/[slug]` event-detail route: Next.js resolves the
 * static segment first, and the two dynamic segments live on different
 * branches of the tree. (A sibling `/events/[state]/[facet]` would have been a
 * build error against the existing `[slug]/[year]`.)
 */
import type { Metadata } from "next";
import { StateFacetPage, getFacetMetadata } from "@/components/events/state-facet-page";

export const revalidate = 300;

const STATE_SLUG = "maine";

// Deliberately NO generateStaticParams. These pages read D1 in both
// generateMetadata and the body, and prerendering them would run those queries
// at BUILD time, where no Cloudflare binding exists — failing the build, or
// worse, baking empty pages that look fine until someone counts the events.
// ISR at revalidate=300 gets the same caching with none of that: the first
// request renders against the live database, the rest are served from cache.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ facet: string }>;
}): Promise<Metadata> {
  const { facet } = await params;
  return getFacetMetadata(STATE_SLUG, facet);
}

export default async function MassachusettsFacetPage({
  params,
  searchParams,
}: {
  params: Promise<{ facet: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { facet } = await params;
  const sp = await searchParams;
  return <StateFacetPage stateSlug={STATE_SLUG} facetSlug={facet} searchParams={sp} />;
}
