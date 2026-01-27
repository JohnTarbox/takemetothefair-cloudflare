"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const runtime = "edge";

interface Venue {
  id: string;
  name: string;
  city: string;
  state: string;
}

export default function CreateEventPage() {
  const router = useRouter();
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    venueId: "",
    startDate: "",
    startTime: "09:00",
    endDate: "",
    endTime: "17:00",
    categories: "",
    tags: "",
    ticketUrl: "",
    ticketPriceMin: "",
    ticketPriceMax: "",
    imageUrl: "",
  });

  useEffect(() => {
    fetchVenues();
  }, []);

  const fetchVenues = async () => {
    try {
      const res = await fetch("/api/venues");
      const data = await res.json();
      setVenues(data);
    } catch (error) {
      console.error("Failed to fetch venues:", error);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >
  ) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const startDateTime = new Date(
        `${formData.startDate}T${formData.startTime}`
      );
      const endDateTime = new Date(`${formData.endDate}T${formData.endTime}`);

      const res = await fetch("/api/promoter/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description,
          venueId: formData.venueId || null,
          startDate: startDateTime.toISOString(),
          endDate: endDateTime.toISOString(),
          categories: formData.categories
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          tags: formData.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          ticketUrl: formData.ticketUrl || null,
          ticketPriceMin: formData.ticketPriceMin
            ? parseFloat(formData.ticketPriceMin)
            : null,
          ticketPriceMax: formData.ticketPriceMax
            ? parseFloat(formData.ticketPriceMax)
            : null,
          imageUrl: formData.imageUrl || null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create event");
        return;
      }

      router.push("/promoter/events");
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Create New Event</h1>

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">
            Fill in the details below to submit your event for approval
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                {error}
              </div>
            )}

            <Input
              label="Event Name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="Summer County Fair 2024"
              required
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={4}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Describe your event..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Venue (optional)
              </label>
              <select
                name="venueId"
                value={formData.venueId}
                onChange={handleChange}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">No venue selected</option>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name} - {venue.city}, {venue.state}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Start Date"
                type="date"
                name="startDate"
                value={formData.startDate}
                onChange={handleChange}
                required
              />
              <Input
                label="Start Time"
                type="time"
                name="startTime"
                value={formData.startTime}
                onChange={handleChange}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="End Date"
                type="date"
                name="endDate"
                value={formData.endDate}
                onChange={handleChange}
                required
              />
              <Input
                label="End Time"
                type="time"
                name="endTime"
                value={formData.endTime}
                onChange={handleChange}
                required
              />
            </div>

            <Input
              label="Categories (comma-separated)"
              name="categories"
              value={formData.categories}
              onChange={handleChange}
              placeholder="Fair, Festival, Food"
            />

            <Input
              label="Tags (comma-separated)"
              name="tags"
              value={formData.tags}
              onChange={handleChange}
              placeholder="family-friendly, outdoor, music"
            />

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Min Ticket Price"
                type="number"
                name="ticketPriceMin"
                value={formData.ticketPriceMin}
                onChange={handleChange}
                placeholder="0"
                min="0"
                step="0.01"
              />
              <Input
                label="Max Ticket Price"
                type="number"
                name="ticketPriceMax"
                value={formData.ticketPriceMax}
                onChange={handleChange}
                placeholder="50"
                min="0"
                step="0.01"
              />
            </div>

            <Input
              label="Ticket URL"
              type="url"
              name="ticketUrl"
              value={formData.ticketUrl}
              onChange={handleChange}
              placeholder="https://..."
            />

            <Input
              label="Image URL"
              type="url"
              name="imageUrl"
              value={formData.imageUrl}
              onChange={handleChange}
              placeholder="https://..."
            />

            <div className="flex gap-3">
              <Button type="submit" isLoading={loading} disabled={loading}>
                Submit for Approval
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
