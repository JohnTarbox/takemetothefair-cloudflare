"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Store, Trash2, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EVENT_VENDOR_STATUS } from "@/lib/constants";
import { STATUS_LABELS, STATUS_BADGE_VARIANTS } from "@/lib/vendor-status";

export const runtime = "edge";

interface Vendor {
  id: string;
  businessName: string;
  slug: string;
  vendorType: string | null;
  logoUrl: string | null;
  commercial: boolean;
  canSelfConfirm: boolean;
}

interface EventDay {
  id: string;
  date: string; // YYYY-MM-DD
  openTime: string;
  closeTime: string;
}

interface EventVendor {
  id: string;
  eventId: string;
  vendorId: string;
  status: string;
  paymentStatus: string;
  boothInfo: string | null;
  // K18 Phase 2 (drizzle/0114, 2026-06-06) — per-occurrence scoping.
  // NULL = series-wide / regular participant; non-NULL = vendor on that
  // specific date only. eventDayDate is the resolved YYYY-MM-DD from
  // the LEFT JOIN to event_days in the GET handler.
  eventDayId?: string | null;
  eventDayDate?: string | null;
  vendor: Vendor;
}

interface Event {
  id: string;
  name: string;
  commercialVendorsAllowed: boolean;
  // K18 Phase 2 — the admin GET /api/admin/events/[id] already returns
  // this; surfacing it lets the Add Vendor form show a per-day selector.
  eventDays?: EventDay[];
}

