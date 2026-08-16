/**
 * OPE-395 — the rendered facet page: `/events/{state}/{facet}`.
 *
 * One component serves all four facet kinds. They differ only in which events
 * they select and how they describe themselves, and collapsing them into a
 * single template is what keeps thirty-odd pages per state from drifting into
 * thirty-odd slightly different templates.
 *
 * See `@/lib/events/facets` for the indexability rule, which is the substance
 * of this ticket; this file renders the decision rather than making it.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CalendarDays, MapPin, Tag, Sparkles } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { FacetNav } from "@/components/events/facet-nav";
import { getCloudflareDb } from "@/lib/cloudflare";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { truncateAtBoundary } from "@/lib/seo/truncate-meta";
import { STATES, STATE_BY_SLUG } from "@/lib/states";
import { countFacetEvents, getFacetEvents } from "@/lib/events/facet-query";
import {
  resolveFacet,
  isFacetIndexable,
  facetUrl,
  type FacetKind,
  type ResolvedFacet,
} from "@/lib/events/facets";

const PAGE_SIZE = 30;

/**
 * Resolve a state slug to its code and display name.
 *
 * Reads `@/lib/states` rather than the state page's own STATE_MAP: importing
 * that module would pull the whole StateEventsPage server component, and its
 * queries, into every facet page's module graph for the sake of two strings.
 */
function lookupState(stateSlug: string): { code: string; name: string } | null {
  const code = STATE_BY_SLUG[stateSlug];
  return code ? { code, name: STATES[code].name } : null;
}

/** Human phrasing for each facet kind, used in the <title>, H1 and intro. */
function headline(facet: ResolvedFacet, stateName: string): string {
  switch (facet.kind) {
    case "month":
      return `${stateName} Fairs & Festivals in ${facet.label} ${facet.window!.start.getUTCFullYear()}`;
    case "weekend":
      return `${stateName} Fairs & Festivals This Weekend`;
    case "region":
      return `Fairs & Festivals in ${facet.label}, ${stateName}`;
    case "type":
      return `${facet.label} in ${stateName}`;
  }
}

/**
 * The SERP snippet.
 *
 * Written per kind rather than by lower-casing the H1: "32 upcoming
 * massachusetts fairs & festivals in august 2026" is what that shortcut
 * produces, and a lower-cased proper noun in a search result reads as broken.
 * Truncated on a word boundary at Google's ~155-character display limit.
 */
function metaDescription(facet: ResolvedFacet, stateName: string, total: number): string {
  const tail =
    total > 0
      ? `${total} listed, with dates, venues and details.`
      : `Check back as organisers publish their dates.`;
  switch (facet.kind) {
    case "month":
      return truncateAtBoundary(
        `Every fair, festival, craft show and market on the ${stateName} calendar for ${facet.label} ${facet.window!.start.getUTCFullYear()} — ${tail}`
      );
    case "weekend":
      return truncateAtBoundary(
        `What's on in ${stateName} this weekend — fairs, festivals, craft shows and markets. ${tail}`
      );
    case "region":
      return truncateAtBoundary(
        `Fairs, festivals, craft shows and markets in ${facet.label}, ${stateName} — ${tail}`
      );
    case "type":
      return truncateAtBoundary(`${facet.label} across ${stateName} — ${tail}`);
  }
}

const KIND_ICON: Record<FacetKind, typeof CalendarDays> = {
  month: CalendarDays,
  weekend: Sparkles,
  region: MapPin,
  type: Tag,
};

/**
 * Metadata, including the `noindex` decision.
 *
 * The count is recomputed here rather than threaded from the page render —
 * Next.js runs `generateMetadata` and the page as separate calls, and both go
 * through `countFacetEvents`/`getFacetEvents`, which share one predicate
 * builder. The alternative, caching a count across the two, would buy one
 * cheap COUNT and add a way for the robots tag to disagree with the listing.
 */
