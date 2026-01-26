"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Calendar, Search, Grid, List, ArrowLeft, MapPin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRange } from "@/lib/utils";
import { AddToCalendar } from "@/components/events/AddToCalendar";

export const runtime = "edge";

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string;
  endDate: string;
  imageUrl: string | null;
  categories: string[];
  venue: {
    name: string;
    city: string;
    state: string;
    address: string | null;
    zip: string | null;
  };
}

interface VendorInfo {
  id: string;
  businessName: string;
  slug: string;
}

export default function VendorEventsPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [events, setEvents] = useState<Event[]>([]);
  const [vendorInfo, setVendorInfo] = useState<VendorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [timeFilter, setTimeFilter] = useState<"all" | "upcoming" | "past">("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  useEffect(() => {
    fetchEvents();
  }, [slug]);

  const fetchEvents = async () => {
    try {
      const res = await fetch(`/api/vendors/${slug}/events`);
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events || []);
        setVendorInfo(data.vendor || null);
      }
    } catch (error) {
      console.error("Failed to fetch events:", error);
    } finally {
      setLoading(false);
    }
  };

  // Filter events
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
    const aEnd = new Date(a.endDate);
    const bEnd = new Date(b.endDate);
    const aUpcoming = aEnd >= now;
    const bUpcoming = bEnd >= now;

    if (aUpcoming && !bUpcoming) return -1;
    if (!aUpcoming && bUpcoming) return 1;

    if (aUpcoming) {
      return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    } else {
      return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
    }
  });

  const upcomingCount = events.filter((e) => new Date(e.endDate) >= now).length;
  const pastCount = events.filter((e) => new Date(e.endDate) < now).length;

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-12 bg-gray-200 rounded"></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-64 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <Link
          href={`/vendors/${slug}`}
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Vendor
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">
          Events for {vendorInfo?.businessName || "Vendor"}
        </h1>
        <p className="mt-2 text-gray-600">
          {upcomingCount} upcoming, {pastCount} past event{pastCount !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search events..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value as "all" | "upcoming" | "past")}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="all">All Events ({events.length})</option>
          <option value="upcoming">Upcoming ({upcomingCount})</option>
          <option value="past">Past ({pastCount})</option>
        </select>
        <div className="flex gap-1 border border-gray-300 rounded-lg p-1">
          <button
            onClick={() => setViewMode("grid")}
            className={`p-2 rounded ${
              viewMode === "grid"
                ? "bg-blue-100 text-blue-600"
                : "text-gray-600 hover:bg-gray-100"
            }`}
            aria-label="Grid view"
          >
            <Grid className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`p-2 rounded ${
              viewMode === "list"
                ? "bg-blue-100 text-blue-600"
                : "text-gray-600 hover:bg-gray-100"
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
            <Calendar className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900">
              No events found
            </h3>
            <p className="mt-1 text-gray-500">
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
                <Card className={`h-full hover:shadow-lg transition-shadow ${isPast ? "opacity-75" : ""}`}>
                  <div className="aspect-video relative bg-gray-100">
                    {event.imageUrl ? (
                      <img
                        src={event.imageUrl}
                        alt={event.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400">
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
                    <h3 className="font-semibold text-gray-900 line-clamp-2">
                      {event.name}
                    </h3>
                    <div className="mt-2 space-y-1 text-sm text-gray-600">
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
                    <div className="w-24 h-24 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {event.imageUrl ? (
                        <img
                          src={event.imageUrl}
                          alt={event.name}
                          className="w-24 h-24 object-cover"
                        />
                      ) : (
                        <Calendar className="w-8 h-8 text-gray-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-gray-900">
                          {event.name}
                        </h3>
                        {isPast && (
                          <Badge variant="default">Past</Badge>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-4 text-sm text-gray-600">
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
                          />
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-sm text-gray-500">
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
