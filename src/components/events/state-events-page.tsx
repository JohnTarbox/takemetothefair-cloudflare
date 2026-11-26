import Link from "next/link";
import type { Metadata } from "next";
import { MapPin } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { events, venues, eventInStateWhere } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { kvReadThroughSwr } from "@/lib/kv-swr";
import {
  STATE_LISTING_CACHE_TTL_SECONDS,
  countStateEvents,
  getCachedStateUpcomingSet,
  loadStateEventCards,
  pageSlice,
} from "@/lib/events/state-listing-cache";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { ListEventCtaLink } from "@/components/list-your-event/list-event-cta";
import { getStateColors } from "@/lib/state-colors";
import { STATES, STATE_BY_SLUG } from "@/lib/states";
import { getUpcomingEventYearSpanByState, formatYearSpanLabel } from "@/lib/queries";
import { buildStateTitle, buildStateMetaDescription } from "@/lib/seo-utils";
import { FAQPageSchema } from "@/components/seo/FAQPageSchema";
import { FacetNav } from "@/components/events/facet-nav";
import { stateHasFacets } from "@/lib/events/facets";
import {
  buildStateIntro,
  buildStateFaq,
  STATE_FAQ_MIN_ITEMS,
  type StateInventory,
} from "@/lib/state-page-content";

export const STATE_MAP: Record<string, { code: string; name: string }> = {
  maine: { code: "ME", name: "Maine" },
  vermont: { code: "VT", name: "Vermont" },
  "new-hampshire": { code: "NH", name: "New Hampshire" },
  massachusetts: { code: "MA", name: "Massachusetts" },
  connecticut: { code: "CT", name: "Connecticut" },
  "rhode-island": { code: "RI", name: "Rhode Island" },
};

const STATE_DESCRIPTIONS: Record<string, string> = {
  maine:
    "Maine is home to some of New England's most beloved agricultural fairs, from the iconic Fryeburg Fair — the state's largest — to the Common Ground Country Fair celebrating organic farming. With over 25 county and community fairs, plus dozens of farmers markets and craft shows, Maine's fair season runs from spring through late fall.",
  vermont:
    "Vermont's fair tradition celebrates the state's agricultural heritage, from the Champlain Valley Fair to the famous Tunbridge World's Fair. The state's craft shows highlight Vermont's artisan community, while farmers markets in Burlington, Montpelier, and Rutland offer fresh local produce year-round.",
  "new-hampshire":
    "New Hampshire's fair circuit features events from the Lakes Region to the White Mountains. The Hopkinton State Fair and Deerfield Fair are annual highlights, while craft shows and farmers markets dot the landscape from Concord to the Seacoast region throughout the warmer months.",
  massachusetts:
    "Massachusetts hosts events ranging from the massive Eastern States Exposition (The Big E) in West Springfield to intimate Cape Cod craft fairs. County fairs, harvest festivals, and year-round farmers markets make the Bay State a hub for community events and local artisan culture.",
  connecticut:
    "Connecticut's fair tradition spans from the historic Durham Fair — one of New England's largest agricultural fairs — to beloved community events like the Goshen Fair and North Haven Fair. Craft shows in Mystic and the Litchfield Hills, plus year-round farmers markets from Hartford to Fairfield County, round out the Constitution State's calendar of fairs, festivals, and community events.",
  "rhode-island":
    "Rhode Island may be the smallest state, but its fair calendar is packed — from the Washington County Fair in Richmond, the state's largest agricultural fair, to the Rocky Hill State Fair and seaside summer festivals along the Newport and Narragansett coasts. Farmers markets in Providence, Pawtucket, and South County deliver fresh local produce, while craft fairs celebrate the Ocean State's maritime heritage.",
};

/**
 * OPE-1662 — upcoming listings come from ONE cached copy of the state's
 * upcoming public set (src/lib/events/state-listing-cache.ts), so a `?page=`
 * crawl costs no D1. `includePast=true` (whole history) stays a live paged read.
 */