export async function getFacetMetadata(stateSlug: string, facetSlug: string): Promise<Metadata> {
  const state = lookupState(stateSlug);
  const now = new Date();
  const facet = state ? resolveFacet(stateSlug, facetSlug, now) : null;
  if (!state || !facet) {
    // The route calls notFound() for the same input; keep metadata harmless.
    return { title: "Not found | Meet Me at the Fair", robots: { index: false, follow: false } };
  }

  const db = getCloudflareDb();
  const total = await countFacetEvents(db, state.code, stateSlug, facet, now);
  const indexable = isFacetIndexable(facet, total);

  const title = `${headline(facet, state.name)} | Meet Me at the Fair`;
  const description = metaDescription(facet, state.name, total);
  const canonical = facetUrl(stateSlug, facetSlug);

  return {
    title,
    description,
    alternates: { canonical },
    // Below the depth floor the page still serves readers and still passes link
    // equity onward — it just does not ask to be indexed. `follow` stays true so
    // the events it lists are still discovered through it.
    robots: indexable ? undefined : { index: false, follow: true },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "Meet Me at the Fair",
      images: [
        {
          url: "https://meetmeatthefair.com/og-default.png",
          width: 1200,
          height: 630,
          alt: headline(facet, state.name),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["https://meetmeatthefair.com/og-default.png"],
    },
  };
}

interface StateFacetPageProps {
  stateSlug: string;
  facetSlug: string;
  searchParams: { page?: string };
}

export async function StateFacetPage({ stateSlug, facetSlug, searchParams }: StateFacetPageProps) {
  const state = lookupState(stateSlug);
  const now = new Date();
  const facet = state ? resolveFacet(stateSlug, facetSlug, now) : null;
  // An unrecognised segment is always a mistake, never an empty listing. A
  // soft-404 that renders a plausible page is far worse than a 404: it gets
  // indexed, and then every typo is a competing URL.
  if (!state || !facet) notFound();

  const page = Math.max(1, parseInt(searchParams.page || "1", 10) || 1);
  const db = getCloudflareDb();
  const { events: eventsList, total } = await getFacetEvents(
    db,
    state.code,
    stateSlug,
    facet,
    now,
    page,
    PAGE_SIZE
  );
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const heading = headline(facet, state.name);
  const Icon = KIND_ICON[facet.kind];

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      {/* ItemList of ListItems — deliberately NOT Event nodes. The OPE-390
          acceptance asks that these pages emit no Event missing `location`;
          emitting no Event at all satisfies it structurally. Event JSON-LD
          belongs on the detail page, where the venue is known. */}
      {eventsList.length > 0 && (
        <ItemListSchema
          name={heading}
          description={facet.blurb}
          items={eventsList.map((e) => ({
            name: e.name,
            url: `https://meetmeatthefair.com/events/${e.slug}`,
            image: e.imageUrl,
          }))}
          totalCount={total}
          positionStart={(page - 1) * PAGE_SIZE + 1}
          asCollectionPage
          pageUrl={facetUrl(stateSlug, facetSlug)}
        />
      )}
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: state.name, url: `https://meetmeatthefair.com/events/${stateSlug}` },
          { name: facet.label, url: facetUrl(stateSlug, facetSlug) },
        ]}
      />

      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-muted">
            <Icon className="w-5 h-5 text-royal" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">{heading}</h1>
        </div>

        <p className="mt-2 text-muted-foreground">
          {total > 0
            ? `${total} upcoming ${total === 1 ? "event" : "events"}. ${facet.blurb}`
            : facet.blurb}
        </p>

        <nav className="mt-4 text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-navy">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-navy">
            Events
          </Link>
          <span className="mx-2">/</span>
          <Link href={`/events/${stateSlug}`} className="hover:text-navy">
            {state.name}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{facet.label}</span>
        </nav>
      </div>

      {eventsList.length > 0 ? (
        <EventsView
          events={eventsList}
          view="cards"
          emptyMessage={`Nothing listed yet for ${facet.label}.`}
          currentPage={page}
          totalPages={totalPages}
          searchParams={searchParams.page ? { page: searchParams.page } : {}}
          total={total}
          basePath={`/events/${stateSlug}/${facetSlug}`}
        />
      ) : (
        /* An empty facet is a normal state, not an error — a March page in
           August simply has nothing published yet. Say so plainly and send the
           reader somewhere useful rather than showing a bare "no results". */
        <div className="rounded-lg border border-border bg-muted/40 py-12 text-center">
          <Icon className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-lg text-muted-foreground">
            Nothing listed for {facet.label} in {state.name} yet.
          </p>
          <p className="mt-2 text-muted-foreground">
            Organisers publish dates throughout the year — or{" "}
            <Link href={`/events/${stateSlug}`} className="text-royal hover:text-navy font-medium">
              browse everything in {state.name}
            </Link>
            .
          </p>
        </div>
      )}

      <FacetNav stateSlug={stateSlug} stateName={state.name} currentFacetSlug={facetSlug} />

      <div className="mt-8 text-center">
        <Link
          href={`/events/${stateSlug}`}
          className="inline-flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/90 transition-colors text-sm font-medium"
        >
          All {state.name} fairs &amp; festivals &rarr;
        </Link>
      </div>
    </div>
  );
}
