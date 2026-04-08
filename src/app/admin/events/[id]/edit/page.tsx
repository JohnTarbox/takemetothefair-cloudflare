"use client";

import { useState, useEffect, use, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DailyScheduleInput, type EventDayInput } from "@/components/events/DailyScheduleInput";
import { SchemaOrgPanel } from "@/components/admin/SchemaOrgPanel";
import { RescrapePanel } from "@/components/admin/RescrapePanel";

export const runtime = "edge";

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

interface EventDay {
  id: string;
  date: string;
  openTime: string;
  closeTime: string;
  notes: string | null;
  closed: boolean;
}

interface Event {
  id: string;
  name: string;
  description: string | null;
  venueId: string | null;
  promoterId: string;
  startDate: string | null;
  endDate: string | null;
  datesConfirmed: boolean;
  discontinuousDates?: boolean;
  ticketUrl: string | null;
  ticketPriceMin: number | null;
  ticketPriceMax: number | null;
  imageUrl: string | null;
  featured: boolean;
  commercialVendorsAllowed: boolean;
  status: string;
  eventDays?: EventDay[];
  sourceName?: string | null;
  sourceUrl?: string | null;
  lastSyncedAt?: string | null;
  vendorFeeMin?: number | null;
  vendorFeeMax?: number | null;
  vendorFeeNotes?: string | null;
  indoorOutdoor?: string | null;
  estimatedAttendance?: number | null;
  eventScale?: string | null;
  applicationDeadline?: string | null;
  applicationUrl?: string | null;
  applicationInstructions?: string | null;
  walkInsAllowed?: boolean | null;
}

