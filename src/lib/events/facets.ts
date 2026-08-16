/**
 * OPE-395 — the crawlable facet mesh: `/events/{state}/{facet}`.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 * The competitor does not out-rank us with one page; it ranks a MESH of
 * indexable facet pages, each aimed at a long-tail query ("massachusetts craft
 * fairs october", "fairs in the berkshires") and densely interlinked. We filter
 * app-side with query params, which is good UX and produces almost no
 * crawlable landing pages. This module defines the facets and, critically, the
 * rules that decide when one is fit to be indexed.
 *
 * Four kinds, all under the existing state path:
 *   month     /events/massachusetts/august
 *   region    /events/massachusetts/berkshires
 *   type      /events/massachusetts/craft-fairs
 *   weekend   /events/massachusetts/this-weekend
 *
 * ── The central decision: gate INDEXABILITY, never existence ────────────────
 * Facet inventory is seasonal. Measured on prod the day this shipped:
 *
 *   MA   Aug 32  Sep 40  Oct 24  Nov 24  Dec 18 | Jan 7  Feb 7  Mar 4  Apr 1
 *   CT   Aug 18  Sep 43  Oct 21  Nov 17  Dec  8 | Jan 3  Feb 3  Mar 2  Apr 0
 *
 * The spring months are not broken — organisers simply have not published next
 * year's dates yet, and by January the March page will be full. So a facet page
 * ALWAYS exists at its URL and always returns 200; what depth controls is
 * whether it is `noindex` and whether it enters the sitemap.
 *
 * The alternative — creating the URL only once it is deep enough — is worse in
 * every direction: URLs would appear and vanish as counts crossed the line,
 * spending crawl budget re-discovering pages and throwing away whatever link
 * equity each had earned. A stable URL that quietly becomes indexable when the
 * calendar fills needs no redeploy and no migration.
 *
 * This is also the ticket's own guardrail. Thin pages are what "Crawled —
 * currently not indexed" is made of, and we have been burnt by exactly that on
 * the thin NH/VT guides. A page below the floor still serves readers and still
 * links onward; it just does not ask to be indexed.
 *
 * ── Why this cannot regress OPE-390 ────────────────────────────────────────
 * The acceptance requires that these pages emit no `Event` node missing
 * `location`. They emit `ItemList`/`ListItem` (name + url + image) and
 * `BreadcrumbList` — no `Event` nodes at all. The guarantee is structural, not
 * a thing to remember: `Event` JSON-LD is emitted only by the event DETAIL
 * page, where `buildPlaceJsonLd` already cannot return an empty location.
 */
import { and, gte, lt, sql, type SQL } from "drizzle-orm";
import { events, venues } from "@/lib/db/schema";
import { hasOccurrenceInWindowOrUndated } from "@/lib/event-dates";
import { findRegion, regionSlugsFor } from "@/lib/events/facet-regions";

export type FacetKind = "month" | "region" | "type" | "weekend";

/**
 * States with facet ROUTES on disk (`src/app/events/{state}/[facet]/page.tsx`).
 *
 * This gates the nav as well as the sitemap. It is not cosmetic: month and type
 * facets are defined for every state, so rendering the nav on Maine would emit
 * a dozen internal links to URLs that 404 — the single most damaging thing this
 * feature could ship. Adding a state means adding its route file AND this entry,
 * and `facet-registry.test.ts` fails if the two disagree.
 */
export const FACET_STATES = ["massachusetts", "connecticut"] as const;

/** True when `/events/{stateSlug}/{facet}` routes exist for this state. */
export function stateHasFacets(stateSlug: string): boolean {
  return (FACET_STATES as readonly string[]).includes(stateSlug);
}

/**
 * Minimum events before a facet page asks to be indexed.
 *
 * Eight is where a page of cards — each carrying venue, town, date and image —
 * reads as a real listing rather than a stub. It is a judgement call, but a
 * conservative one: below it we lose nothing (the events remain reachable from
 * the state page and the other three facet kinds), while above it we gain a
 * page that answers its query completely.
 */
export const FACET_MIN_EVENTS = 8;

/**
 * "This weekend" is held to a LOWER floor, and the distinction is real rather
 * than a convenience.
 *
 * A March page with four events is UNFINISHED — March will have forty once
 * organisers publish, and indexing it now means indexing a page that
 * misrepresents the month. A this-weekend page with four events is COMPLETE:
 * four is genuinely everything on this weekend, and a reader asking "what's on
 * this weekend" is fully answered. Depth measures completeness for a month and
 * merely measures the season for a weekend, so the same number cannot mean the
 * same thing for both.
 */
export const WEEKEND_MIN_EVENTS = 3;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTH_SLUGS = MONTH_NAMES.map((m) => m.toLowerCase());

