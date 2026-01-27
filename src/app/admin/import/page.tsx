"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Check,
  Calendar,
  MapPin,
  ExternalLink,
  AlertCircle,
  CheckCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

export const runtime = "edge";

interface PreviewEvent {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  name: string;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  datesConfirmed?: boolean;
  description?: string;
  location?: string;
  imageUrl?: string;
  exists: boolean;
  existingId?: string;
  venue?: {
    name: string;
    streetAddress?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
}

interface Venue {
  id: string;
  name: string;
  city: string;
  state: string;
}

interface Promoter {
  id: string;
  companyName: string;
}

interface ImportedEvent {
  id: string;
  name: string;
  slug: string;
}

export default function ImportEventsPage() {
  const [source, setSource] = useState("mainefairs.net");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [events, setEvents] = useState<PreviewEvent[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set());
  const [venues, setVenues] = useState<Venue[]>([]);
  const [promoters, setPromoters] = useState<Promoter[]>([]);
  const [selectedVenueId, setSelectedVenueId] = useState("");
  const [selectedPromoterId, setSelectedPromoterId] = useState("");
  const [fetchDetails, setFetchDetails] = useState(true);
  const [fetchDetailsOnPreview, setFetchDetailsOnPreview] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [stats, setStats] = useState({ total: 0, newCount: 0, existingCount: 0 });
  const [importedEvents, setImportedEvents] = useState<ImportedEvent[]>([]);
  const [updatedEvents, setUpdatedEvents] = useState<ImportedEvent[]>([]);

  useEffect(() => {
    fetchVenuesAndPromoters();
  }, []);

  const downloadImportResults = () => {
    const rows: string[][] = [["Status", "Name", "URL"]];

    importedEvents.forEach((event) => {
      rows.push(["Imported", event.name, `https://meetmeatthefair.com/events/${event.slug}`]);
    });

    updatedEvents.forEach((event) => {
      rows.push(["Updated", event.name, `https://meetmeatthefair.com/events/${event.slug}`]);
    });

    const csvContent = rows
      .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `import-results-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const fetchVenuesAndPromoters = async () => {
    try {
      const [venuesRes, promotersRes] = await Promise.all([
        fetch("/api/admin/venues"),
        fetch("/api/admin/promoters"),
      ]);
      const venuesData = await venuesRes.json();
      const promotersData = await promotersRes.json();
      setVenues(venuesData);
      setPromoters(promotersData);
    } catch (err) {
      console.error("Failed to fetch venues/promoters:", err);
    }
  };

  const handlePreview = async () => {
    setLoading(true);
    setError("");
    setSuccess("");
    setEvents([]);
    setSelectedEvents(new Set());

    try {
      const params = new URLSearchParams({ source });
      if (fetchDetailsOnPreview) {
        params.set("fetchDetails", "true");
      }
      const res = await fetch(`/api/admin/import?${params.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch events");
      }

      setEvents(data.events || []);
      setStats({
        total: data.total || 0,
        newCount: data.newCount || 0,
        existingCount: data.existingCount || 0,
      });

      // Auto-select new events
      const newEventIds = new Set(
        data.events.filter((e: PreviewEvent) => !e.exists).map((e: PreviewEvent) => e.sourceId)
      );
      setSelectedEvents(newEventIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview events");
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (selectedEvents.size === 0) {
      setError("No events selected");
      return;
    }

    if (!selectedPromoterId) {
      setError("Please select a promoter");
      return;
    }

    setImporting(true);
    setError("");
    setSuccess("");
    setImportedEvents([]);
    setUpdatedEvents([]);

    try {
      const eventsToImport = events.filter((e) => selectedEvents.has(e.sourceId));

      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: eventsToImport,
          venueId: selectedVenueId,
          promoterId: selectedPromoterId,
          fetchDetails,
          updateExisting,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to import events");
      }

      const venuesMsg = data.venuesCreated ? ` ${data.venuesCreated} venues created.` : "";
      setSuccess(`Imported ${data.imported} events. ${data.updated || 0} updated. ${data.skipped} skipped.${venuesMsg} ${data.errors?.length || 0} errors.`);

      // Save the lists of imported and updated events
      setImportedEvents(data.importedEvents || []);
      setUpdatedEvents(data.updatedEvents || []);

      // Refresh the preview
      await handlePreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import events");
    } finally {
      setImporting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/admin/import", {
        method: "PATCH",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to sync events");
      }

      setSuccess(`Synced ${data.synced} events. ${data.unchanged} unchanged. ${data.errors?.length || 0} errors.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync events");
    } finally {
      setSyncing(false);
    }
  };

  const toggleEventSelection = (sourceId: string) => {
    const newSelected = new Set(selectedEvents);
    if (newSelected.has(sourceId)) {
      newSelected.delete(sourceId);
    } else {
      newSelected.add(sourceId);
    }
    setSelectedEvents(newSelected);
  };

  const selectAllNew = () => {
    const newEventIds = new Set(events.filter((e) => !e.exists).map((e) => e.sourceId));
    setSelectedEvents(newEventIds);
  };

  const selectAll = () => {
    const allEventIds = new Set(events.map((e) => e.sourceId));
    setSelectedEvents(allEventIds);
  };

  const deselectAll = () => {
    setSelectedEvents(new Set());
  };

  const formatDate = (dateVal: string | Date | null | undefined) => {
    if (!dateVal) return "TBD";
    try {
      const date = dateVal instanceof Date ? dateVal : new Date(dateVal);
      if (isNaN(date.getTime())) return "TBD";
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return "TBD";
    }
  };

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Admin
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Import Events</h1>
          <p className="text-gray-600 mt-1">
            Import and sync events from external sources
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleSync}
          disabled={syncing}
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Sync All"}
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-3 bg-green-50 text-green-600 rounded-md text-sm flex items-center gap-2">
          <CheckCircle className="w-4 h-4" />
          {success}
        </div>
      )}

      {/* Imported/Updated Events Lists */}
      {(importedEvents.length > 0 || updatedEvents.length > 0) && (
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Import Results</CardTitle>
              <Button variant="outline" size="sm" onClick={downloadImportResults}>
                <Download className="w-4 h-4 mr-2" />
                Download CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {importedEvents.length > 0 && (
                <div>
                  <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                    Imported Events ({importedEvents.length})
                  </h3>
                  <ul className="space-y-2 max-h-64 overflow-y-auto">
                    {importedEvents.map((event) => (
                      <li key={event.id} className="flex items-center justify-between p-2 bg-green-50 rounded-md">
                        <span className="text-sm text-gray-900">{event.name}</span>
                        <Link
                          href={`/events/${event.slug}`}
                          target="_blank"
                          className="text-blue-600 hover:text-blue-800 text-xs flex items-center gap-1"
                        >
                          View <ExternalLink className="w-3 h-3" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {updatedEvents.length > 0 && (
                <div>
                  <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-blue-600" />
                    Updated Events ({updatedEvents.length})
                  </h3>
                  <ul className="space-y-2 max-h-64 overflow-y-auto">
                    {updatedEvents.map((event) => (
                      <li key={event.id} className="flex items-center justify-between p-2 bg-blue-50 rounded-md">
                        <span className="text-sm text-gray-900">{event.name}</span>
                        <Link
                          href={`/events/${event.slug}`}
                          target="_blank"
                          className="text-blue-600 hover:text-blue-800 text-xs flex items-center gap-1"
                        >
                          View <ExternalLink className="w-3 h-3" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Source Selection */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Select Source</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <Label htmlFor="source">Event Source</Label>
                <select
                  id="source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm mt-1"
                >
                  <option value="mainefairs.net">Maine Fairs (mainefairs.net)</option>
                  <option value="mainemade.com">Maine Made Events (mainemade.com)</option>
                  <option value="mainepublic.org">Maine Public Community Calendar (mainepublic.org)</option>
                  <option value="mafa.org">Massachusetts Fairs (mafa.org)</option>
                  <option value="vtnhfairs.org-vt">Vermont Fairs (vtnhfairs.org)</option>
                  <option value="vtnhfairs.org-nh">New Hampshire Fairs (vtnhfairs.org)</option>
                  <option value="newenglandcraftfairs.com">New England Craft Fairs (newenglandcraftfairs.com)</option>
                </select>
              </div>
              <Button onClick={handlePreview} disabled={loading}>
                {loading ? (fetchDetailsOnPreview ? "Fetching details..." : "Loading...") : "Preview Events"}
              </Button>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fetchDetailsOnPreview}
                onChange={(e) => setFetchDetailsOnPreview(e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">
                Fetch event details during preview (slower, but shows dates and venues)
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Preview Results */}
      {events.length > 0 && (
        <>
          {/* Import Settings */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Import Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="venueId">Default Venue (Optional)</Label>
                  <select
                    id="venueId"
                    value={selectedVenueId}
                    onChange={(e) => setSelectedVenueId(e.target.value)}
                    className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm mt-1"
                  >
                    <option value="">No default venue</option>
                    {venues.map((venue) => (
                      <option key={venue.id} value={venue.id}>
                        {venue.name} ({venue.city}, {venue.state})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Events will use this venue if set, or create venues from scraped location data.
                  </p>
                </div>
                <div>
                  <Label htmlFor="promoterId">Promoter *</Label>
                  <select
                    id="promoterId"
                    value={selectedPromoterId}
                    onChange={(e) => setSelectedPromoterId(e.target.value)}
                    className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm mt-1"
                  >
                    <option value="">Select a promoter...</option>
                    {promoters.map((promoter) => (
                      <option key={promoter.id} value={promoter.id}>
                        {promoter.companyName}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Events will be assigned to this promoter.
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={fetchDetails}
                    onChange={(e) => setFetchDetails(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    Fetch detailed information from event pages (slower but more complete)
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={updateExisting}
                    onChange={(e) => setUpdateExisting(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    Update existing events (allows re-importing already imported events)
                  </span>
                </label>
              </div>
            </CardContent>
          </Card>

          {/* Events List */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Preview Events</CardTitle>
                  <p className="text-sm text-gray-500 mt-1">
                    {stats.total} events found: {stats.newCount} new, {stats.existingCount} already imported
                  </p>
                </div>
                <div className="flex gap-2">
                  {updateExisting ? (
                    <Button variant="outline" size="sm" onClick={selectAll}>
                      Select All ({stats.total})
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={selectAllNew}>
                      Select All New ({stats.newCount})
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    Clear Selection
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 max-h-[500px] overflow-y-auto">
                {events.map((event) => (
                  <label
                    key={event.sourceId}
                    className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                      event.exists
                        ? "bg-gray-50 border-gray-200"
                        : selectedEvents.has(event.sourceId)
                        ? "bg-blue-50 border-blue-300"
                        : "hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedEvents.has(event.sourceId)}
                      onChange={() => toggleEventSelection(event.sourceId)}
                      disabled={event.exists && !updateExisting}
                      className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">{event.name}</span>
                        {event.exists ? (
                          <Badge variant="default">Already Imported</Badge>
                        ) : (
                          <Badge variant="success">New</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm text-gray-600">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-4 h-4" />
                          {formatDate(event.startDate)} - {formatDate(event.endDate)}
                        </span>
                        {(event.venue?.name || event.location) && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-4 h-4" />
                            {event.venue ? (
                              <span>
                                {event.venue.name}
                                {event.venue.city && `, ${event.venue.city}`}
                                {event.venue.state && `, ${event.venue.state}`}
                              </span>
                            ) : (
                              event.location
                            )}
                          </span>
                        )}
                      </div>
                      {event.sourceUrl && (
                        <a
                          href={event.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="w-3 h-3" />
                          View Source
                        </a>
                      )}
                    </div>
                    {event.imageUrl && (
                      <img
                        src={event.imageUrl}
                        alt=""
                        className="w-20 h-20 rounded object-cover"
                      />
                    )}
                  </label>
                ))}
              </div>

              {/* Import Button */}
              <div className="mt-6 flex items-center justify-between border-t pt-4">
                <span className="text-sm text-gray-600">
                  {selectedEvents.size} event{selectedEvents.size !== 1 ? "s" : ""} selected
                </span>
                <Button
                  onClick={handleImport}
                  disabled={importing || selectedEvents.size === 0 || !selectedPromoterId}
                >
                  <Download className="w-4 h-4 mr-2" />
                  {importing
                    ? "Importing..."
                    : `Import ${selectedEvents.size} Event${selectedEvents.size !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Help Text */}
      {events.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Download className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900">Import Events from External Sources</h3>
            <p className="text-gray-500 mt-2 max-w-md mx-auto">
              Select a source and click &quot;Preview Events&quot; to see available events.
              You can then select which events to import into your calendar.
            </p>
            <p className="text-sm text-gray-400 mt-4">
              Currently supported: mainefairs.net, mainemade.com, mainepublic.org, mafa.org, vtnhfairs.org (VT &amp; NH)
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
