import { WebSiteSchema } from "@/components/seo/WebSiteSchema";
import Link from "next/link";
import { MapPin, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HomeSearch } from "@/components/home/HomeSearch";
import { StubEventCard } from "@/components/home/StubEventCard";
import { getCategoryColors } from "@/lib/category-colors";
import { STATES } from "@/lib/states";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, promoters, blogPosts, users } from "@/lib/db/schema";
import { and, gte, eq, desc, count, lte } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { upcomingEndPredicate, whenWindowEnd } from "@/lib/event-dates";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import { extractFirstImage } from "@/lib/markdown-utils";
import { formatAuthorName } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { diversifyByCategory } from "@/lib/diversify-by-category";

import type { Metadata } from "next";

export const revalidate = 300; // Cache for 5 minutes

export const metadata: Metadata = {
  title: "Meet Me at the Fair - Discover Local Fairs, Festivals & Events in New England",
  description:
    "Find fairs, festivals, craft shows, and community events across all six New England states — Maine, New Hampshire, Vermont, Massachusetts, Connecticut, and Rhode Island. Browse events, venues, and vendors.",
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

async function getWeekEvents() {
  const db = getCloudflareDb();
  try {
    const now = new Date();
    // Match the /events?when=week filter exactly (now through the coming Sunday)
    // so the hero preview and its "See all" agree on what "this week" means.
    const horizon = whenWindowEnd("week", now)!;
    // Narrow projection — see getFeaturedEvents above. Pull a WIDER pool than
    // the 4 we render so diversifyByCategory() has room to mix event types
    // (the soonest 4 are often all the same type, e.g. farmers markets).
    const results = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(isPublicEventStatus(), gte(events.endDate, now), lte(events.startDate, horizon)))
      .orderBy(events.startDate)
      .limit(24);
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
    // Diversify by type, then keep only the 4 the grid renders.
    const diversified = diversifyByCategory(flat, 4);
    return await attachEventDayDates(db, diversified);
  } catch (e) {
    await logError(db, {
      message: "Error fetching this-week events",
      error: e,
      source: "app/page.tsx:getWeekEvents",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/page.tsx:getWeekEvents", e);
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
  const [featuredEventsRaw, weekEvents, counts, recentPosts] = await Promise.all([
    getFeaturedEvents(),
    getWeekEvents(),
    getPlatformCounts(),
    getRecentBlogPosts(),
  ]);

  // C2 P3 (2026-06-12) — the hero now carries the "This week" preview and a
  // Browse-by-category module replaced the old "Upcoming" grid, so Featured is
  // the only remaining event grid below. Dedup it against the this-week preview
  // (precedence This Week > Featured) so an event that is both featured AND
  // happening this week isn't shown twice on the page.
  const weekIds = new Set(weekEvents.map((e) => e.id));
  const featuredEvents = featuredEventsRaw.filter((e) => !weekIds.has(e.id));

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
      <section className="relative overflow-hidden border-b border-border">
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-9 md:py-12">
          <div
            className={
              weekEvents.length > 0
                ? "grid items-center gap-x-12 gap-y-10 lg:grid-cols-[1.05fr_0.95fr]"
                : "max-w-3xl"
            }
          >
            <div>
              <span className="mb-3 inline-flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-terracotta">
                <span className="h-[1.5px] w-8 bg-terracotta" />
                New England&apos;s fair &amp; festival almanac
              </span>
              <h1 className="font-display text-[clamp(2.25rem,5vw,3.75rem)] font-semibold leading-[1.0] tracking-tight text-secondary">
                Find your next <em className="font-medium italic text-terracotta">fair</em>,
                festival &amp; market.
              </h1>
              <p className="mt-3 max-w-[52ch] text-base text-muted-foreground">
                Every county fair, craft show, and farmers market across the six New England states
                — one place, always current.
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

            {/* RIGHT — live "This week" preview (compact ticket stubs). Fills
                the hero width with real events + shows the category colour key. */}
            {weekEvents.length > 0 && (
              <div>
                <div className="mb-3 flex items-end justify-between">
                  <div className="text-xs font-bold uppercase tracking-[0.16em] text-terracotta">
                    Happening this week
                  </div>
                  <Link
                    href="/events?when=week"
                    className="flex items-center whitespace-nowrap text-sm font-semibold text-secondary hover:text-terracotta"
                  >
                    See all <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Link>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {weekEvents.slice(0, 4).map((event) => (
                    <StubEventCard key={event.id} event={event} compact />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Browse by State */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-6 text-center">
            Browse Events by State
          </h2>
          {/* All six New England states the site covers — sourced from the
              canonical STATES map so this never drifts from the search dropdown. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Object.values(STATES).map((state) => (
              <Link
                key={state.slug}
                href={`/events/${state.slug}`}
                className="group flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-4 text-center transition-all hover:border-royal hover:shadow-sm"
              >
                <MapPin className="h-4 w-4 text-muted-foreground group-hover:text-navy" />
                <span className="font-medium text-foreground group-hover:text-navy">
                  {state.name}
                </span>
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

      {/* Browse by category — navigational module (C2 P3, replaces the old
          "Upcoming" grid). Colour-coded via the shared category palette so it
          differentiates from the Featured/This-week event grids by purpose. */}
      <section className="border-y border-border bg-muted py-14">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-7 flex items-end justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.16em] text-terracotta">
                By what you love
              </div>
              <h2 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-secondary md:text-4xl">
                Browse by category
              </h2>
            </div>
            <Link
              href="/events"
              className="flex items-center whitespace-nowrap font-semibold text-secondary hover:text-terracotta"
            >
              All events <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              {
                label: "Agricultural Fairs",
                sub: "County & state fairs",
                category: "Agricultural Fair",
                slug: "fairs",
                emoji: "🎡",
              },
              {
                label: "Festivals",
                sub: "Music, food & more",
                category: "Festival",
                slug: "festivals",
                emoji: "🎪",
              },
              {
                label: "Craft Fairs",
                sub: "Makers & artisans",
                category: "Craft Fair",
                slug: "craft-fairs",
                emoji: "🎨",
              },
              {
                label: "Farmers Markets",
                sub: "Local & seasonal",
                category: "Farmers Market",
                slug: "farmers-markets",
                emoji: "🥕",
              },
            ].map((c) => {
              const colors = getCategoryColors([c.category]);
              return (
                <Link
                  key={c.slug}
                  href={`/events/${c.slug}`}
                  className="group overflow-hidden rounded-xl border-[1.5px] border-border bg-card transition-all hover:-translate-y-0.5 hover:border-secondary hover:shadow-[4px_4px_0_rgb(var(--secondary)/0.08)]"
                >
                  <div className="h-2" style={{ background: colors.accent }} />
                  <div className="flex items-center gap-3.5 p-4">
                    <span
                      className={`grid h-11 w-11 flex-none place-items-center rounded-[10px] text-xl ${colors.bg}`}
                      aria-hidden="true"
                    >
                      {c.emoji}
                    </span>
                    <span>
                      <span className="block font-display text-[17px] font-semibold leading-tight text-secondary">
                        {c.label}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                        {c.sub}
                      </span>
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

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

      {/* CTA Section — DM-FIX1 (2026-06-21): use the `--footer` band token, not
       * `--secondary`. `--secondary` lifts to bright sky-blue in dark mode (for
       * accent/text legibility), which turned this large FILLED band into a
       * glaring periwinkle slab. `--footer` is the purpose-built dark-band
       * surface: its LIGHT value (30 39 97) is identical to light `--secondary`
       * (so light mode is pixel-unchanged), and it stays deep navy (19 24 56) in
       * dark mode. White foreground, AAA in both themes. */}
      <section className="py-16 bg-footer text-footer-foreground">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
            Ready to Share Your Event?
          </h2>
          <p className="mt-4 text-lg text-footer-foreground/80 max-w-2xl mx-auto">
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
                className="w-full sm:w-auto bg-transparent border-footer-foreground text-footer-foreground hover:bg-footer-foreground/10"
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
