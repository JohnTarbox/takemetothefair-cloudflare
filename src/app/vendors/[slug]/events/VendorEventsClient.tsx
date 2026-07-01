"use client";

import { useState } from "react";
import Link from "next/link";
import { Calendar, Search, Grid, List, ArrowLeft, MapPin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRange } from "@/lib/utils";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import type { VendorEventItem } from "@/lib/vendors/vendor-events";

interface VendorInfo {
  id: string;
  businessName: string;
  displayName?: string | null;
  slug: string;
}

/**
 * OPE-40 — interactive vendor-events view. Receives events as PROPS (loaded
 * server-side), so the event <Link>s are present in the SSR HTML and are
 * crawlable — unlike the previous client-only useEffect fetch. Search / time
 * filter / grid-vs-list stay client-side.
 */
export function VendorEventsClient({
  vendor,
  events,
  slug,
}: {
  vendor: VendorInfo | null;
  events: VendorEventItem[];
  slug: string;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [timeFilter, setTimeFilter] = useState<"all" | "upcoming" | "past">("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const now = new Date();
  const filteredEvents = events.filter((event) => {
    const matchesSearch =
      event.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.venue.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.venue.city.toLowerCase().includes(searchQuery.toLowerCase());

    const eventEndDate = new Date(event.endDate);
    const matchesTime =
      timeFilter === "all" ||
      (timeFilter === "upcoming" && eventEndDate >= now) ||
      (timeFilter === "past" && eventEndDate < now);

    return matchesSearch && matchesTime;
  });

  // Sort: upcoming first (by start date), then past (by start date descending)
  const sortedEvents = [...filteredEvents].sort((a, b) => {
    const aUpcoming = new Date(a.endDate) >= now;
    const bUpcoming = new Date(b.endDate) >= now;
    if (aUpcoming && !bUpcoming) return -1;
    if (!aUpcoming && bUpcoming) return 1;
    return aUpcoming
      ? new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
      : new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
  });

  const upcomingCount = events.filter((e) => new Date(e.endDate) >= now).length;
  const pastCount = events.filter((e) => new Date(e.endDate) < now).length;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      {vendor && events.length > 0 && (
        <ItemListSchema
          name={`${vendor.displayName ?? vendor.businessName}'s Events`}
          description={`Events featuring ${vendor.displayName ?? vendor.businessName}`}
          items={events.map((event) => ({
            name: event.name,
            url: `https://meetmeatthefair.com/events/${event.slug}`,
            image: event.imageUrl,
          }))}
        />
      )}
      {/* Header */}
      <div className="mb-8">
        <Link
          href={`/vendors/${slug}`}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-navy mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Vendor
        </Link>
        <h1 className="text-3xl font-bold text-foreground">
          Events for {vendor?.displayName ?? vendor?.businessName ?? "Vendor"}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {upcomingCount} upcoming, {pastCount} past event{pastCount !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search events..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-royal focus:border-royal"
          />
        </div>
        <select
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value as "all" | "upcoming" | "past")}
          className="px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-royal focus:border-royal"
        >
          <option value="all">All Events ({events.length})</option>
          <option value="upcoming">Upcoming ({upcomingCount})</option>
          <option value="past">Past ({pastCount})</option>
        </select>
        <div className="flex gap-1 border border-border rounded-lg p-1">
          <button
            onClick={() => setViewMode("grid")}
            className={`p-2 rounded ${
              viewMode === "grid"
                ? "bg-amber-light text-amber-bg-fg"
                : "text-muted-foreground hover:bg-muted"
            }`}
            aria-label="Grid view"
          >
            <Grid className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`p-2 rounded ${
              viewMode === "list"
                ? "bg-amber-light text-amber-bg-fg"
                : "text-muted-foreground hover:bg-muted"
            }`}
            aria-label="List view"
          >
            <List className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Results */}
      {sortedEvents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium text-foreground">No events found</h3>
            <p className="mt-1 text-muted-foreground">
              Try adjusting your search or filter criteria
            </p>
          </CardContent>
        </Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortedEvents.map((event) => {
            const isPast = new Date(event.endDate) < now;
            return (
              <Link key={event.id} href={`/events/${event.slug}`}>
                <Card
                  className={`h-full hover:shadow-lg transition-shadow ${isPast ? "opacity-75" : ""}`}
                >
                  <div className="aspect-video relative bg-muted">
                    {event.imageUrl ? (
                      <img
                        src={event.imageUrl}
                        alt={event.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                        <Calendar className="w-12 h-12" />
                      </div>
                    )}
                    {isPast && (
                      <Badge variant="default" className="absolute top-3 left-3">
                        Past Event
                      </Badge>
                    )}
                  </div>
                  <CardContent className="p-4">
                    <h3 className="font-semibold text-foreground line-clamp-2">{event.name}</h3>
                    <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-4 h-4" />
                          <span>{formatDateRange(event.startDate, event.endDate)}</span>
                        </div>
                        {!isPast && (
                          <AddToCalendar
                            title={event.name}
                            description={event.description || undefined}
                            location={`${event.venue.name}, ${event.venue.address || ""}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip || ""}`}
                            startDate={event.startDate}
                            endDate={event.endDate}
                            url={`https://meetmeatthefair.com/events/${event.slug}`}
                            variant="icon"
                            eventSlug={event.slug}
                            venueTimezone={event.venue.timezone}
                          />
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <MapPin className="w-4 h-4" />
                        <span className="truncate">
                          {event.venue.name}, {event.venue.city}, {event.venue.state}
                        </span>
                      </div>
                    </div>
                    {event.categories && event.categories.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {event.categories.slice(0, 2).map((cat) => (
                          <Badge key={cat} variant="default">
                            {cat}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          {sortedEvents.map((event) => {
            const isPast = new Date(event.endDate) < now;
            return (
              <Link key={event.id} href={`/events/${event.slug}`}>
                <Card className={`hover:shadow-md transition-shadow ${isPast ? "opacity-75" : ""}`}>
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="w-24 h-24 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {event.imageUrl ? (
                        <img
                          src={event.imageUrl}
                          alt={event.name}
                          className="w-24 h-24 object-cover"
                        />
                      ) : (
                        <Calendar className="w-8 h-8 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-foreground">{event.name}</h3>
                        {isPast && <Badge variant="default">Past</Badge>}
                      </div>
                      <div className="mt-1 flex items-center gap-4 text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-4 h-4" />
                          <span>{formatDateRange(event.startDate, event.endDate)}</span>
                        </div>
                        {!isPast && (
                          <AddToCalendar
                            title={event.name}
                            description={event.description || undefined}
                            location={`${event.venue.name}, ${event.venue.address || ""}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip || ""}`}
                            startDate={event.startDate}
                            endDate={event.endDate}
                            url={`https://meetmeatthefair.com/events/${event.slug}`}
                            variant="icon"
                            eventSlug={event.slug}
                            venueTimezone={event.venue.timezone}
                          />
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                        <MapPin className="w-4 h-4" />
                        <span>
                          {event.venue.name}, {event.venue.city}, {event.venue.state}
                        </span>
                      </div>
                      {event.categories && event.categories.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {event.categories.slice(0, 3).map((cat) => (
                            <Badge key={cat} variant="default">
                              {cat}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