export default function ManageEventVendorsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<Event | null>(null);
  const [eventVendors, setEventVendors] = useState<EventVendor[]>([]);
  const [allVendors, setAllVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [selectedVendorId, setSelectedVendorId] = useState("");
  const [boothInfo, setBoothInfo] = useState("");
  // K18 Phase 2 (2026-06-06): per-occurrence scoping for the single-vendor
  // Add form. Empty string = series-wide (today's default); a UUID = scope
  // to that event_day. Bulk-add uses the same default (series-wide); per-day
  // bulk-add would need multi-select per row -- deferred to a later cycle.
  const [selectedEventDayId, setSelectedEventDayId] = useState("");
  const [adding, setAdding] = useState(false);

  // Bulk add state
  const [bulkSearchQuery, setBulkSearchQuery] = useState("");
  const [selectedVendorIds, setSelectedVendorIds] = useState<Set<string>>(new Set());
  const [bulkAdding, setBulkAdding] = useState(false);

  useEffect(() => {
    fetchData();
  }, [id]);

  const fetchData = async () => {
    try {
      const [eventRes, vendorsRes, allVendorsRes] = await Promise.all([
        fetch(`/api/admin/events/${id}`),
        fetch(`/api/admin/events/${id}/vendors`),
        fetch("/api/admin/vendors"),
      ]);

      if (!eventRes.ok) throw new Error("Event not found");

      const eventData = (await eventRes.json()) as Event;
      const vendorsData = (await vendorsRes.json()) as EventVendor[];
      const allVendorsData = (await allVendorsRes.json()) as Vendor[];

      setEvent(eventData);
      setEventVendors(vendorsData);
      setAllVendors(allVendorsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  const handleAddVendor = async () => {
    if (!selectedVendorId) return;

    setAdding(true);
    setError("");

    try {
      const res = await fetch(`/api/admin/events/${id}/vendors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: selectedVendorId,
          status: "CONFIRMED",
          boothInfo: boothInfo || undefined,
          // K18 Phase 2: empty string means series-wide (default); explicit
          // null is what the API expects to omit the column from the INSERT.
          eventDayId: selectedEventDayId || null,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to add vendor");
      }

      const newEventVendor = (await res.json()) as EventVendor;
      setEventVendors([...eventVendors, newEventVendor]);
      setShowAddForm(false);
      setSelectedVendorId("");
      setBoothInfo("");
      setSelectedEventDayId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add vendor");
    } finally {
      setAdding(false);
    }
  };

  const handleBulkAddVendors = async () => {
    if (selectedVendorIds.size === 0) return;

    setBulkAdding(true);
    setError("");

    try {
      const vendorIdsArray = Array.from(selectedVendorIds);
      const results: EventVendor[] = [];

      // Add vendors one by one (could be optimized with a bulk API endpoint)
      for (const vendorId of vendorIdsArray) {
        const res = await fetch(`/api/admin/events/${id}/vendors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendorId,
            status: "CONFIRMED",
          }),
        });

        if (res.ok) {
          const newEventVendor = (await res.json()) as EventVendor;
          results.push(newEventVendor);
        }
      }

      setEventVendors([...eventVendors, ...results]);
      setShowBulkAdd(false);
      setSelectedVendorIds(new Set());
      setBulkSearchQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add vendors");
    } finally {
      setBulkAdding(false);
    }
  };

  const handleUpdateStatus = async (eventVendorId: string, status: string) => {
    try {
      const res = await fetch(`/api/admin/events/${id}/vendors`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventVendorId, status }),
      });

      if (!res.ok) throw new Error("Failed to update status");

      setEventVendors(eventVendors.map((ev) => (ev.id === eventVendorId ? { ...ev, status } : ev)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    }
  };

  const handleRemoveVendor = async (eventVendorId: string) => {
    if (!confirm("Are you sure you want to remove this vendor from the event?")) return;

    try {
      const res = await fetch(`/api/admin/events/${id}/vendors?eventVendorId=${eventVendorId}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Failed to remove vendor");

      setEventVendors(eventVendors.filter((ev) => ev.id !== eventVendorId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove vendor");
    }
  };

  const toggleVendorSelection = (vendorId: string) => {
    const newSelected = new Set(selectedVendorIds);
    if (newSelected.has(vendorId)) {
      newSelected.delete(vendorId);
    } else {
      newSelected.add(vendorId);
    }
    setSelectedVendorIds(newSelected);
  };

  const selectAllFiltered = () => {
    const newSelected = new Set(selectedVendorIds);
    filteredAvailableVendors.forEach((v) => newSelected.add(v.id));
    setSelectedVendorIds(newSelected);
  };

  const deselectAll = () => {
    setSelectedVendorIds(new Set());
  };

  // Filter out vendors already added to the event
  const availableVendors = allVendors.filter(
    (v) => !eventVendors.some((ev) => ev.vendorId === v.id)
  );

  // Filter available vendors by search query
  const filteredAvailableVendors = availableVendors.filter(
    (v) =>
      v.businessName.toLowerCase().includes(bulkSearchQuery.toLowerCase()) ||
      v.vendorType?.toLowerCase().includes(bulkSearchQuery.toLowerCase())
  );

  const allStatuses = Object.values(EVENT_VENDOR_STATUS);

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-muted rounded w-1/4"></div>
        <div className="h-64 bg-muted rounded"></div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Event not found</p>
        <Link href="/admin/events" className="text-royal hover:underline mt-2 inline-block">
          Back to Events
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/events"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Events
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Manage Vendors</h1>
          <p className="text-muted-foreground mt-1">{event.name}</p>
          {!event.commercialVendorsAllowed && (
            <Badge variant="warning" className="mt-2">
              Commercial vendors not allowed
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setShowBulkAdd(true);
              setShowAddForm(false);
            }}
            disabled={showBulkAdd}
          >
            <Users className="w-4 h-4 mr-2" />
            Quick Add Multiple
          </Button>
          <Button
            onClick={() => {
              setShowAddForm(true);
              setShowBulkAdd(false);
            }}
            disabled={showAddForm}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Single Vendor
          </Button>
        </div>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm">{error}</div>}

      {/* Bulk Add Form */}
      {showBulkAdd && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Quick Add Multiple Vendors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search vendors by name or type..."
                  value={bulkSearchQuery}
                  onChange={(e) => setBulkSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              {/* Selection controls */}
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  {selectedVendorIds.size} vendor{selectedVendorIds.size !== 1 ? "s" : ""} selected
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAllFiltered}>
                    Select All Shown ({filteredAvailableVendors.length})
                  </Button>
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    Clear Selection
                  </Button>
                </div>
              </div>

              {/* Vendor list with checkboxes */}
              <div className="border rounded-lg max-h-80 overflow-y-auto">
                {filteredAvailableVendors.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground">
                    {availableVendors.length === 0
                      ? "All vendors have been added to this event"
                      : "No vendors match your search"}
                  </div>
                ) : (
                  <div className="divide-y">
                    {filteredAvailableVendors.map((vendor) => (
                      <label
                        key={vendor.id}
                        className="flex items-center gap-3 p-3 hover:bg-muted cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedVendorIds.has(vendor.id)}
                          onChange={() => toggleVendorSelection(vendor.id)}
                          className="w-4 h-4 rounded border-border text-royal focus:ring-ring"
                        />
                        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                          {vendor.logoUrl ? (
                            <img
                              src={vendor.logoUrl}
                              alt={vendor.businessName}
                              className="w-10 h-10 rounded-lg object-cover"
                            />
                          ) : (
                            <Store className="w-5 h-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {vendor.businessName}
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-2">
                            {vendor.vendorType && <span>{vendor.vendorType}</span>}
                            {vendor.commercial && (
                              <Badge variant="default" className="text-xs">
                                Commercial
                              </Badge>
                            )}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <Button
                  onClick={handleBulkAddVendors}
                  disabled={selectedVendorIds.size === 0 || bulkAdding}
                >
                  {bulkAdding
                    ? "Adding..."
                    : `Add ${selectedVendorIds.size} Vendor${selectedVendorIds.size !== 1 ? "s" : ""}`}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowBulkAdd(false);
                    setSelectedVendorIds(new Set());
                    setBulkSearchQuery("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Single Add Form */}
      {showAddForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Add Vendor to Event</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <Label htmlFor="vendorId">Select Vendor *</Label>
                <select
                  id="vendorId"
                  value={selectedVendorId}
                  onChange={(e) => setSelectedVendorId(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Choose a vendor...</option>
                  {availableVendors.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.businessName}
                      {vendor.vendorType ? ` (${vendor.vendorType})` : ""}
                      {vendor.commercial ? " - Commercial" : ""}
                    </option>
                  ))}
                </select>
                {availableVendors.length === 0 && (
                  <p className="text-sm text-muted-foreground mt-1">
                    All vendors have been added to this event
                  </p>
                )}
              </div>

              {/* K18 Phase 2 — per-occurrence scoping. Only shown when the
                  event actually has event_days (recurring or multi-day
                  events). Single-date / no-event_days events default the
                  link to series-wide and don't need a selector. */}
              {event?.eventDays && event.eventDays.length > 0 && (
                <div>
                  <Label htmlFor="eventDayId">Scope (optional)</Label>
                  <select
                    id="eventDayId"
                    value={selectedEventDayId}
                    onChange={(e) => setSelectedEventDayId(e.target.value)}
                    className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Regular participant (all dates)</option>
                    {event.eventDays
                      .slice()
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.date}
                        </option>
                      ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave on &quot;Regular participant&quot; for vendors that attend every
                    occurrence. Pick a specific date for one-time featured slots.
                  </p>
                </div>
              )}

              <div>
                <Label htmlFor="boothInfo">Booth Info (optional)</Label>
                <Input
                  id="boothInfo"
                  value={boothInfo}
                  onChange={(e) => setBoothInfo(e.target.value)}
                  placeholder="e.g., Booth #12, Section A"
                />
              </div>

              <div className="flex gap-2">
                <Button onClick={handleAddVendor} disabled={!selectedVendorId || adding}>
                  {adding ? "Adding..." : "Add Vendor"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowAddForm(false);
                    setSelectedVendorId("");
                    setBoothInfo("");
                    setSelectedEventDayId("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Event Vendors ({eventVendors.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {eventVendors.length === 0 ? (
            <div className="text-center py-8">
              <Store className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No vendors added to this event yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Use &quot;Quick Add Multiple&quot; to add several vendors at once
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {eventVendors.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
                      {ev.vendor.logoUrl ? (
                        <img
                          src={ev.vendor.logoUrl}
                          alt={ev.vendor.businessName}
                          className="w-12 h-12 rounded-lg object-cover"
                        />
                      ) : (
                        <Store className="w-6 h-6 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/admin/vendors/${ev.vendor.id}/edit`}
                          className="font-medium text-foreground hover:text-royal"
                        >
                          {ev.vendor.businessName}
                        </Link>
                        {ev.vendor.commercial && <Badge variant="default">Commercial</Badge>}
                        {ev.vendor.canSelfConfirm && <Badge variant="success">Self-Confirm</Badge>}
                        {/* K18 Phase 2: per-occurrence scoping badge. Series-
                            wide links (eventDayId IS NULL) get no badge -- the
                            absence implies regular-participant per the docs. */}
                        {ev.eventDayId && ev.eventDayDate && (
                          <Badge variant="info">{ev.eventDayDate}</Badge>
                        )}
                      </div>
                      {ev.vendor.vendorType && (
                        <p className="text-sm text-muted-foreground">{ev.vendor.vendorType}</p>
                      )}
                      {ev.boothInfo && (
                        <p className="text-sm text-muted-foreground">Booth: {ev.boothInfo}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <select
                      value={ev.status}
                      onChange={(e) => handleUpdateStatus(ev.id, e.target.value)}
                      className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
                    >
                      {allStatuses.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s as keyof typeof STATUS_LABELS] ?? s}
                        </option>
                      ))}
                    </select>
                    <Badge
                      variant={
                        STATUS_BADGE_VARIANTS[ev.status as keyof typeof STATUS_BADGE_VARIANTS] ??
                        "default"
                      }
                    >
                      {STATUS_LABELS[ev.status as keyof typeof STATUS_LABELS] ?? ev.status}
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRemoveVendor(ev.id)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