export default function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [venues, setVenues] = useState<Venue[]>([]);
  const [promoters, setPromoters] = useState<Promoter[]>([]);
  const [datesTBD, setDatesTBD] = useState(false);
  const [discontinuousDates, setDiscontinuousDates] = useState(false);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [eventDays, setEventDays] = useState<EventDayInput[]>([]);

  useEffect(() => {
    fetchEvent();
    fetchVenues();
    fetchPromoters();
  }, [id]);

  const fetchEvent = async () => {
    try {
      const res = await fetch(`/api/admin/events/${id}`);
      if (!res.ok) throw new Error("Event not found");
      const data = (await res.json()) as Event;
      setEvent(data);
      setDatesTBD(!data.startDate || !data.datesConfirmed);
      setDiscontinuousDates(data.discontinuousDates ?? false);
      if (data.startDate) {
        setStartDate(formatDateForInput(data.startDate));
      }
      if (data.endDate) {
        setEndDate(formatDateForInput(data.endDate));
      }
      // Convert existing eventDays to input format
      if (data.eventDays && data.eventDays.length > 0) {
        setEventDays(
          data.eventDays.map((d) => ({
            date: d.date,
            openTime: d.openTime,
            closeTime: d.closeTime,
            notes: d.notes || "",
            closed: d.closed,
          }))
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load event");
    } finally {
      setLoading(false);
    }
  };

  const fetchVenues = async () => {
    try {
      const res = await fetch("/api/venues");
      if (!res.ok) {
        console.error("Failed to fetch venues:", res.status);
        return;
      }
      const data = (await res.json()) as any;
      if (Array.isArray(data)) {
        setVenues(data);
      }
    } catch (err) {
      console.error("Failed to fetch venues:", err);
    }
  };

  const fetchPromoters = async () => {
    try {
      const res = await fetch("/api/admin/promoters");
      if (!res.ok) {
        console.error("Failed to fetch promoters:", res.status);
        return;
      }
      const data = (await res.json()) as any;
      if (Array.isArray(data)) {
        setPromoters(data);
      }
    } catch (err) {
      console.error("Failed to fetch promoters:", err);
    }
  };

  const handleEventDaysChange = useCallback((days: EventDayInput[]) => {
    setEventDays(days);
  }, []);

  const handleSchemaOrgFieldsApplied = useCallback((appliedFields: string[]) => {
    // Refresh the event data to show updated values
    fetchEvent();
    console.log("Applied schema.org fields:", appliedFields);
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setError("");

    const formData = new FormData(e.currentTarget);

    // Auto-compute dates from eventDays when discontinuous
    let startDateISO: string | null;
    let endDateISO: string | null;

    if (discontinuousDates && eventDays.length > 0) {
      const sorted = eventDays.map((d) => d.date).sort();
      startDateISO = new Date(sorted[0] + "T00:00:00").toISOString();
      endDateISO = new Date(sorted[sorted.length - 1] + "T00:00:00").toISOString();
    } else {
      startDateISO =
        datesTBD || !startDate ? null : new Date(startDate + "T00:00:00").toISOString();
      endDateISO = datesTBD || !endDate ? null : new Date(endDate + "T00:00:00").toISOString();
    }

    const data = {
      name: formData.get("name"),
      description: formData.get("description") || null,
      venueId: formData.get("venueId") || null,
      startDate: startDateISO,
      endDate: endDateISO,
      datesConfirmed: !datesTBD,
      discontinuousDates,
      ticketUrl: formData.get("ticketUrl") || null,
      ticketPriceMin: formData.get("ticketPriceMin")
        ? parseFloat(formData.get("ticketPriceMin") as string)
        : null,
      ticketPriceMax: formData.get("ticketPriceMax")
        ? parseFloat(formData.get("ticketPriceMax") as string)
        : null,
      imageUrl: formData.get("imageUrl") || null,
      featured: formData.get("featured") === "on",
      commercialVendorsAllowed: formData.get("commercialVendorsAllowed") === "on",
      status: formData.get("status"),
      eventDays: eventDays.length > 0 ? eventDays : [],
      vendorFeeMin: formData.get("vendorFeeMin")
        ? parseFloat(formData.get("vendorFeeMin") as string)
        : null,
      vendorFeeMax: formData.get("vendorFeeMax")
        ? parseFloat(formData.get("vendorFeeMax") as string)
        : null,
      vendorFeeNotes: formData.get("vendorFeeNotes") || null,
      indoorOutdoor: formData.get("indoorOutdoor") || null,
      estimatedAttendance: formData.get("estimatedAttendance")
        ? parseInt(formData.get("estimatedAttendance") as string, 10)
        : null,
      eventScale: formData.get("eventScale") || null,
      applicationDeadline: formData.get("applicationDeadline")
        ? new Date((formData.get("applicationDeadline") as string) + "T00:00:00").toISOString()
        : null,
      applicationUrl: formData.get("applicationUrl") || null,
      applicationInstructions: formData.get("applicationInstructions") || null,
      walkInsAllowed: formData.get("walkInsAllowed") === "on" ? true : null,
    };

    try {
      const res = await fetch(`/api/admin/events/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = (await res.json()) as { error?: string };
        throw new Error(result.error || "Failed to update event");
      }

      router.push("/admin/events");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update event");
    } finally {
      setSaving(false);
    }
  };

  const formatDateForInput = (dateStr: string) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toISOString().slice(0, 10);
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/4"></div>
        <div className="h-96 bg-gray-200 rounded"></div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Event not found</p>
        <Link href="/admin/events" className="text-blue-600 hover:underline mt-2 inline-block">
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
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Events
        </Link>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Edit Event</CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Event Name *</Label>
                <Input id="name" name="name" required defaultValue={event.name} />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  defaultValue={event.description ?? ""}
                />
              </div>

              <div>
                <Label htmlFor="venueId">Venue</Label>
                <select
                  id="venueId"
                  name="venueId"
                  defaultValue={event.venueId || ""}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">No venue selected</option>
                  {venues.map((venue) => (
                    <option key={venue.id} value={venue.id}>
                      {venue.name} - {venue.city}, {venue.state}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label htmlFor="promoterId">Promoter</Label>
                <select
                  id="promoterId"
                  name="promoterId"
                  disabled
                  defaultValue={event.promoterId}
                  className="w-full h-10 rounded-md border border-input bg-gray-100 px-3 py-2 text-sm"
                >
                  {promoters.map((promoter) => (
                    <option key={promoter.id} value={promoter.id}>
                      {promoter.companyName}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Promoter cannot be changed</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <input
                      id="datesTBD"
                      type="checkbox"
                      checked={datesTBD}
                      onChange={(e) => {
                        setDatesTBD(e.target.checked);
                        if (e.target.checked) setDiscontinuousDates(false);
                      }}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="datesTBD" className="font-normal">
                      Dates TBD
                    </Label>
                  </div>
                  {!datesTBD && (
                    <div className="flex items-center gap-2">
                      <input
                        id="discontinuousDates"
                        type="checkbox"
                        checked={discontinuousDates}
                        onChange={(e) => setDiscontinuousDates(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <Label htmlFor="discontinuousDates" className="font-normal">
                        Non-contiguous dates
                      </Label>
                    </div>
                  )}
                </div>
                {!datesTBD && !discontinuousDates && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="startDate">Start Date *</Label>
                      <Input
                        id="startDate"
                        name="startDate"
                        type="date"
                        required={!datesTBD && !discontinuousDates}
                        value={startDate}
                        onChange={(e) => {
                          const val = e.target.value;
                          setStartDate(val);
                          if (!endDate || endDate < val) {
                            setEndDate(val);
                          }
                        }}
                      />
                    </div>
                    <div>
                      <Label htmlFor="endDate">End Date *</Label>
                      <Input
                        id="endDate"
                        name="endDate"
                        type="date"
                        required={!datesTBD && !discontinuousDates}
                        min={startDate || undefined}
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {!datesTBD && (
                  <DailyScheduleInput
                    startDate={startDate}
                    endDate={endDate}
                    initialDays={eventDays}
                    discontinuousDates={discontinuousDates}
                    onDiscontinuousChange={setDiscontinuousDates}
                    onChange={handleEventDaysChange}
                    disabled={saving}
                  />
                )}
              </div>

              <div>
                <Label htmlFor="ticketUrl">Ticket URL</Label>
                <Input
                  id="ticketUrl"
                  name="ticketUrl"
                  type="url"
                  defaultValue={event.ticketUrl ?? ""}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="ticketPriceMin">Min Ticket Price ($)</Label>
                  <Input
                    id="ticketPriceMin"
                    name="ticketPriceMin"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={event.ticketPriceMin ?? ""}
                  />
                </div>
                <div>
                  <Label htmlFor="ticketPriceMax">Max Ticket Price ($)</Label>
                  <Input
                    id="ticketPriceMax"
                    name="ticketPriceMax"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={event.ticketPriceMax ?? ""}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="imageUrl">Image URL</Label>
                <Input
                  id="imageUrl"
                  name="imageUrl"
                  type="url"
                  defaultValue={event.imageUrl ?? ""}
                />
              </div>

              <div>
                <Label htmlFor="status">Status</Label>
                <select
                  id="status"
                  name="status"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  defaultValue={event.status}
                >
                  <option value="DRAFT">Draft</option>
                  <option value="PENDING">Pending</option>
                  <option value="TENTATIVE">Tentative</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <input
                    id="featured"
                    name="featured"
                    type="checkbox"
                    defaultChecked={event.featured}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="featured" className="font-normal">
                    Featured Event
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="commercialVendorsAllowed"
                    name="commercialVendorsAllowed"
                    type="checkbox"
                    defaultChecked={event.commercialVendorsAllowed}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="commercialVendorsAllowed" className="font-normal">
                    Commercial Vendors Allowed
                  </Label>
                </div>
              </div>

              {/* Vendor Information */}
              <div className="border-t pt-4 mt-4">
                <h3 className="font-medium text-sm text-gray-700 mb-3">Vendor Information</h3>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="vendorFeeMin">Min Vendor/Booth Fee ($)</Label>
                      <Input
                        id="vendorFeeMin"
                        name="vendorFeeMin"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={event.vendorFeeMin ?? ""}
                      />
                    </div>
                    <div>
                      <Label htmlFor="vendorFeeMax">Max Vendor/Booth Fee ($)</Label>
                      <Input
                        id="vendorFeeMax"
                        name="vendorFeeMax"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={event.vendorFeeMax ?? ""}
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="vendorFeeNotes">Fee Details</Label>
                    <Input
                      id="vendorFeeNotes"
                      name="vendorFeeNotes"
                      defaultValue={event.vendorFeeNotes ?? ""}
                      placeholder='e.g., "$50 for 10x10, $75 for 10x20"'
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="indoorOutdoor">Indoor/Outdoor</Label>
                      <select
                        id="indoorOutdoor"
                        name="indoorOutdoor"
                        defaultValue={event.indoorOutdoor ?? ""}
                        className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">Not specified</option>
                        <option value="INDOOR">Indoor</option>
                        <option value="OUTDOOR">Outdoor</option>
                        <option value="MIXED">Mixed (Indoor &amp; Outdoor)</option>
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="eventScale">Event Scale</Label>
                      <select
                        id="eventScale"
                        name="eventScale"
                        defaultValue={event.eventScale ?? ""}
                        className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">Not specified</option>
                        <option value="SMALL">Small (community event)</option>
                        <option value="MEDIUM">Medium (regional)</option>
                        <option value="LARGE">Large (state-level)</option>
                        <option value="MAJOR">Major (multi-state/national)</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="estimatedAttendance">Estimated Attendance</Label>
                    <Input
                      id="estimatedAttendance"
                      name="estimatedAttendance"
                      type="number"
                      min="1"
                      defaultValue={event.estimatedAttendance ?? ""}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="walkInsAllowed"
                      name="walkInsAllowed"
                      type="checkbox"
                      defaultChecked={event.walkInsAllowed ?? false}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="walkInsAllowed" className="font-normal">
                      Walk-in Vendors Accepted
                    </Label>
                  </div>
                </div>
              </div>

              {/* Application Information */}
              <div className="border-t pt-4 mt-4">
                <h3 className="font-medium text-sm text-gray-700 mb-3">Vendor Application</h3>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="applicationDeadline">Application Deadline</Label>
                    <Input
                      id="applicationDeadline"
                      name="applicationDeadline"
                      type="date"
                      defaultValue={
                        event.applicationDeadline
                          ? formatDateForInput(event.applicationDeadline)
                          : ""
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="applicationUrl">Application URL</Label>
                    <Input
                      id="applicationUrl"
                      name="applicationUrl"
                      type="url"
                      defaultValue={event.applicationUrl ?? ""}
                      placeholder="https://example.com/apply"
                    />
                  </div>
                  <div>
                    <Label htmlFor="applicationInstructions">Application Instructions</Label>
                    <Textarea
                      id="applicationInstructions"
                      name="applicationInstructions"
                      rows={3}
                      defaultValue={event.applicationInstructions ?? ""}
                      placeholder="How to apply, requirements, contact info..."
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
              <Link href="/admin/events">
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Source Data & Schema.org Panels */}
      <div className="max-w-2xl space-y-4">
        {event && (event.sourceName || event.sourceUrl) && (
          <RescrapePanel
            eventId={id}
            sourceName={event.sourceName ?? null}
            sourceUrl={event.sourceUrl ?? null}
            lastSyncedAt={event.lastSyncedAt ?? null}
            onRescrapeComplete={() => fetchEvent()}
          />
        )}
        <SchemaOrgPanel eventId={id} onFieldsApplied={handleSchemaOrgFieldsApplied} />
      </div>
    </div>
  );
}