async function getStateEvents(
  stateCode: string,
  page: number,
  limit: number,
  includePast: boolean = false
) {
  const db = getCloudflareDb();
  if (!includePast) {
    const all = await getCachedStateUpcomingSet(db, getCloudflareRateLimitKv(), stateCode);
    return { events: pageSlice(all, page, limit), total: all.length, page, limit };
  }
  const offset = (page - 1) * limit;
  const [eventsWithVendors, total] = await Promise.all([
    loadStateEventCards(db, stateCode, { includePast, limit, offset }),
    countStateEvents(db, stateCode, includePast),
  ]);
  return { events: eventsWithVendors, total, page, limit };
}

/** OPE-1662 — the year span is a whole-state read too; cache it with the set's TTL. */
function getCachedYearSpan(stateCode: string) {
  return kvReadThroughSwr(
    getCloudflareRateLimitKv(),
    `listing:v1:state-span:${stateCode.toUpperCase()}`,
    STATE_LISTING_CACHE_TTL_SECONDS,
    () => getUpcomingEventYearSpanByState(getCloudflareDb(), stateCode)
  );
}

/**
 * Build Metadata for a state index page. Each `/events/{state}/page.tsx`
 * delegates its `generateMetadata` here so the per-state title/description
 * stays in one place. Count is live (rounded down to nearest 10 for stability
 * across the 5-min revalidate window) and matches what the page actually
 * lists (future events only, public status only).
 */
