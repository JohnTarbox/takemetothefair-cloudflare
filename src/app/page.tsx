import { WebSiteSchema } from "@/components/seo/WebSiteSchema";
import Link from "next/link";
import { MapPin, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HomeSearch } from "@/components/home/HomeSearch";
import { StubEventCard } from "@/components/home/StubEventCard";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, promoters, blogPosts, users } from "@/lib/db/schema";
import { and, gte, eq, desc, count, lte } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import { extractFirstImage } from "@/lib/markdown-utils";
import { formatAuthorName } from "@/lib/utils";
import { logError } from "@/lib/logger";

import type { Metadata } from "next";

export const revalidate = 300; // Cache for 5 minutes

export const metadata: Metadata = {
  title: "Meet Me at the Fair - Discover Local Fairs, Festivals & Events in New England",
  description:
    "Find fairs, festivals, craft shows, and community events across Maine, Vermont, New Hampshire, and Massachusetts. Browse events, venues, and vendors.",
  alternates: { canonical: "https://meetmeatthefair.com" },
  openGraph: {
    title: "Meet Me at the Fair - Discover Local Fairs & Events",
    description: "Find fairs, festivals, craft shows, and community events across New England.",
    url: "https://meetmeatthefair.com",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Discover Local Fairs, Festivals & Events",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Meet Me at the Fair - Discover Local Fairs & Events",
    description: "Find fairs, festivals, craft shows, and community events across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

async function getFeaturedEvents() {
  const db = getCloudflareDb();
  try {
    // Narrow projection via eventJoinProjection — keeps the join under D1's
    // 100-col cap (events 62 + venue 13 + promoter 7 = 82 cols). The bare
    // `.select()` shape this replaces summed to 62+30+15=107 post-P3a and
    // silently returned zero rows; the bug was hidden by no featured events
    // existing in prod data. See PR #359 audit script + #357 hotfix.
    const results = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(
        and(isPublicEventStatus(), eq(events.featured, true), upcomingEndPredicate(new Date()))
      )
      .orderBy(events.startDate)
      .limit(6);

    // Cast the narrow venue/promoter projection back to full row types so
    // the EventCard/EventList prop contract compiles unchanged. Sound
    // because every consumer field is present in the projection (same
    // pattern as src/app/events/[slug]/page.tsx).
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    const flat = results.map((r) => ({
      ...r.events,
      venue: r.venue as FullVenue,
      promoter: r.promoter as FullPromoter,
    }));
    // Cohort 7 follow-up (2026-06-01) — attach event_days so EventCard's
    // date badge resolves the next occurrence instead of falling back
    // to startDate. Cheap batch query (one SELECT for all 6 events).
    return await attachEventDayDates(db, flat);
  } catch (e) {
    await logError(db, {
      message: "Error fetching featured events",
      error: e,
      source: "app/page.tsx:getFeaturedEvents",
    });
    // K2 (2026-06-06): throw FetchError so error.tsx renders + HTTP 500
    // bubbles to the edge. Mirrors REL1' §1 pattern in events/page.tsx.
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/page.tsx:getFeaturedEvents", e);
  }
}

async function getUpcomingEvents() {
  const db = getCloudflareDb();
  try {
    // Narrow projection — see getFeaturedEvents above.
    //
    // Over-fetch (10 instead of 6) so the HomePage render-time dedup
    // against weekendEvents (limit 4) can still produce a full 6-card
    // grid even when all 4 weekend events overlap upcoming. Worst case
    // post-dedup: 10 - 4 = 6 cards. The HomePage component slices to
    // 6 visible after filtering.
    const results = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(isPublicEventStatus(), upcomingEndPredicate(new Date())))
      .orderBy(events.startDate)
      .limit(10);

    // Cast the narrow venue/promoter projection back to full row types so
    // the EventCard/EventList prop contract compiles unchanged. Sound
    // because every consumer field is present in the projection (same
    // pattern as src/app/events/[slug]/page.tsx).
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    const flat = results.map((r) => ({
      ...r.events,
      venue: r.venue as FullVenue,
      promoter: r.promoter as FullPromoter,
    }));
    return await attachEventDayDates(db, flat);
  } catch (e) {
    await logError(db, {
      message: "Error fetching upcoming events",
      error: e,
      source: "app/page.tsx:getUpcomingEvents",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/page.tsx:getUpcomingEvents", e);
  }
}

async function getWeekendEvents() {
  const db = getCloudflareDb();
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    // Narrow projection — see getFeaturedEvents above.
    const results = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(isPublicEventStatus(), gte(events.endDate, now), lte(events.startDate, horizon)))
      .orderBy(events.startDate)
      .limit(4);
    // Cast the narrow venue/promoter projection back to full row types so
    // the EventCard/EventList prop contract compiles unchanged. Sound
    // because every consumer field is present in the projection (same
    // pattern as src/app/events/[slug]/page.tsx).
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    const flat = results.map((r) => ({
      ...r.events,
      venue: r.venue as FullVenue,
      promoter: r.promoter as FullPromoter,
    }));
    return await attachEventDayDates(db, flat);
  } catch (e) {
    await logError(db, {
      message: "Error fetching weekend events",
      error: e,
      source: "app/page.tsx:getWeekendEvents",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/page.tsx:getWeekendEvents", e);
  }
}

async function getPlatformCounts() {
  const db = getCloudflareDb();
  try {
    const [eventsRow, venuesRow, vendorsRow] = await Promise.all([
      db
        .select({ n: count() })
        .from(events)
        .where(and(isPublicEventStatus(), upcomingEndPredicate(new Date()))),
      db.select({ n: count() }).from(venues).where(eq(venues.status, "ACTIVE")),
      db.select({ n: count() }).from(vendors),
    ]);
    return {
      upcomingEvents: eventsRow[0]?.n ?? 0,
      activeVenues: venuesRow[0]?.n ?? 0,
      totalVendors: vendorsRow[0]?.n ?? 0,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching platform counts",
      error: e,
      source: "app/page.tsx:getPlatformCounts",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/page.tsx:getPlatformCounts", e);
  }
}

async function getRecentBlogPosts() {
  const db = getCloudflareDb();
  try {
    const posts = await db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        body: blogPosts.body,
        featuredImageUrl: blogPosts.featuredImageUrl,
        authorName: users.name,
        tags: blogPosts.tags,
        categories: blogPosts.categories,
        status: blogPosts.status,
        publishDate: blogPosts.publishDate,
      })
      .from(blogPosts)
      .leftJoin(users, eq(blogPosts.authorId, users.id))
      .where(eq(blogPosts.status, "PUBLISHED"))
      .orderBy(desc(blogPosts.publishDate))
      .limit(3);

    return posts.map((p) => ({
      ...p,
      authorName: formatAuthorName(p.authorName),
      tags: JSON.parse(p.tags || "[]") as string[],
      categories: JSON.parse(p.categories || "[]") as string[],
      featuredImageUrl: p.featuredImageUrl || extractFirstImage(p.body),
    }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching recent blog posts",
      error: e,
      source: "app/page.tsx:getRecentBlogPosts",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/page.tsx:getRecentBlogPosts", e);
  }
}

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [featuredEvents, upcomingEventsRaw, weekendEvents, counts, recentPosts] = await Promise.all(
    [
      getFeaturedEvents(),
      getUpcomingEvents(),
      getWeekendEvents(),
      getPlatformCounts(),
      getRecentBlogPosts(),
    ]
  );

  // Homepage dedup (2026-06-08) — pre-fix, the 4 recurring farmers markets
  // happening this week appeared in BOTH the "This weekend" grid AND the
  // "Upcoming events" grid (each query qualified them independently). User
  // saw "same 4 markets twice" on the homepage.
  //
  // Fix: filter Weekend IDs out of the Upcoming list at render-time.
  // Weekend stays primary (most-relevant). Upcoming then shows the next
  // distinct events after the weekend window.
  //
  // Featured is intentionally NOT deduped — the `featured` flag is
  // operator-curated and shouldn't be suppressed just because the same
  // event also happens this weekend; if an operator marked it featured,
  // we want it visible in both contexts (and most featured events are
  // multi-day specials, not the recurring markets that drove this bug).
  const weekendIds = new Set(weekendEvents.map((e) => e.id));
  const upcomingEvents = upcomingEventsRaw.filter((e) => !weekendIds.has(e.id)).slice(0, 6);

  return (
    <div>
      <WebSiteSchema />
      {/* Hero Section.
       *
       * Dark-mode token sweep (2026-06-08) — `bg-secondary text-secondary-foreground` was
       * shipping at 2.47:1 in dark mode because --navy lifts to a
       * light-blue (#7aa6ee) in dark for text-on-dark-bg readability,
       * but white text on that lifted bg fails AA. Migrating to the
       * --secondary / --secondary-foreground pair: in light it's
       * identical (navy + white = 13.6:1 AAA); in dark the band
       * inverts to light-blue + dark text = 7.6:1 AAA. The hero is
       * intentionally a lifted-band design moment in dark mode, not
       * a fixed brand color.
       */}
      {/* C2 redesign (2026-06-12) — "almanac" hero on cream (was a flat navy
          band). Editorial left-aligned headline in Fraunces, the search as the
          primary action, a ruled almanac stat strip. See
          docs/c2-homepage-redesign-brief.md. */}
      <section className="relative overflow-hidden">
        {/* faint concentric contour-rings motif, top-right */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-44 -top-28 h-[620px] w-[620px]"
          style={{
            background:
              "radial-gradient(circle at center, transparent 0 38%, rgb(var(--accent-sage)/0.10) 38% 39%, transparent 39%)," +
              "radial-gradient(circle at center, transparent 0 48%, rgb(var(--accent-sage)/0.09) 48% 49%, transparent 49%)," +
              "radial-gradient(circle at center, transparent 0 58%, rgb(var(--accent-sage)/0.08) 58% 59%, transparent 59%)," +
              "radial-gradient(circle at center, transparent 0 68%, rgb(var(--accent-gold)/0.10) 68% 69%, transparent 69%)",
          }}
        />
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-9 md:py-12">
          <div className="max-w-3xl">
            <span className="mb-3 inline-flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-terracotta">
              <span className="h-[1.5px] w-8 bg-terracotta" />
              New England&apos;s fair &amp; festival almanac
            </span>
            <h1 className="font-display text-[clamp(2.25rem,5vw,3.75rem)] font-semibold leading-[1.0] tracking-tight text-secondary">
              Find your next <em className="font-medium italic text-terracotta">fair</em>, festival
              &amp; market.
            </h1>
            <p className="mt-3 max-w-[52ch] text-base text-muted-foreground">
              Every county fair, craft show, and farmers market across the six New England states —
              one place, always current.
            </p>

            <HomeSearch />

            {/* Almanac stat strip + promoter CTA on one compact row */}
            <div className="mt-6 flex max-w-[760px] flex-wrap items-center gap-x-6 gap-y-3 border-y border-border py-3">
              <dl className="flex flex-1 flex-wrap gap-x-6 gap-y-2">
                {[
                  { num: counts.upcomingEvents.toLocaleString(), lbl: "events" },
                  { num: counts.activeVenues.toLocaleString(), lbl: "venues" },
                  { num: counts.totalVendors.toLocaleString(), lbl: "vendors" },
                  { num: "6", lbl: "states" },
                ].map((s) => (
                  <div key={s.lbl} className="flex items-baseline gap-1.5">
                    <dd className="font-display text-xl font-semibold leading-none text-secondary">
                      {s.num}
                    </dd>
                    <dt className="text-[13px] text-muted-foreground">{s.lbl}</dt>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-muted-foreground">
                Organizing an event?{" "}
                <Link
                  href="/register?role=promoter"
                  className="font-semibold text-secondary underline underline-offset-2 hover:text-terracotta"
                >
                  List it free
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* This Weekend — ticket-stub cards (C2 redesign). Shows the next 7 days. */}
      {weekendEvents.length > 0 && (
        <section className="border-y border-border bg-muted py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-7 flex items-end justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.16em] text-terracotta">
                  Happening soon
                </div>
                <h2 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-secondary md:text-4xl">
                  This weekend across New England
                </h2>
              </div>
              <Link
                href="/events"
                className="flex items-center whitespace-nowrap font-semibold text-secondary hover:text-terracotta"
              >
                See all <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {weekendEvents.map((event) => (
                <StubEventCard key={event.id} event={event} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Browse by State */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-6 text-center">
            Browse Events by State
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { name: "Maine", slug: "maine", code: "ME" },
              { name: "Vermont", slug: "vermont", code: "VT" },
              { name: "New Hampshire", slug: "new-hampshire", code: "NH" },
              { name: "Massachusetts", slug: "massachusetts", code: "MA" },
            ].map((state) => (
              <Link
                key={state.slug}
                href={`/events/${state.slug}`}
                className="flex items-center justify-center gap-2 p-4 bg-card rounded-lg border border-border hover:border-royal hover:shadow-sm transition-all text-center group"
              >
                <MapPin className="w-4 h-4 text-muted-foreground group-hover:text-navy" />
                <span className="font-medium text-foreground group-hover:text-navy">
                  {state.name}
                </span>
              </Link>
            ))}
          </div>

          <h3 className="text-lg font-semibold text-foreground mt-8 mb-4 text-center">
            Browse by Event Type
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { name: "Fairs", slug: "fairs" },
              { name: "Festivals", slug: "festivals" },
              { name: "Craft Shows", slug: "craft-shows" },
              { name: "Craft Fairs", slug: "craft-fairs" },
              { name: "Markets", slug: "markets" },
              { name: "Farmers Markets", slug: "farmers-markets" },
            ].map((cat) => (
              <Link
                key={cat.slug}
                href={`/events/${cat.slug}`}
                className="px-3 py-2 bg-card rounded-lg border border-border hover:border-royal hover:shadow-sm transition-all text-center text-sm font-medium text-foreground hover:text-navy"
              >
                {cat.name}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Events — editorial picks, ticket-stub cards (C2 redesign) */}
      {featuredEvents.length > 0 && (
        <section className="py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-7 flex items-end justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.16em] text-terracotta">
                  Editor&apos;s picks
                </div>
                <h2 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-secondary md:text-4xl">
                  Featured events
                </h2>
              </div>
              <Link
                href="/events?featured=true"
                className="flex items-center whitespace-nowrap font-semibold text-secondary hover:text-terracotta"
              >
                View all <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {featuredEvents.slice(0, 8).map((event) => (
                <StubEventCard key={event.id} event={event} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Upcoming Events — ticket-stub cards (C2 redesign) */}
      {upcomingEvents.length > 0 && (
        <section className="border-y border-border bg-muted py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-7 flex items-end justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.16em] text-terracotta">
                  Plan ahead
                </div>
                <h2 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-secondary md:text-4xl">
                  Upcoming events
                </h2>
              </div>
              <Link
                href="/events"
                className="flex items-center whitespace-nowrap font-semibold text-secondary hover:text-terracotta"
              >
                View all <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {upcomingEvents.slice(0, 8).map((event) => (
                <StubEventCard key={event.id} event={event} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Latest from the Blog */}
      {recentPosts.length > 0 && (
        <section className="py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
                Latest from the Blog
              </h2>
              <Link
                href="/blog"
                className="text-royal hover:text-navy font-medium flex items-center"
              >
                View All <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {recentPosts.map((post) => (
                <BlogPostCard key={post.slug} post={post} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA Section — same dark-mode reasoning as the hero above:
       * --secondary pair stays AA in both themes (13.6:1 light, 7.6:1 dark). */}
      <section className="py-16 bg-secondary text-secondary-foreground">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
            Ready to Share Your Event?
          </h2>
          <p className="mt-4 text-lg text-secondary-foreground/80 max-w-2xl mx-auto">
            Whether you&apos;re a promoter organizing fairs or a vendor looking to participate,
            we&apos;ve got you covered.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/register?role=promoter">
              <Button
                size="lg"
                className="w-full sm:w-auto bg-amber text-primary-foreground font-semibold hover:bg-amber/90"
              >
                I&apos;m a Promoter
              </Button>
            </Link>
            <Link href="/register?role=vendor">
              <Button
                size="lg"
                variant="outline"
                className="w-full sm:w-auto bg-transparent border-secondary-foreground text-secondary-foreground hover:bg-secondary-foreground/10"
              >
                I&apos;m a Vendor
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Help Section */}
      <section className="py-12 border-t border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 text-center">
            <p className="text-muted-foreground">Need help getting started?</p>
            <div className="flex gap-4">
              <Link href="/faq" className="text-royal hover:text-navy font-medium">
                FAQ
              </Link>
              <span className="text-muted-foreground">|</span>
              <Link href="/search-visibility" className="text-royal hover:text-navy font-medium">
                Search Visibility
              </Link>
              <span className="text-muted-foreground">|</span>
              <Link href="/contact" className="text-royal hover:text-navy font-medium">
                Contact Us
              </Link>
              <span className="text-muted-foreground">|</span>
              <Link href="/blog" className="text-royal hover:text-navy font-medium">
                Blog
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