/**
 * Event-type facets, slug → the exact category token stored in
 * `events.categories`.
 *
 * The tokens come from the live distribution, not from a wish list: every one
 * of these is carried by real MA or CT inventory. Matching is EXACT against a
 * JSON array member (see `typeCondition`) — a substring `LIKE '%Fair%'` would
 * fold "Craft Fair" and "Agricultural Fair" into the generic "Fairs" page and
 * make three facets near-duplicates of each other, which is precisely the
 * duplicate-content shape that gets a mesh devalued.
 */
export const TYPE_FACETS: Record<string, { label: string; category: string; blurb: string }> = {
  "agricultural-fairs": {
    label: "Agricultural Fairs",
    category: "Agricultural Fair",
    blurb: "County and community fairs with livestock, produce and midway.",
  },
  fairs: {
    label: "Fairs",
    category: "Fair",
    blurb: "Town and community fairs.",
  },
  festivals: {
    label: "Festivals",
    category: "Festival",
    blurb: "Music, harvest, cultural and seasonal festivals.",
  },
  "craft-fairs": {
    label: "Craft Fairs",
    category: "Craft Fair",
    blurb: "Handmade goods from local artisans.",
  },
  "craft-shows": {
    label: "Craft Shows",
    category: "Craft Show",
    blurb: "Juried craft shows and artisan exhibitions.",
  },
  "holiday-markets": {
    label: "Holiday Markets",
    category: "Holiday Market",
    blurb: "Seasonal and holiday shopping markets.",
  },
  "farmers-markets": {
    label: "Farmers Markets",
    category: "Farmers Market",
    blurb: "Fresh produce, local meat and baked goods.",
  },
  "flea-markets": {
    label: "Flea Markets",
    category: "Flea Market",
    blurb: "Flea markets, antiques and second-hand finds.",
  },
  "trade-shows": {
    label: "Trade Shows",
    category: "Trade Show",
    blurb: "Consumer and trade expos.",
  },
  "home-shows": {
    label: "Home Shows",
    category: "Home Show",
    blurb: "Home, garden and remodelling shows.",
  },
  "art-shows": {
    label: "Art Shows",
    category: "Art Show",
    blurb: "Fine art exhibitions and open studios.",
  },
  "food-festivals": {
    label: "Food Festivals",
    category: "Food Festival",
    blurb: "Food, drink and harvest celebrations.",
  },
  "community-events": {
    label: "Community Events",
    category: "Community Event",
    blurb: "Town days, block parties and local celebrations.",
  },
};

export interface ResolvedFacet {
  kind: FacetKind;
  /** URL segment, e.g. "august" | "berkshires" | "craft-fairs". */
  slug: string;
  /** Short display label, e.g. "August" | "The Berkshires". */
  label: string;
  /** A geographic or categorical gloss. Never a claim about an event. */
  blurb: string;
  /** Resolved date window for month/weekend facets; null for region/type. */
  window: { start: Date; end: Date } | null;
  /** Indexability floor for this facet kind. */
  minEvents: number;
}

/**
 * The calendar window for a bare month slug.
 *
 * A month facet is deliberately YEARLESS — `/august`, not `/august-2026`. A
 * stable URL accrues authority year after year, while a dated one throws its
 * ranking away every January and leaves a trail of stale pages behind. So the
 * slug resolves to the NEXT occurrence of that month: on 16 August 2026,
 * "august" is August 2026 (the rest of it) and "march" is March 2027.
 */
export function monthWindow(monthIndex: number, now: Date): { start: Date; end: Date } {
  const year = monthIndex >= now.getUTCMonth() ? now.getUTCFullYear() : now.getUTCFullYear() + 1;
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    // Exclusive upper bound — the first instant of the following month.
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

/**
 * Friday 00:00 UTC through Monday 00:00 UTC (exclusive) of the CURRENT weekend
 * if one is under way, otherwise the coming one.
 *
 * UTC boundaries are correct here rather than merely convenient: `start_date`
 * is stored at noon UTC (see `whenWindowEnd`), which is mid-morning Eastern, so
 * every event sits comfortably inside its own UTC day and no event can slip
 * across a boundary.
 */
export function weekendWindow(now: Date): { start: Date; end: Date } {
  const dow = now.getUTCDay(); // 0 = Sun … 6 = Sat
  // Saturday and Sunday are inside a weekend already; step BACK to its Friday
  // so a Sunday visitor sees the weekend they are in, not the next one.
  const backToFriday = dow === 0 ? 2 : dow === 6 ? 1 : 0;
  const forwardToFriday = dow >= 1 && dow <= 5 ? 5 - dow : 0;
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - backToFriday + forwardToFriday
    )
  );
  const end = new Date(start.getTime() + 3 * 86_400_000);
  return { start, end };
}

/**
 * Resolve a URL segment to a facet, or null when it names nothing.
 *
 * Returning null (→ 404) rather than an empty page matters: `/events/
 * massachusetts/asdf` must not become a soft-404 that renders a real-looking
 * listing of everything in the state. Every valid facet is enumerable, so an
 * unrecognised segment is always a mistake.
 */
