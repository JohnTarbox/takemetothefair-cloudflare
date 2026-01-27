"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutGrid, Table, Calendar, MapPin, ExternalLink, Download } from "lucide-react";
import { EventCard } from "./event-card";
import { SortableHeader, SortConfig, sortData, getNextSortDirection } from "@/components/ui/sortable-table";
import { formatDateRange } from "@/lib/utils";
import type { events, venues, promoters } from "@/lib/db/schema";

type Event = typeof events.$inferSelect;
type Venue = typeof venues.$inferSelect;
type Promoter = typeof promoters.$inferSelect;

type VendorSummary = {
  id: string;
  businessName: string;
  slug: string;
  logoUrl: string | null;
  vendorType: string | null;
};

type EventWithRelations = Event & {
  venue: Venue;
  promoter: Promoter;
  vendors?: VendorSummary[];
};

interface EventsViewProps {
  events: EventWithRelations[];
  emptyMessage?: string;
}

export function EventsView({
  events,
  emptyMessage = "No events found",
}: EventsViewProps) {
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "startDate",
    direction: "asc",
  });

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const downloadCSV = () => {
    // Get current URL search params (preserves filters) but remove pagination
    const currentParams = new URLSearchParams(window.location.search);
    currentParams.delete("page"); // Remove pagination for full export

    // Navigate to the export API endpoint with current filters
    const exportUrl = `/api/events/export?${currentParams.toString()}`;
    window.location.href = exportUrl;
  };

  const sortedEvents = sortData(events, sortConfig, {
    name: (e) => e.name.toLowerCase(),
    venue: (e) => e.venue?.name?.toLowerCase() || "",
    city: (e) => e.venue?.city?.toLowerCase() || "",
    state: (e) => e.venue?.state || "",
    // Put null dates at the end by using Infinity for asc sort
    startDate: (e) => e.startDate ? new Date(e.startDate).getTime() : Infinity,
    endDate: (e) => e.endDate ? new Date(e.endDate).getTime() : Infinity,
  });

  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      {/* View Toggle and Download */}
      <div className="flex justify-end items-center gap-3 mb-4">
        {viewMode === "table" && (
          <button
            onClick={downloadCSV}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 border border-gray-200 bg-white transition-colors"
          >
            <Download className="w-4 h-4" />
            Download CSV
          </button>
        )}
        <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-white">
          <button
            onClick={() => setViewMode("cards")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "cards"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            Cards
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "table"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <Table className="w-4 h-4" />
            Table
          </button>
        </div>
      </div>

      {/* Cards View */}
      {viewMode === "cards" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortedEvents.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === "table" && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
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
                    column="city"
                    label="City"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="state"
                    label="State"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    className="w-20"
                  />
                  <SortableHeader
                    column="startDate"
                    label="Dates"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-600 w-24">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedEvents.map((event) => (
                  <tr key={event.id} className="hover:bg-gray-50">
                    <td className="py-3 px-4">
                      <Link
                        href={`/events/${event.slug}`}
                        className="font-medium text-gray-900 hover:text-blue-600"
                      >
                        {event.name}
                      </Link>
                      {event.featured && (
                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                          Featured
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">
                      {event.venue?.name || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">
                      {event.venue?.city || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">
                      {event.venue?.state || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Calendar className="w-4 h-4 text-gray-400" />
                        {formatDateRange(event.startDate, event.endDate)}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/events/${event.slug}`}
                          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                        >
                          View
                        </Link>
                        {event.ticketUrl && (
                          <a
                            href={event.ticketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-400 hover:text-gray-600"
                            title="Event Website"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
