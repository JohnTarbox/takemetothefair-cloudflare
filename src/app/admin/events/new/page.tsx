"use client";

import { useState, useEffect } from "react";
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

export default function NewEventPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [venues, setVenues] = useState<Venue[]>([]);
  const [promoters, setPromoters] = useState<Promoter[]>([]);
  const [datesTBD, setDatesTBD] = useState(false);

  useEffect(() => {
    fetchVenues();
    fetchPromoters();
  }, []);

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
      const data = await res.json() as Promoter[];
      setPromoters(data);
    } catch (err) {
      console.error("Failed to fetch promoters:", err);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get("name"),
      description: formData.get("description") || null,
      venueId: formData.get("venueId") || null,
      promoterId: formData.get("promoterId"),
      startDate: datesTBD ? null : formData.get("startDate"),
      endDate: datesTBD ? null : formData.get("endDate"),
      datesConfirmed: !datesTBD,
      ticketUrl: formData.get("ticketUrl") || null,
      ticketPriceMin: formData.get("ticketPriceMin") ? parseFloat(formData.get("ticketPriceMin") as string) : null,
      ticketPriceMax: formData.get("ticketPriceMax") ? parseFloat(formData.get("ticketPriceMax") as string) : null,
      imageUrl: formData.get("imageUrl") || null,
      featured: formData.get("featured") === "on",
      commercialVendorsAllowed: formData.get("commercialVendorsAllowed") === "on",
      status: formData.get("status") || "APPROVED",
    };

    try {
      const res = await fetch("/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = await res.json() as { error?: string };
        throw new Error(result.error || "Failed to create event");
      }

      router.push("/admin/events");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create event");
    } finally {
      setLoading(false);
    }
  };

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
          <CardTitle>Add New Event</CardTitle>
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
                <Input id="name" name="name" required />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  placeholder="Describe the event..."
                />
              </div>

              <div>
                <Label htmlFor="venueId">Venue</Label>
                <select
                  id="venueId"
                  name="venueId"
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
                <Label htmlFor="promoterId">Promoter *</Label>
                <select
                  id="promoterId"
                  name="promoterId"
                  required
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select a promoter</option>
                  {promoters.map((promoter) => (
                    <option key={promoter.id} value={promoter.id}>
                      {promoter.companyName}
                    </option>
                  ))}
                </select>
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
                      />
                    </div>
                    <div>
                      <Label htmlFor="endDate">End Date *</Label>
                      <Input
                        id="endDate"
                        name="endDate"
                        type="datetime-local"
                        required={!datesTBD}
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
                  placeholder="https://tickets.example.com"
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
                    placeholder="0.00"
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
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="imageUrl">Image URL</Label>
                <Input
                  id="imageUrl"
                  name="imageUrl"
                  type="url"
                  placeholder="https://example.com/image.jpg"
                />
              </div>

              <div>
                <Label htmlFor="status">Status</Label>
                <select
                  id="status"
                  name="status"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  defaultValue="APPROVED"
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
                    defaultChecked
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="commercialVendorsAllowed" className="font-normal">
                    Commercial Vendors Allowed
                  </Label>
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={loading}>
                {loading ? "Creating..." : "Create Event"}
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
