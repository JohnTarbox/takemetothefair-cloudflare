import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Calendar, MapPin, Store, FileText, Search } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, blogPosts, users } from "@/lib/db/schema";
import { and, gte, eq, sql, desc } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { formatDateRange } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { extractFirstImage } from "@/lib/markdown-utils";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Search Results | Meet Me at the Fair",
  robots: { index: false },
};

interface SearchPageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const q = params.q?.trim() || "";

  if (!q || q.length < 2) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 text-center">
        <Search className="w-12 h-12 text-gray-300 mx-auto mb-4" />
        <h1 className="text-2xl font-bold text-navy mb-2">Search</h1>
        <p className="text-gray-500">Enter at least 2 characters to search.</p>
      </div>
    );
  }

  const db = getCloudflareDb();
  const searchTerm = `%${q}%`;

  const [eventResults, venueResults, vendorResults, blogResults] = await Promise.all([
    db
      .select({
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        categories: events.categories,
      })
      .from(events)
      .where(
        and(
          isPublicEventStatus(),
          gte(events.endDate, new Date()),
          sql`(LOWER(${events.name}) LIKE LOWER(${searchTerm}) OR LOWER(${events.description}) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(events.startDate)
      .limit(12),

    db
      .select({
        name: venues.name,
        slug: venues.slug,
        city: venues.city,
        state: venues.state,
        imageUrl: venues.imageUrl,
      })
      .from(venues)
      .where(
        and(
          eq(venues.status, "ACTIVE"),
          sql`(LOWER(${venues.name}) LIKE LOWER(${searchTerm}) OR LOWER(${venues.city}) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(venues.name)
      .limit(12),

    db
      .select({
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        logoUrl: vendors.logoUrl,
      })
      .from(vendors)
      .where(sql`(LOWER(${vendors.businessName}) LIKE LOWER(${searchTerm}) OR LOWER(${vendors.description}) LIKE LOWER(${searchTerm}))`)
      .orderBy(vendors.businessName)
      .limit(12),

    db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        body: blogPosts.body,
        featuredImageUrl: blogPosts.featuredImageUrl,
        publishDate: blogPosts.publishDate,
        authorName: users.name,
      })
      .from(blogPosts)
      .leftJoin(users, eq(blogPosts.authorId, users.id))
      .where(
        and(
          eq(blogPosts.status, "PUBLISHED"),
          sql`(LOWER(${blogPosts.title}) LIKE LOWER(${searchTerm}) OR LOWER(${blogPosts.body}) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(desc(blogPosts.publishDate))
      .limit(12),
  ]);

  const totalResults = eventResults.length + venueResults.length + vendorResults.length + blogResults.length;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-navy">Search Results</h1>
        <p className="mt-2 text-gray-600">
          {totalResults === 0
            ? `No results found for "${q}"`
            : `Found ${totalResults} result${totalResults !== 1 ? "s" : ""} for "${q}"`}
        </p>
      </div>

      {totalResults === 0 && (
        <div className="text-center py-12">
          <Search className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">Try a different search term or browse by category.</p>
          <div className="flex justify-center gap-4 mt-6">
            <Link href="/events" className="text-royal hover:underline">Browse Events</Link>
            <Link href="/venues" className="text-royal hover:underline">Browse Venues</Link>
            <Link href="/vendors" className="text-royal hover:underline">Browse Vendors</Link>
            <Link href="/blog" className="text-royal hover:underline">Browse Blog</Link>
          </div>
        </div>
      )}

      <div className="space-y-10">
        {/* Events */}
        {eventResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="w-5 h-5 text-amber" />
              <h2 className="text-xl font-semibold text-navy">Events ({eventResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {eventResults.map((event) => (
                <Link key={event.slug} href={`/events/${event.slug}`}>
                  <Card className="p-4 hover:shadow-md transition-shadow h-full">
                    <h3 className="font-medium text-navy">{event.name}</h3>
                    <p className="text-sm text-gray-500 mt-1">
                      {formatDateRange(event.startDate, event.endDate)}
                    </p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Blog Posts */}
        {blogResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <FileText className="w-5 h-5 text-purple-600" />
              <h2 className="text-xl font-semibold text-navy">Blog Posts ({blogResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {blogResults.map((post) => {
                const imageUrl = post.featuredImageUrl || extractFirstImage(post.body);
                return (
                  <Link key={post.slug} href={`/blog/${post.slug}`}>
                    <Card className="hover:shadow-md transition-shadow h-full overflow-hidden">
                      {imageUrl && (
                        <div className="aspect-video relative bg-gray-100">
                          <Image
                            src={imageUrl}
                            alt={post.title}
                            fill
                            sizes="(max-width: 768px) 100vw, 33vw"
                            className="object-cover"
                          />
                        </div>
                      )}
                      <div className="p-4">
                        <h3 className="font-medium text-navy">{post.title}</h3>
                        {post.excerpt && (
                          <p className="text-sm text-gray-500 mt-1 line-clamp-2">{post.excerpt}</p>
                        )}
                        <div className="flex items-center gap-3 text-xs text-gray-400 mt-2">
                          {post.publishDate && (
                            <span>{new Date(post.publishDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</span>
                          )}
                          {post.authorName && <span>{post.authorName}</span>}
                        </div>
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* Venues */}
        {venueResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="w-5 h-5 text-royal" />
              <h2 className="text-xl font-semibold text-navy">Venues ({venueResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {venueResults.map((venue) => (
                <Link key={venue.slug} href={`/venues/${venue.slug}`}>
                  <Card className="p-4 hover:shadow-md transition-shadow h-full">
                    <h3 className="font-medium text-navy">{venue.name}</h3>
                    {(venue.city || venue.state) && (
                      <p className="text-sm text-gray-500 mt-1">
                        {[venue.city, venue.state].filter(Boolean).join(", ")}
                      </p>
                    )}
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Vendors */}
        {vendorResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Store className="w-5 h-5 text-green-600" />
              <h2 className="text-xl font-semibold text-navy">Vendors ({vendorResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {vendorResults.map((vendor) => (
                <Link key={vendor.slug} href={`/vendors/${vendor.slug}`}>
                  <Card className="p-4 hover:shadow-md transition-shadow h-full">
                    <h3 className="font-medium text-navy">{vendor.businessName}</h3>
                    {vendor.vendorType && (
                      <p className="text-sm text-gray-500 mt-1">{vendor.vendorType}</p>
                    )}
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
