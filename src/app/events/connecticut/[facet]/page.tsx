/**
 * OPE-395 — Connecticut facet pages. See the Massachusetts sibling for why
 * `[facet]` under a static state segment cannot collide with `/events/[slug]`.
 */
import type { Metadata } from "next";
import { StateFacetPage, getFacetMetadata } from "@/components/events/state-facet-page";
import { allFacetSlugs } from "@/lib/events/facets";

export const revalidate = 300;

const STATE_SLUG = "connecticut";

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

export default async function ConnecticutFacetPage({
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
