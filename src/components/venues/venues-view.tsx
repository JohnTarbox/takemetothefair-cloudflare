"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutGrid, Table, Users, ExternalLink, Download } from "lucide-react";
import { VenueCard } from "./venue-card";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";
import { parseJsonArray } from "@/types";

interface VenueWithCount {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  capacity: number | null;
  amenities: string | null;
  imageUrl: string | null;
  website?: string | null;
  _count: {
    events: number;
  };
}

interface VenuesViewProps {
  venues: VenueWithCount[];
  emptyMessage?: string;
}

export function VenuesView({ venues, emptyMessage = "No venues found" }: VenuesViewProps) {
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "name",
    direction: "asc",
  });

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const downloadCSV = () => {
    // Get current URL search params (preserves filters)
    const currentParams = new URLSearchParams(window.location.search);

    // Navigate to the export API endpoint with current filters
    const exportUrl = `/api/venues/export?${currentParams.toString()}`;
    window.location.href = exportUrl;
  };

  const sortedVenues = sortData(venues, sortConfig, {
    name: (v) => v.name.toLowerCase(),
    city: (v) => v.city?.toLowerCase() || "",
    state: (v) => v.state || "",
    capacity: (v) => v.capacity || 0,
    events: (v) => v._count.events,
  });

  if (venues.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      {/* View Toggle and Download */}
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-muted-foreground">
          {venues.length} venue{venues.length !== 1 ? "s" : ""} found
        </p>
        <div className="flex items-center gap-3">
          {viewMode === "table" && (
            <button
              onClick={downloadCSV}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted border border-border bg-card transition-colors"
              aria-label="Download venues as CSV"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              Download CSV
            </button>
          )}
          <div
            className="inline-flex rounded-lg border border-border p-1 bg-card"
            role="group"
            aria-label="View mode"
          >
            <button
              onClick={() => setViewMode("cards")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === "cards"
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              aria-pressed={viewMode === "cards"}
              aria-label="Card view"
            >
              <LayoutGrid className="w-4 h-4" aria-hidden="true" />
              Cards
            </button>
            <button
              onClick={() => setViewMode("table")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === "table"
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              aria-pressed={viewMode === "table"}
              aria-label="Table view"
            >
              <Table className="w-4 h-4" aria-hidden="true" />
              Table
            </button>
          </div>
        </div>
      </div>

      {/* Cards View */}
      {viewMode === "cards" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {sortedVenues.map((venue) => (
            <VenueCard key={venue.id} venue={venue} />
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === "table" && (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <SortableHeader
                    column="name"
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
                    column="capacity"
                    label="Capacity"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    className="w-28"
                  />
                  <SortableHeader
                    column="events"
                    label="Events"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    className="w-24"
                  />
                  <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground w-32">
                    Amenities
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground w-24">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedVenues.map((venue) => {
                  const amenities = parseJsonArray(venue.amenities);
                  return (
                    <tr key={venue.id} className="hover:bg-muted">
                      <td className="py-3 px-4">
                        <Link
                          href={`/venues/${venue.slug}`}
                          className="font-medium text-foreground hover:text-navy"
                        >
                          {venue.name}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">
                        {venue.city || "-"}
                      </td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">
                        {venue.state || "-"}
                      </td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Users className="w-4 h-4 text-muted-foreground" />
                          {venue.capacity?.toLocaleString() || "-"}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">
                        {venue._count.events}
                      </td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">
                        {amenities.length > 0 ? (
                          <span className="text-muted-foreground">
                            {amenities.slice(0, 2).join(", ")}
                            {amenities.length > 2 && ` +${amenities.length - 2}`}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/venues/${venue.slug}`}
                            className="text-royal hover:text-navy-dark text-sm font-medium"
                          >
                            View
                          </Link>
                          {venue.website && (
                            <a
                              href={venue.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-muted-foreground"
                              title="Venue Website"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
