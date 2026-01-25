import Link from "next/link";
import { Search, Calendar, MapPin, Users, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EventList } from "@/components/events/event-list";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters } from "@/lib/db/schema";
import { eq, and, gte } from "drizzle-orm";

export const runtime = "edge";

async function getFeaturedEvents() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(
        and(
          eq(events.status, "APPROVED"),
          eq(events.featured, true),
          gte(events.endDate, new Date())
        )
      )
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
      .where(
        and(
          eq(events.status, "APPROVED"),
          gte(events.endDate, new Date())
        )
      )
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

export default async function HomePage() {
  const [featuredEvents, upcomingEvents] = await Promise.all([
    getFeaturedEvents(),
    getUpcomingEvents(),
  ]);

  return (
    <div>
      {/* Hero Section */}
      <section className="bg-gradient-to-br from-blue-600 to-blue-800 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 md:py-28">
          <div className="text-center max-w-3xl mx-auto">
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight">
              Discover Local Fairs & Events
            </h1>
            <p className="mt-6 text-lg md:text-xl text-blue-100">
              Find the best fairs, festivals, and community events in your area.
              Connect with vendors and never miss an experience.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/events">
                <Button
                  size="lg"
                  className="w-full sm:w-auto bg-white text-blue-600 hover:bg-blue-50"
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
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 bg-gray-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center p-6">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mx-auto">
                <Calendar className="w-6 h-6 text-blue-600" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">
                Find Events
              </h3>
              <p className="mt-2 text-gray-600">
                Browse upcoming fairs, festivals, and markets by date, location,
                or category.
              </p>
            </div>
            <div className="text-center p-6">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mx-auto">
                <MapPin className="w-6 h-6 text-blue-600" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">
                Explore Venues
              </h3>
              <p className="mt-2 text-gray-600">
                Discover amazing venues and fairgrounds hosting events in your
                region.
              </p>
            </div>
            <div className="text-center p-6">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mx-auto">
                <Users className="w-6 h-6 text-blue-600" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">
                Connect with Vendors
              </h3>
              <p className="mt-2 text-gray-600">
                Meet local artisans, food vendors, and businesses participating
                in events.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Events */}
      {featuredEvents.length > 0 && (
        <section className="py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                Featured Events
              </h2>
              <Link
                href="/events?featured=true"
                className="text-blue-600 hover:text-blue-700 font-medium flex items-center"
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
            <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
              Upcoming Events
            </h2>
            <Link
              href="/events"
              className="text-blue-600 hover:text-blue-700 font-medium flex items-center"
            >
              View All <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </div>
          <EventList
            events={upcomingEvents}
            emptyMessage="No upcoming events. Check back soon!"
          />
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 bg-blue-600">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-white">
            Ready to Share Your Event?
          </h2>
          <p className="mt-4 text-lg text-blue-100 max-w-2xl mx-auto">
            Whether you&apos;re a promoter organizing fairs or a vendor looking
            to participate, we&apos;ve got you covered.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/register?role=promoter">
              <Button
                size="lg"
                className="w-full sm:w-auto bg-white text-blue-600 hover:bg-blue-50"
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
    </div>
  );
}