export function resolveFacet(
  stateSlug: string,
  facetSlug: string,
  now: Date
): ResolvedFacet | null {
  const monthIndex = MONTH_SLUGS.indexOf(facetSlug);
  if (monthIndex >= 0) {
    const window = monthWindow(monthIndex, now);
    return {
      kind: "month",
      slug: facetSlug,
      label: MONTH_NAMES[monthIndex],
      blurb: `Everything on the calendar for ${MONTH_NAMES[monthIndex]} ${window.start.getUTCFullYear()}.`,
      window,
      minEvents: FACET_MIN_EVENTS,
    };
  }

  if (facetSlug === "this-weekend") {
    return {
      kind: "weekend",
      slug: facetSlug,
      label: "This Weekend",
      blurb: "Fairs, festivals and markets running Friday through Sunday.",
      window: weekendWindow(now),
      minEvents: WEEKEND_MIN_EVENTS,
    };
  }

  const type = TYPE_FACETS[facetSlug];
  if (type) {
    return {
      kind: "type",
      slug: facetSlug,
      label: type.label,
      blurb: type.blurb,
      window: null,
      minEvents: FACET_MIN_EVENTS,
    };
  }

  const region = findRegion(stateSlug, facetSlug);
  if (region) {
    return {
      kind: "region",
      slug: facetSlug,
      label: region.label,
      blurb: region.blurb,
      window: null,
      minEvents: FACET_MIN_EVENTS,
    };
  }

  return null;
}

/** Every facet slug defined for a state, grouped by kind, in nav order. */
export function facetSlugsByKind(stateSlug: string): Record<FacetKind, string[]> {
  return {
    weekend: ["this-weekend"],
    month: [...MONTH_SLUGS],
    region: regionSlugsFor(stateSlug),
    type: Object.keys(TYPE_FACETS),
  };
}

/** Flat list of every facet slug for a state. */
export function allFacetSlugs(stateSlug: string): string[] {
  const byKind = facetSlugsByKind(stateSlug);
  return [...byKind.weekend, ...byKind.month, ...byKind.region, ...byKind.type];
}

/**
 * Exact JSON-array membership for a category token.
 *
 * `json_each` rather than `LIKE '%"Craft Fair"%'` for two reasons: it is an
 * exact match on an array MEMBER, and it sidesteps D1's 50-character cap on
 * LIKE patterns, which threw a hard error in production once already
 * (OPE-404). A NULL or non-array `categories` yields no rows, so the event
 * simply does not match.
 */
function typeCondition(category: string): SQL {
  return sql`EXISTS (SELECT 1 FROM json_each(${events.categories}) WHERE value = ${category})`;
}

/**
 * The additional WHERE conditions for a facet, layered ON TOP of the caller's
 * existing public/upcoming predicates — this never loosens them.
 */
export function facetConditions(stateSlug: string, facet: ResolvedFacet, now: Date): SQL[] {
  switch (facet.kind) {
    case "month":
    case "weekend": {
      const w = facet.window!;
      // Interval OVERLAP, not "starts in the window". A market running May
      // through October is ON in September, and a visitor asking what is on in
      // September must be shown it; keying the month off start_date alone would
      // hide it everywhere except May.
      const overlap = [lt(events.startDate, w.end), gte(events.endDate, w.start)];
      // …but overlap ALONE would put that same season-long market on all twelve
      // month pages, making them near-duplicates of each other — the fastest way
      // to get a facet mesh devalued. OPE-48 already solved this shape: when an
      // event has scheduled `event_days`, require a real occurrence inside the
      // window; when it has none, fall back to the span above.
      //
      // The lower bound is clamped to `now` for the month we are currently in,
      // so "August" in mid-August means the rest of August, not a fortnight that
      // has already happened.
      const lower = w.start.getTime() < now.getTime() ? now : w.start;
      return [...overlap, hasOccurrenceInWindowOrUndated(lower, w.end)];
    }
    case "type":
      return [typeCondition(TYPE_FACETS[facet.slug].category)];
    case "region": {
      const region = findRegion(stateSlug, facet.slug);
      if (!region) return [sql`1 = 0`]; // unreachable — resolveFacet already matched
      // One bound parameter per town. D1 caps a statement at 100 parameters, so
      // region lists are held under ~70 and the registry test asserts it.
      const list = sql.join(
        region.cities.map((c) => sql`${c}`),
        sql`, `
      );
      return [sql`lower(trim(${venues.city})) IN (${list})`];
    }
  }
}

/** True when the facet has the depth to be worth indexing. */
export function isFacetIndexable(facet: ResolvedFacet, eventCount: number): boolean {
  return eventCount >= facet.minEvents;
}

/** Canonical absolute URL for a facet page. */
export function facetUrl(stateSlug: string, facetSlug: string): string {
  return `https://meetmeatthefair.com/events/${stateSlug}/${facetSlug}`;
}

/** Combined conditions helper for callers that want a single SQL fragment. */
export function facetWhere(stateSlug: string, facet: ResolvedFacet, now: Date) {
  return and(...facetConditions(stateSlug, facet, now));
}
