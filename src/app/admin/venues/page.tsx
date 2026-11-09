"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, MapPin, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AdminPagedTable,
  type AdminColumn,
  type AdminFilter,
} from "@/components/admin/admin-paged-table";
import type { AdminVenueRow } from "@/lib/admin-list/lists";

const FILTERS: AdminFilter[] = [
  {
    param: "status",
    allLabel: "All statuses",
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "INACTIVE", label: "Inactive" },
      { value: "FORMER", label: "Former" },
    ],
  },
  {
    param: "google",
    allLabel: "Google: any",
    options: [{ value: "missing", label: "Missing Google Place ID" }],
  },
  {
    param: "coords",
    allLabel: "Coordinates: any",
    options: [{ value: "missing", label: "Missing coordinates" }],
  },
];

async function deleteVenue(venue: AdminVenueRow, reload: () => void) {
  // Include the venue name in the confirm so the operator can
  // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
  if (!confirm(`Delete venue "${venue.name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/venues/${venue.id}`, { method: "DELETE" });
    if (res.ok) reload();
  } catch (error) {
    console.error("Failed to delete venue:", error);
  }
}

const COLUMNS: AdminColumn<AdminVenueRow>[] = [
  {
    key: "name",
    label: "Venue",
    sortKey: "name",
    cell: (v) => <span className="font-medium text-foreground">{v.name}</span>,
  },
  {
    key: "location",
    label: "Location",
    sortKey: "location",
    cell: (v) => (
      <span className="text-muted-foreground">
        {v.city}, {v.state}
      </span>
    ),
  },
  {
    key: "capacity",
    label: "Capacity",
    sortKey: "capacity",
    cell: (v) => (
      <span className="text-muted-foreground">{v.capacity?.toLocaleString() || "-"}</span>
    ),
  },
  {
    key: "events",
    label: "Events",
    sortKey: "events",
    cell: (v) => <span className="text-muted-foreground">{v.eventCount}</span>,
  },
  {
    key: "status",
    label: "Status",
    sortKey: "status",
    cell: (v) => <Badge variant={v.status === "ACTIVE" ? "success" : "default"}>{v.status}</Badge>,
  },
  {
    key: "actions",
    label: "Actions",
    align: "right",
    cell: (v, { reload }) => (
      <div className="flex items-center justify-end gap-1">
        <IconLink href={`/venues/${v.slug}`} aria-label={`View ${v.name}`} icon={<Eye />} />
        <IconLink
          href={`/admin/venues/${v.id}/edit`}
          aria-label={`Edit ${v.name}`}
          icon={<Pencil />}
        />
        <IconButton
          variant="danger"
          onClick={() => void deleteVenue(v, reload)}
          aria-label={`Delete ${v.name}`}
          icon={<Trash2 />}
        />
      </div>
    ),
  },
];

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
  const [missingCoordCount, setMissingCoordCount] = useState(0);
  const [missingGoogleCount, setMissingGoogleCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [batchGeocoding, setBatchGeocoding] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [backfillingGoogle, setBackfillingGoogle] = useState(false);
  const [googleBackfillResult, setGoogleBackfillResult] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [backfillPreview, setBackfillPreview] = useState<BackfillPreview[]>([]);
  const [selectedVenueIds, setSelectedVenueIds] = useState<Set<string>>(new Set());
  const refreshVenues = () => setRefreshKey((k) => k + 1);

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
      refreshVenues();
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
      refreshVenues();
    } catch {
      setBatchResult("Batch geocode failed");
    } finally {
      setBatchGeocoding(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-foreground">Manage Venues</h1>
        <div className="flex items-center gap-2">
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

      <AdminPagedTable<AdminVenueRow>
        endpoint="/api/admin/venues"
        columns={COLUMNS}
        rowKey={(v) => v.id}
        noun="venue"
        searchPlaceholder="Search venues by name or city…"
        filters={FILTERS}
        defaultSort={{ column: "name", direction: "asc" }}
        refreshKey={refreshKey}
        onData={(data) => {
          setMissingCoordCount(data.stats?.missingCoords ?? 0);
          setMissingGoogleCount(data.stats?.missingGoogle ?? 0);
        }}
      />
    </div>
  );
}
