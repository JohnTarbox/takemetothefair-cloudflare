import { OrganizationSchema } from "@/components/seo/OrganizationSchema";
import Link from "next/link";
import { Search, Calendar, MapPin, Users, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EventList } from "@/components/events/event-list";
import { EventCard } from "@/components/events/event-card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, promoters, blogPosts, users } from "@/lib/db/schema";
import { and, gte, eq, desc, count, lte } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import { extractFirstImage } from "@/lib/markdown-utils";
import { formatAuthorName } from "@/lib/utils";

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
  try {
    const db = getCloudflareDb();
    const results = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(isPublicEventStatus(), eq(events.featured, true), gte(events.endDate, new Date())))
      .orderBy(events.startDate)
      .limit(6);

    return results.map((r) => ({
      ...r.events,
      venue: r.venues!,
      promoter: r.promoters!,
    }));
  } catch {
    return [];
  }
}

async function getUpcomingEvents() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(isPublicEventStatus(), gte(events.endDate, new Date())))
      .orderBy(events.startDate)
      .limit(6);

    return results.map((r) => ({
      ...r.events,
      venue: r.venues!,
      promoter: r.promoters!,
    }));
  } catch {
    return [];
  }
}

async function getWeekendEvents() {
  try {
    const db = getCloudflareDb();
    const now = new Date();
    const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const results = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(isPublicEventStatus(), gte(events.endDate, now), lte(events.startDate, horizon)))
      .orderBy(events.startDate)
      .limit(4);
    return results.map((r) => ({
      ...r.events,
      venue: r.venues!,
      promoter: r.promoters!,
    }));
  } catch {
    return [];
  }
}

async function getPlatformCounts() {
  try {
    const db = getCloudflareDb();
    const [eventsRow, venuesRow, vendorsRow] = await Promise.all([
      db
        .select({ n: count() })
        .from(events)
        .where(and(isPublicEventStatus(), gte(events.endDate, new Date()))),
      db.select({ n: count() }).from(venues).where(eq(venues.status, "ACTIVE")),
      db.select({ n: count() }).from(vendors),
    ]);
    return {
      upcomingEvents: eventsRow[0]?.n ?? 0,
      activeVenues: venuesRow[0]?.n ?? 0,
      totalVendors: vendorsRow[0]?.n ?? 0,
    };
  } catch {
    return { upcomingEvents: 0, activeVenues: 0, totalVendors: 0 };
  }
}

