/**
 * OPE-395 — Massachusetts facet pages.
 *
 * `[facet]` sits under the STATIC `massachusetts/` segment, so it cannot
 * collide with the `/events/[slug]` event-detail route: Next.js resolves the
 * static segment first, and the two dynamic segments live on different
 * branches of the tree. (A sibling `/events/[state]/[facet]` would have been a
 * build error against the existing `[slug]/[year]`.)
 */
import type { Metadata } from "next";
import { StateFacetPage, getFacetMetadata } from "@/components/events/state-facet-page";
import { allFacetSlugs } from "@/lib/events/facets";

export const revalidate = 300;

const STATE_SLUG = "massachusetts";

/**
 * Prerender the known facets. The list is pure (no DB), so this is safe at
 * build time. Unknown segments still render on demand and call notFound().
 */
export function generateStaticParams() {
  return allFacetSlugs(STATE_SLUG).map((facet) => ({ facet }));
}

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
