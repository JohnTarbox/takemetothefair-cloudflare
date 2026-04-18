"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, Store, RefreshCw, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";

export const runtime = "edge";

interface Event {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: string;
  endDate: string;
  featured: boolean;
  venue: { name: string } | null;
  promoter: { companyName: string } | null;
  blogPostCount: number;
}

const statusColors: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "default",
  PENDING: "warning",
  TENTATIVE: "info",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "default",
};

export default function AdminEventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "startDate",
    direction: "asc",
  });
  const [rescrapingId, setRescrapingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [venueFilter, setVenueFilter] = useState<string>("all");

  useEffect(() => {
    fetchEvents();
  }, []);

  const fetchEvents = async () => {
    try {
      const res = await fetch("/api/admin/events");
      const data = (await res.json()) as Event[];
      setEvents(data);
    } catch (error) {
      console.error("Failed to fetch events:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this event?")) return;

    try {
      const res = await fetch(`/api/admin/events/${id}`, { method: "DELETE" });
      if (res.ok) {
        setEvents(events.filter((e) => e.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete event:", error);
    }
  };

  const handleRescrape = async (id: string) => {
    setRescrapingId(id);
    try {
      const res = await fetch("/api/admin/import/rescrape-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_ids: [id] }),
      });
      const data = (await res.json()) as {
        details?: { status: string; fieldsUpdated?: string[] }[];
      };
      const detail = data.details?.[0];
      if (detail?.status === "updated") {
        alert(`Updated: ${detail.fieldsUpdated?.join(", ")}`);
      } else if (detail?.status === "skipped") {
        alert("No changes found — data is already up to date.");
      } else if (detail?.status === "no_scraper") {
        alert("No scraper available for this event's source.");
      } else if (detail?.status === "no_source") {
        alert("This event has no source URL to re-scrape.");
      } else {
        alert(`Re-scrape result: ${detail?.status || "unknown"}`);
      }
    } catch (error) {
      console.error("Failed to re-scrape:", error);
      alert("Re-scrape failed. Check console for details.");
    } finally {
      setRescrapingId(null);
    }
  };

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const filteredEvents = events.filter((e) => {
    if (statusFilter !== "all" && e.status !== statusFilter) return false;
    if (venueFilter === "no-venue" && e.venue !== null) return false;
    if (venueFilter === "has-venue" && e.venue === null) return false;
    return true;
  });

  const sortedEvents = sortData(filteredEvents, sortConfig, {
    name: (e) => e.name.toLowerCase(),
    venue: (e) => e.venue?.name?.toLowerCase() || "",
    promoter: (e) => e.promoter?.companyName?.toLowerCase() || "",
    startDate: (e) => new Date(e.startDate).getTime(),
    status: (e) => e.status,
    blogPostCount: (e) => e.blogPostCount ?? 0,
  });

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/4"></div>
        <div className="h-64 bg-gray-200 rounded"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Manage Events</h1>
        <Link href="/admin/events/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Event
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 bg-white"
        >
          <option value="all">All Statuses</option>
          <option value="APPROVED">Approved</option>
          <option value="TENTATIVE">Tentative</option>
          <option value="PENDING">Pending</option>
          <option value="DRAFT">Draft</option>
          <option value="REJECTED">Rejected</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select
          value={venueFilter}
          onChange={(e) => setVenueFilter(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 bg-white"
        >
          <option value="all">All Venues</option>
          <option value="no-venue">No Venue</option>
          <option value="has-venue">Has Venue</option>
        </select>
        {(statusFilter !== "all" || venueFilter !== "all") && (
          <button
            onClick={() => {
              setStatusFilter("all");
              setVenueFilter("all");
            }}
            className="text-sm text-royal hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">
            {filteredEvents.length === events.length
              ? `${events.length} events total`
              : `${filteredEvents.length} of ${events.length} events`}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <SortableHeader
                    column="name"
                    label="Event"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="venue"
                    label="Venue"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="promoter"
                    label="Promoter"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="startDate"
                    label="Date"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="blogPostCount"
                    label="Blog"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedEvents.map((event) => (
                  <tr key={event.id} className="border-b border-gray-100">
                    <td className="py-3 px-4">
                      <div>
                        <p className="font-medium text-gray-900">{event.name}</p>
                        {event.featured && (
                          <Badge variant="warning" className="mt-1">
                            Featured
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {event.venue?.name ? (
                        <span className="text-gray-600">{event.venue.name}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-600">
                          <MapPin className="w-3.5 h-3.5" />
                          No venue
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {event.promoter?.companyName || "-"}
                    </td>
                    <td className="py-3 px-4 text-gray-600">{formatDate(event.startDate)}</td>
                    <td className="py-3 px-4">
                      <Badge variant={statusColors[event.status]}>{event.status}</Badge>
                    </td>
                    <td className="py-3 px-4">
                      {event.blogPostCount > 0 ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-light text-amber-dark">
                          {event.blogPostCount}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">0</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/events/${event.slug}`}>
                          <Button variant="ghost" size="sm" aria-label={`View ${event.name}`}>
                            <Eye className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Link href={`/admin/events/${event.id}/vendors`}>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Manage vendors for ${event.name}`}
                          >
                            <Store className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Link href={`/admin/events/${event.id}/edit`}>
                          <Button variant="ghost" size="sm" aria-label={`Edit ${event.name}`}>
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRescrape(event.id)}
                          disabled={rescrapingId === event.id}
                          aria-label={`Re-scrape ${event.name}`}
                        >
                          <RefreshCw
                            className={`w-4 h-4 ${rescrapingId === event.id ? "animate-spin text-blue-500" : ""}`}
                            aria-hidden="true"
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(event.id)}
                          aria-label={`Delete ${event.name}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