async function getRecentBlogPosts() {
  try {
    const db = getCloudflareDb();
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
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const [featuredEvents, upcomingEvents, weekendEvents, counts, recentPosts] = await Promise.all([
    getFeaturedEvents(),
    getUpcomingEvents(),
    getWeekendEvents(),
    getPlatformCounts(),
    getRecentBlogPosts(),
  ]);

  return (
    <div>
      <OrganizationSchema />
      {/* Hero Section */}
      <section className="bg-navy text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 md:py-28 max-h-[600px]">
          <div className="text-center max-w-3xl mx-auto">
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight">
              Discover Local Fairs & Events
            </h1>
            <p className="mt-6 text-lg md:text-xl text-gray-300">
              Find the best fairs, festivals, and community events across New England. Connect with
              vendors and never miss an experience.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/events">
                <Button
                  size="lg"
                  className="w-full sm:w-auto bg-amber text-navy font-semibold hover:bg-amber/90"
                >
                  <Search className="w-5 h-5 mr-2" />
                  Browse Events
                </Button>
              </Link>
              <Link href="/register?role=promoter">
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full sm:w-auto bg-transparent border-white text-white hover:bg-white/10"
                >
                  List Your Event
                </Button>
              </Link>
            </div>
            {/* Stat Callouts — real counts, refreshed every 5 min via revalidate */}
            <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-8 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-amber/20 flex items-center justify-center">
                  <Calendar className="w-4 h-4 text-amber" />
                </div>
                <span className="text-white font-medium">
                  {counts.upcomingEvents.toLocaleString()} upcoming event
                  {counts.upcomingEvents === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-amber/20 flex items-center justify-center">
                  <MapPin className="w-4 h-4 text-amber" />
                </div>
                <span className="text-white font-medium">
                  {counts.activeVenues.toLocaleString()} venue
                  {counts.activeVenues === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-amber/20 flex items-center justify-center">
                  <Users className="w-4 h-4 text-amber" />
                </div>
                <span className="text-white font-medium">
                  {counts.totalVendors.toLocaleString()} vendor
                  {counts.totalVendors === 1 ? "" : "s"} listed
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* This Weekend — replaces the old intent-router cards which just
          duplicated the top nav. Shows events happening in the next 7 days. */}
      {weekendEvents.length > 0 && (
        <section className="py-16 bg-gray-50">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex items-baseline justify-between mb-8">
              <div>
                <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
                  This weekend
                </h2>
                <p className="mt-1 text-gray-600">
                  Events happening in the next 7 days across New England.
                </p>
              </div>
              <Link
                href="/events"
                className="text-navy hover:underline font-medium flex items-center"
              >
                See all <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {weekendEvents.map((event, i) => (
                <EventCard key={event.id} event={event} priority={i < 2} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Browse by State */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900 mb-6 text-center">
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
                className="flex items-center justify-center gap-2 p-4 bg-white rounded-lg border border-gray-200 hover:border-royal hover:shadow-sm transition-all text-center group"
              >
                <MapPin className="w-4 h-4 text-gray-400 group-hover:text-navy" />
                <span className="font-medium text-gray-900 group-hover:text-navy">
                  {state.name}
                </span>
              </Link>
            ))}
          </div>

          <h3 className="text-lg font-semibold text-gray-900 mt-8 mb-4 text-center">
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
                className="px-3 py-2 bg-white rounded-lg border border-gray-200 hover:border-royal hover:shadow-sm transition-all text-center text-sm font-medium text-gray-700 hover:text-navy"
              >
                {cat.name}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Events */}
      {featuredEvents.length > 0 && (
        <section className="py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
                Featured Events
              </h2>
              <Link
                href="/events?featured=true"
                className="text-royal hover:text-navy font-medium flex items-center"
              >
                View All <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </div>
            <EventList events={featuredEvents} />
          </div>
        </section>
      )}

      {/* Upcoming Events */}
      <section className="py-16 bg-gray-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
              Upcoming Events
            </h2>
            <Link
              href="/events"
              className="text-royal hover:text-navy font-medium flex items-center"
            >
              View All <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </div>
          <EventList events={upcomingEvents} emptyMessage="No upcoming events. Check back soon!" />
        </div>
      </section>

      {/* Latest from the Blog */}
      {recentPosts.length > 0 && (
        <section className="py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
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

      {/* CTA Section */}
      <section className="py-16 bg-navy">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
            Ready to Share Your Event?
          </h2>
          <p className="mt-4 text-lg text-gray-300 max-w-2xl mx-auto">
            Whether you&apos;re a promoter organizing fairs or a vendor looking to participate,
            we&apos;ve got you covered.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/register?role=promoter">
              <Button
                size="lg"
                className="w-full sm:w-auto bg-amber text-navy font-semibold hover:bg-amber/90"
              >
                I&apos;m a Promoter
              </Button>
            </Link>
            <Link href="/register?role=vendor">
              <Button
                size="lg"
                variant="outline"
                className="w-full sm:w-auto bg-transparent border-white text-white hover:bg-white/10"
              >
                I&apos;m a Vendor
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Help Section */}
      <section className="py-12 border-t border-gray-200">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 text-center">
            <p className="text-gray-600">Need help getting started?</p>
            <div className="flex gap-4">
              <Link href="/faq" className="text-royal hover:text-navy font-medium">
                FAQ
              </Link>
              <span className="text-gray-300">|</span>
              <Link href="/search-visibility" className="text-royal hover:text-navy font-medium">
                Search Visibility
              </Link>
              <span className="text-gray-300">|</span>
              <Link href="/contact" className="text-royal hover:text-navy font-medium">
                Contact Us
              </Link>
              <span className="text-gray-300">|</span>
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
