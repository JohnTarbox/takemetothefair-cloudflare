/**
 * OPE-395 — Connecticut facet pages. See the Massachusetts sibling for why
 * `[facet]` under a static state segment cannot collide with `/events/[slug]`.
 */
import type { Metadata } from "next";
import { StateFacetPage, getFacetMetadata } from "@/components/events/state-facet-page";

export const revalidate = 300;

const STATE_SLUG = "connecticut";

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
