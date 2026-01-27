"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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

interface Event {
  id: string;
  name: string;
  description: string | null;
  venueId: string | null;
  promoterId: string;
  startDate: string | null;
  endDate: string | null;
  datesConfirmed: boolean;
  ticketUrl: string | null;
  ticketPriceMin: number | null;
  ticketPriceMax: number | null;
  imageUrl: string | null;
  featured: boolean;
  commercialVendorsAllowed: boolean;
  status: string;
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

  useEffect(() => {
    fetchEvent();
    fetchVenues();
    fetchPromoters();
  }, [id]);

  const fetchEvent = async () => {
    try {
      const res = await fetch(`/api/admin/events/${id}`);
      if (!res.ok) throw new Error("Event not found");
      const data = await res.json() as Event;
      setEvent(data);
      setDatesTBD(!data.startDate || !data.datesConfirmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load event");
    } finally {
      setLoading(false);
    }
  };

  const fetchVenues = async () => {
    try {
      const res = await fetch("/api/venues");
      const data = await res.json() as Venue[];
      setVenues(data);
    } catch (err) {
      console.error("Failed to fetch venues:", err);
    }
  };

  const fetchPromoters = async () => {
    try {
      const res = await fetch("/api/admin/promoters");
      const data = await res.json() as { promoter: Promoter }[];
      // Extract promoter from nested structure
      setPromoters(data.map(item => item.promoter));
    } catch (err) {
      console.error("Failed to fetch promoters:", err);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setError("");

    const formData = new FormData(e.currentTarget);

    // Convert datetime-local to ISO format
    const startDateLocal = formData.get("startDate") as string;
    const endDateLocal = formData.get("endDate") as string;
    const startDate = datesTBD || !startDateLocal ? null : new Date(startDateLocal).toISOString();
    const endDate = datesTBD || !endDateLocal ? null : new Date(endDateLocal).toISOString();

    const data = {
      name: formData.get("name"),
      description: formData.get("description") || null,
      venueId: formData.get("venueId") || null,
      startDate,
      endDate,
      datesConfirmed: !datesTBD,
      ticketUrl: formData.get("ticketUrl") || null,
      ticketPriceMin: formData.get("ticketPriceMin") ? parseFloat(formData.get("ticketPriceMin") as string) : null,
      ticketPriceMax: formData.get("ticketPriceMax") ? parseFloat(formData.get("ticketPriceMax") as string) : null,
      imageUrl: formData.get("imageUrl") || null,
      featured: formData.get("featured") === "on",
      commercialVendorsAllowed: formData.get("commercialVendorsAllowed") === "on",
      status: formData.get("status"),
    };

    try {
      const res = await fetch(`/api/admin/events/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = await res.json() as { error?: string };
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
    return date.toISOString().slice(0, 16);
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
            <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm">
              {error}
            </div>
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
                <div className="flex items-center gap-2">
                  <input
                    id="datesTBD"
                    type="checkbox"
                    checked={datesTBD}
                    onChange={(e) => setDatesTBD(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="datesTBD" className="font-normal">
                    Dates to be determined (TBD)
                  </Label>
                </div>
                {!datesTBD && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="startDate">Start Date *</Label>
                      <Input
                        id="startDate"
                        name="startDate"
                        type="datetime-local"
                        required={!datesTBD}
                        defaultValue={event.startDate ? formatDateForInput(event.startDate) : ""}
                      />
                    </div>
                    <div>
                      <Label htmlFor="endDate">End Date *</Label>
                      <Input
                        id="endDate"
                        name="endDate"
                        type="datetime-local"
                        required={!datesTBD}
                        defaultValue={event.endDate ? formatDateForInput(event.endDate) : ""}
                      />
                    </div>
                  </div>
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
    </div>
  );
}
