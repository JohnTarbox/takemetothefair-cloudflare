"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, MapPin, Search, X, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";

interface Venue {
  id: string;
  name: string;
  slug: string;
  city: string;
  state: string;
  status: string;
  capacity: number | null;
  latitude: number | null;
  googlePlaceId: string | null;
  _count: { events: number };
}

interface BackfillPreview {
  venueId: string;
  venueName: string;
  venueCity: string;
  venueState: string;
  googleName: string | null;
  googlePlaceId: string | null;
  googleRating: number | null;
  googleAddress: string | null;
  photoUrl: string | null;
}

export default function AdminVenuesPage() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [batchGeocoding, setBatchGeocoding] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [backfillingGoogle, setBackfillingGoogle] = useState(false);
  const [googleBackfillResult, setGoogleBackfillResult] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [backfillPreview, setBackfillPreview] = useState<BackfillPreview[]>([]);
  const [selectedVenueIds, setSelectedVenueIds] = useState<Set<string>>(new Set());
  const [filterMissingGoogle, setFilterMissingGoogle] = useState(false);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "name",
    direction: "asc",
  });

  useEffect(() => {
    fetchVenues();
  }, []);

  const fetchVenues = async () => {
    try {
      const res = await fetch("/api/admin/venues");
      const data = (await res.json()) as Venue[];
      setVenues(data);
    } catch (error) {
      console.error("Failed to fetch venues:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    // Include the venue name in the confirm so the operator can
    // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
    if (!confirm(`Delete venue "${name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/admin/venues/${id}`, { method: "DELETE" });
      if (res.ok) {
        setVenues(venues.filter((v) => v.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete venue:", error);
    }
  };

  const missingCoordCount = venues.filter((v) => v.latitude == null).length;
  const missingGoogleCount = venues.filter((v) => v.googlePlaceId == null).length;

  const handleGooglePreview = async () => {
    setPreviewLoading(true);
    setGoogleBackfillResult(null);
    try {
      const res = await fetch("/api/admin/venues/google-backfill/preview", { method: "POST" });
      const data = (await res.json()) as BackfillPreview[];
      if (data.length === 0) {
        setGoogleBackfillResult("No Google matches found for any venues.");
        return;
      }
      setBackfillPreview(data);
      setSelectedVenueIds(new Set(data.map((d) => d.venueId)));
    } catch {
      setGoogleBackfillResult("Google backfill preview failed");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApplySelected = async () => {
    if (selectedVenueIds.size === 0) return;
    setBackfillingGoogle(true);
    setGoogleBackfillResult(null);
    try {
      const res = await fetch("/api/admin/venues/google-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueIds: Array.from(selectedVenueIds) }),
      });
      const data = (await res.json()) as {
        success: number;
        failed: number;
        skipped: number;
        total: number;
      };
      setGoogleBackfillResult(
        `Google backfill: ${data.success} updated, ${data.skipped} skipped, ${data.failed} failed (${data.total} total)`
      );
      setBackfillPreview([]);
      setSelectedVenueIds(new Set());
      fetchVenues();
    } catch {
      setGoogleBackfillResult("Google backfill failed");
    } finally {
      setBackfillingGoogle(false);
    }
  };

  const toggleVenueSelection = (venueId: string) => {
    setSelectedVenueIds((prev) => {
      const next = new Set(prev);
      if (next.has(venueId)) next.delete(venueId);
      else next.add(venueId);
      return next;
    });
  };

  const toggleAllSelection = () => {
    if (selectedVenueIds.size === backfillPreview.length) {
      setSelectedVenueIds(new Set());
    } else {
      setSelectedVenueIds(new Set(backfillPreview.map((d) => d.venueId)));
    }
  };

  const handleBatchGeocode = async () => {
    setBatchGeocoding(true);
    setBatchResult(null);
    try {
      const res = await fetch("/api/admin/venues/geocode-batch", { method: "POST" });
      const data = (await res.json()) as { success: number; failed: number; total: number };
      setBatchResult(`Geocoded ${data.success} of ${data.total} venues (${data.failed} failed)`);
      fetchVenues();
    } catch {
      setBatchResult("Batch geocode failed");
    } finally {
      setBatchGeocoding(false);
    }
  };

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const filteredVenues = filterMissingGoogle
    ? venues.filter((v) => v.googlePlaceId == null)
    : venues;

  const sortedVenues = sortData(filteredVenues, sortConfig, {
    name: (v) => v.name,
    location: (v) => `${v.city}, ${v.state}`,
    capacity: (v) => v.capacity || 0,
    events: (v) => v._count.events,
    status: (v) => v.status,
  });

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-muted rounded w-1/4"></div>
        <div className="h-64 bg-muted rounded"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-foreground">Manage Venues</h1>
        <div className="flex items-center gap-2">
          {missingGoogleCount > 0 && (
            <Button
              variant={filterMissingGoogle ? "primary" : "outline"}
              onClick={() => setFilterMissingGoogle(!filterMissingGoogle)}
            >
              <Filter className="w-4 h-4 mr-2" />
              {filterMissingGoogle
                ? `Missing Google (${missingGoogleCount})`
                : `Filter Missing Google (${missingGoogleCount})`}
            </Button>
          )}
          {missingGoogleCount > 0 && (
            <Button
              variant="outline"
              disabled={previewLoading || backfillingGoogle}
              onClick={handleGooglePreview}
            >
              <Search className="w-4 h-4 mr-2" />
              {previewLoading ? "Looking up..." : `Backfill Google Data (${missingGoogleCount})`}
            </Button>
          )}
          {missingCoordCount > 0 && (
            <Button variant="outline" disabled={batchGeocoding} onClick={handleBatchGeocode}>
              <MapPin className="w-4 h-4 mr-2" />
              {batchGeocoding ? "Geocoding..." : `Geocode Missing (${missingCoordCount})`}
            </Button>
          )}
          <Link href="/admin/venues/new">
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Add Venue
            </Button>
          </Link>
        </div>
      </div>

      {batchResult && (
        <div className="mb-4 p-3 bg-info-soft text-navy rounded-md text-sm">{batchResult}</div>
      )}

      {googleBackfillResult && (
        <div className="mb-4 p-3 bg-info-soft text-navy rounded-md text-sm">
          {googleBackfillResult}
        </div>
      )}

      {backfillPreview.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">
                Google Backfill Preview — {backfillPreview.length} matches found
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBackfillPreview([]);
                  setSelectedVenueIds(new Set());
                }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 px-3 text-left">
                      <input
                        type="checkbox"
                        checked={selectedVenueIds.size === backfillPreview.length}
                        onChange={toggleAllSelection}
                      />
                    </th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">Venue</th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">
                      City/State
                    </th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">
                      Google Match
                    </th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">
                      Google Address
                    </th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">
                      Rating
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {backfillPreview.map((p) => (
                    <tr key={p.venueId} className="border-b border-border">
                      <td className="py-2 px-3">
                        <input
                          type="checkbox"
                          checked={selectedVenueIds.has(p.venueId)}
                          onChange={() => toggleVenueSelection(p.venueId)}
                        />
                      </td>
                      <td className="py-2 px-3 font-medium text-foreground">{p.venueName}</td>
                      <td className="py-2 px-3 text-muted-foreground">
                        {p.venueCity}, {p.venueState}
                      </td>
                      <td className="py-2 px-3 text-muted-foreground">{p.googleName || "-"}</td>
                      <td className="py-2 px-3 text-muted-foreground">{p.googleAddress || "-"}</td>
                      <td className="py-2 px-3 text-muted-foreground">{p.googleRating ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-3 mt-4">
              <Button
                disabled={selectedVenueIds.size === 0 || backfillingGoogle}
                onClick={handleApplySelected}
              >
                {backfillingGoogle ? "Applying..." : `Apply Selected (${selectedVenueIds.size})`}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setBackfillPreview([]);
                  setSelectedVenueIds(new Set());
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">
            {filterMissingGoogle
              ? `${filteredVenues.length} of ${venues.length} venues missing Google Place ID`
              : `${venues.length} venues total`}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <SortableHeader
                    column="name"
                    label="Venue"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="location"
                    label="Location"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="capacity"
                    label="Capacity"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="events"
                    label="Events"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedVenues.map((venue) => (
                  <tr key={venue.id} className="border-b border-border">
                    <td className="py-3 px-4 font-medium text-foreground">{venue.name}</td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {venue.city}, {venue.state}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {venue.capacity?.toLocaleString() || "-"}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">{venue._count.events}</td>
                    <td className="py-3 px-4">
                      <Badge variant={venue.status === "ACTIVE" ? "success" : "default"}>
                        {venue.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        {/* IconLink + IconButton primitives — type-enforced
                            aria-label, ≥40px hit area, single interactive
                            element (no nested Link>Button). UX-R2, 2026-06-01. */}
                        <IconLink
                          href={`/venues/${venue.slug}`}
                          aria-label={`View ${venue.name}`}
                          icon={<Eye />}
                        />
                        <IconLink
                          href={`/admin/venues/${venue.id}/edit`}
                          aria-label={`Edit ${venue.name}`}
                          icon={<Pencil />}
                        />
                        <IconButton
                          variant="danger"
                          onClick={() => handleDelete(venue.id, venue.name)}
                          aria-label={`Delete ${venue.name}`}
                          icon={<Trash2 />}
                        />
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