export async function getStateMetadata(stateSlug: string): Promise<Metadata> {
  const code = STATE_BY_SLUG[stateSlug];
  // Fallback to a minimal Metadata if the slug isn't recognized — the route
  // is statically defined so this branch is mostly a type-narrowing guard.
  if (!code) {
    return { title: "Fairs & Festivals | Meet Me at the Fair" };
  }
  const { name, adjective } = STATES[code];
  // OPE-1662 — the cached upcoming set has exactly countUpcomingEventsByState's
  // predicate (public, in state, dated, not over), so its length IS that count.
  const eventCount = (
    await getCachedStateUpcomingSet(getCloudflareDb(), getCloudflareRateLimitKv(), code)
  ).length;
  // OPE-598 — the year comes from the events this page LISTS, not the clock.
  //
  // Both helpers defaulted to `new Date().getFullYear()` while the list itself
  // is not year-scoped — it renders "upcoming" by date ascending. So on
  // 2026-08-27 Rhode Island read "Fairs & Festivals 2026" over a list holding
  // 2027 events, and Massachusetts rendered 13 of which EIGHT were 2027.
  //
  // This is the SERP snippet, so the cost is not tidiness: someone searching
  // "rhode island fairs 2027" saw a 2026 headline on a page that did have 2027
  // events — the exact query OPE-583 says we are losing.
  const yearLabel = formatYearSpanLabel(await getCachedYearSpan(code));
  const title = buildStateTitle(name, yearLabel);
  const description = buildStateMetaDescription(name, eventCount, adjective, yearLabel);
  const canonical = `https://meetmeatthefair.com/events/${stateSlug}`;
  return {
    title,
    description,
    alternates: { canonical },
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
          alt: `Meet Me at the Fair — Fairs & Festivals in ${name}`,
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

/**
 * OPE-394 — whole-state inventory for the editorial + FAQ layer.
 *
 * Separate from `getStateEvents`, which returns ONE PAGE (30 rows). Deriving
 * "fair season" from a page would describe the first 30 events by date, not the
 * year — a confident sentence about the wrong data. This aggregates across the
 * state instead.
 *
 * One grouped scan plus one distinct-town count. Categories are a JSON array
 * column, so they are tallied in memory over the same rows rather than with a
 * SQL json_each join — the row count here is a state's upcoming events
 * (hundreds), not the whole table.
 */
function getStateInventory(stateCode: string): Promise<StateInventory> {
  // OPE-1662 — a whole-state scan per render; cached per state with the set's TTL.
  return kvReadThroughSwr(
    getCloudflareRateLimitKv(),
    `listing:v1:state-inventory:${stateCode.toUpperCase()}`,
    STATE_LISTING_CACHE_TTL_SECONDS,
    () => loadStateInventory(stateCode)
  );
}

async function loadStateInventory(stateCode: string): Promise<StateInventory> {
  const db = getCloudflareDb();
  const conditions = [
    isPublicEventStatus(),
    eventInStateWhere(stateCode),
    isNotNull(events.startDate),
    upcomingEndPredicate(new Date()),
  ];

  const rows = await db
    .select({
      startDate: events.startDate,
      categories: events.categories,
      city: venues.city,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(...conditions));

  const countsByMonth = new Array(12).fill(0) as number[];
  const catTally = new Map<string, number>();
  const towns = new Set<string>();

  for (const r of rows) {
    if (r.startDate instanceof Date) countsByMonth[r.startDate.getUTCMonth()] += 1;
    if (r.city) towns.add(r.city.trim().toLowerCase());
    try {
      const cats = r.categories ? (JSON.parse(r.categories) as unknown) : [];
      if (Array.isArray(cats)) {
        for (const c of cats) {
          if (typeof c === "string" && c.trim()) {
            const key = c.trim();
            catTally.set(key, (catTally.get(key) ?? 0) + 1);
          }
        }
      }
    } catch {
      // A malformed categories blob is a data problem, not a reason to drop the
      // whole intro. Skip the row's categories and keep its month/town.
    }
  }

  const topCategories = [...catTally.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);

  return {
    upcomingCount: rows.length,
    countsByMonth,
    topCategories,
    townCount: towns.size,
  };
}

interface StateEventsPageProps {
  stateSlug: string;
  searchParams: { page?: string; includePast?: string };
}

export async function StateEventsPage({ stateSlug, searchParams }: StateEventsPageProps) {
  const state = STATE_MAP[stateSlug];
  if (!state) return null;

  const page = parseInt(searchParams.page || "1");
  const limit = 30;
  const includePast = searchParams.includePast === "true";
  const { events: eventsList, total } = await getStateEvents(state.code, page, limit, includePast);
  const totalPages = Math.ceil(total / limit);
  const colors = getStateColors(state.code);

  // OPE-394 — editorial + FAQ layer, derived from the WHOLE state's calendar.
  // OPE-598 — same true label the metadata uses, threaded to the H1, the intro
  // and the FAQ. One source for all six sites; a page that lists 2026 and 2027
  // now says so instead of picking whichever year the server booted in.
  //
  // Issued together: the span query is new here, and awaiting it before the
  // inventory would have added a serial D1 round-trip to a public page render
  // for no ordering reason — the two are independent.
  const [span, inventory] = await Promise.all([
    getCachedYearSpan(state.code),
    getStateInventory(state.code),
  ]);
  const year = formatYearSpanLabel(span);
  const intro = buildStateIntro(state.name, inventory, year);
  const faq = buildStateFaq(state.name, inventory, year);
  // Below the floor we emit NEITHER the block nor the JSON-LD. A thin FAQ is
  // what "Crawled — currently not indexed" is made of, and the epic names that
  // as its own guardrail.
  const showFaq = faq.length >= STATE_FAQ_MIN_ITEMS;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <ItemListSchema
        name={`Fairs & Festivals in ${state.name}`}
        description={`Upcoming fairs, festivals, craft shows, and markets in ${state.name}`}
        items={eventsList.map((e) => ({
          name: e.name,
          url: `https://meetmeatthefair.com/events/${e.slug}`,
          image: e.imageUrl,
        }))}
        totalCount={total}
        positionStart={(page - 1) * limit + 1}
        asCollectionPage
        pageUrl={`https://meetmeatthefair.com/events/${stateSlug}`}
      />
      {showFaq && <FAQPageSchema items={faq} />}
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: state.name, url: `https://meetmeatthefair.com/events/${stateSlug}` },
        ]}
      />

      {/* Hero intro */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colors.bg}`}>
            <MapPin className={`w-5 h-5 ${colors.icon}`} />
          </div>
          <div>
            {/* OPE-394 — H1 now matches the head term exactly, with a rolling
                year, mirroring the <title> that was already retargeted in May.
                The competitor holds 4 SERP slots on this term with H1/title/
                domain all reading the same phrase; ours read "Fairs & Festivals
                in Massachusetts" — inverted and yearless — while the title said
                otherwise. The friendly phrasing survives as the subhead below,
                per the ticket. */}
            <h1 className="text-3xl font-bold text-foreground">
              {state.name} Fairs &amp; Festivals {year}
            </h1>
            <p className="text-sm text-muted-foreground">Fairs &amp; Festivals in {state.name}</p>
          </div>
        </div>
        <p className="mt-2 text-muted-foreground">
          Browse {total} {includePast ? "" : "upcoming "}fairs, festivals, craft shows, and markets
          across {state.name}.
        </p>
        {/* OPE-394 — editorial layer. Every sentence is derived from the
            state's live calendar (counts, month distribution, towns); nothing
            about any fair's hours, prices or admission is asserted, per the
            ticket's grounding rule. */}
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">{intro}</p>

        <nav className="mt-4 text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-navy">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-navy">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{state.name}</span>
        </nav>
      </div>

      {/* Include past events toggle */}
      <form className="mb-6 flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="includePast"
            value="true"
            defaultChecked={includePast}
            className="rounded border-border text-royal focus:ring-royal"
          />
          <span className="text-sm text-foreground">Include past events</span>
        </label>
        <button type="submit" className="text-sm text-royal hover:text-navy font-medium">
          Apply
        </button>
      </form>

      {/* Event listing */}
      {eventsList.length > 0 ? (
        <EventsView
          events={eventsList}
          view="cards"
          emptyMessage={`No upcoming events found in ${state.name}. Check back soon!`}
          currentPage={page}
          totalPages={totalPages}
          searchParams={{
            ...(searchParams.page ? { page: searchParams.page } : {}),
            ...(includePast ? { includePast: "true" } : {}),
          }}
          total={total}
          basePath={`/events/${stateSlug}`}
        />
      ) : (
        <div className="text-center py-12">
          <MapPin className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground text-lg">No upcoming events found in {state.name}.</p>
          <p className="text-muted-foreground mt-2">
            Check back soon or{" "}
            <Link href="/events" className="text-royal hover:text-navy font-medium">
              browse all events
            </Link>
            .
          </p>
        </div>
      )}

      {/* OPE-395 — entry point into the facet mesh. Gated on the state actually
          having facet routes: month and type facets are DEFINED for every state,
          so rendering this unconditionally would link Maine to a dozen 404s. */}
      {stateHasFacets(stateSlug) && <FacetNav stateSlug={stateSlug} stateName={state.name} />}

      {/* OPE-1559 (John, 2026-11-02) — contextual free-listing CTA. */}
      <p className="mt-8 text-center text-sm text-muted-foreground">
        <ListEventCtaLink
          placement="state_page"
          href={`/list-your-event/${stateSlug}`}
          className="font-medium text-royal hover:text-navy"
        >
          Running an event in {state.name}? List it free →
        </ListEventCtaLink>
      </p>

      <div className="mt-8 bg-muted rounded-lg p-6 text-center border border-border">
        <h3 className="text-lg font-semibold text-foreground mb-2">
          Looking for past events in {state.name}?
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Browse fairs and festivals from previous seasons across {state.name}.
        </p>
        <Link
          href={`/events/past?state=${state.code}`}
          className="inline-flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/90 transition-colors text-sm font-medium"
        >
          Browse past events in {state.name} &rarr;
        </Link>
      </div>

      {/* SEO content */}
      {total > 0 && (
        <div className="mt-12 prose prose-gray max-w-none">
          <h2>About Fairs in {state.name}</h2>
          <p>
            {STATE_DESCRIPTIONS[stateSlug] ||
              `${state.name} hosts a vibrant calendar of fairs, festivals, farmers markets, and craft shows throughout the year. From county fairs celebrating local agriculture to artisan craft fairs showcasing handmade goods, there's always something happening.`}{" "}
            Browse our listings to find events near you, check dates and venues, and connect with
            vendors.
          </p>
        </div>
      )}

      {/* OPE-394 — the FAQ must be VISIBLE, not just structured data.
          Google requires FAQPage content to be present on the page for the
          rich result; JSON-LD alone earns nothing and would be a schema claim
          about content a visitor cannot see. Rendered as native <details> so it
          needs no client JS and is expanded-readable by a crawler. */}
      {showFaq && (
        <section className="mt-12 border-t border-border pt-8" aria-labelledby="state-faq-heading">
          <h2 id="state-faq-heading" className="text-xl font-bold text-foreground">
            {state.name} fairs &amp; festivals — common questions
          </h2>
          <dl className="mt-4 space-y-3">
            {faq.map((item) => (
              <div key={item.question} className="rounded-lg border border-border p-4">
                <dt className="font-semibold text-foreground">{item.question}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {item.answer}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
