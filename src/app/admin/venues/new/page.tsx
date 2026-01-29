"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const runtime = "edge";

export default function NewVenuePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [geocoding, setGeocoding] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get("name"),
      address: formData.get("address"),
      city: formData.get("city"),
      state: formData.get("state"),
      zip: formData.get("zip"),
      latitude: formData.get("latitude") ? parseFloat(formData.get("latitude") as string) : null,
      longitude: formData.get("longitude") ? parseFloat(formData.get("longitude") as string) : null,
      capacity: formData.get("capacity") ? parseInt(formData.get("capacity") as string) : null,
      contactEmail: formData.get("contactEmail") || null,
      contactPhone: formData.get("contactPhone") || null,
      website: formData.get("website") || null,
      description: formData.get("description") || null,
      imageUrl: formData.get("imageUrl") || null,
      status: formData.get("status") || "ACTIVE",
    };

    try {
      const res = await fetch("/api/admin/venues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = await res.json() as { error?: string };
        throw new Error(result.error || "Failed to create venue");
      }

      router.push("/admin/venues");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create venue");
    } finally {
      setLoading(false);
    }
  };

  const handleGeocode = async () => {
    setGeocoding(true);
    setError("");
    try {
      const form = document.querySelector("form") as HTMLFormElement;
      const formData = new FormData(form);
      const res = await fetch("/api/admin/venues/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: formData.get("address"),
          city: formData.get("city"),
          state: formData.get("state"),
          zip: formData.get("zip") || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || "Geocoding failed");
      }
      const result = await res.json() as { lat: number; lng: number; zip: string | null };
      const latInput = document.getElementById("latitude") as HTMLInputElement;
      const lngInput = document.getElementById("longitude") as HTMLInputElement;
      if (latInput) latInput.value = String(result.lat);
      if (lngInput) lngInput.value = String(result.lng);
      if (result.zip) {
        const zipInput = document.getElementById("zip") as HTMLInputElement;
        if (zipInput && !zipInput.value) zipInput.value = result.zip;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Geocoding failed");
    } finally {
      setGeocoding(false);
    }
  };

  const handleLookup = async () => {
    setLookingUp(true);
    setError("");
    try {
      const form = document.querySelector("form") as HTMLFormElement;
      const formData = new FormData(form);
      const res = await fetch("/api/admin/venues/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          city: formData.get("city"),
          state: formData.get("state"),
        }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || "Lookup failed");
      }
      const result = await res.json() as {
        phone: string | null;
        website: string | null;
        lat: number | null;
        lng: number | null;
        zip: string | null;
        photoUrl: string | null;
      };
      const setIfEmpty = (id: string, value: string | null) => {
        if (!value) return;
        const input = document.getElementById(id) as HTMLInputElement;
        if (input && !input.value) input.value = value;
      };
      setIfEmpty("contactPhone", result.phone);
      setIfEmpty("website", result.website);
      setIfEmpty("zip", result.zip);
      if (result.lat != null) setIfEmpty("latitude", String(result.lat));
      if (result.lng != null) setIfEmpty("longitude", String(result.lng));
      setIfEmpty("imageUrl", result.photoUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLookingUp(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/venues"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Venues
        </Link>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Add New Venue</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={lookingUp}
              onClick={handleLookup}
            >
              {lookingUp ? "Looking up..." : "Lookup on Google"}
            </Button>
          </div>
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
                <Label htmlFor="name">Venue Name *</Label>
                <Input id="name" name="name" required />
              </div>

              <div>
                <Label htmlFor="address">Address *</Label>
                <Input id="address" name="address" required />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="city">City *</Label>
                  <Input id="city" name="city" required />
                </div>
                <div>
                  <Label htmlFor="state">State *</Label>
                  <Input id="state" name="state" required maxLength={2} placeholder="CA" />
                </div>
                <div>
                  <Label htmlFor="zip">ZIP *</Label>
                  <Input id="zip" name="zip" required />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Coordinates</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={geocoding}
                    onClick={handleGeocode}
                  >
                    {geocoding ? "Geocoding..." : "Geocode Address"}
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="latitude">Latitude</Label>
                    <Input
                      id="latitude"
                      name="latitude"
                      type="number"
                      step="any"
                      placeholder="37.7749"
                    />
                  </div>
                  <div>
                    <Label htmlFor="longitude">Longitude</Label>
                    <Input
                      id="longitude"
                      name="longitude"
                      type="number"
                      step="any"
                      placeholder="-122.4194"
                    />
                  </div>
                </div>
              </div>

              <div>
                <Label htmlFor="capacity">Capacity</Label>
                <Input
                  id="capacity"
                  name="capacity"
                  type="number"
                  placeholder="5000"
                />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  placeholder="Describe the venue..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="contactEmail">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    name="contactEmail"
                    type="email"
                    placeholder="contact@venue.com"
                  />
                </div>
                <div>
                  <Label htmlFor="contactPhone">Contact Phone</Label>
                  <Input
                    id="contactPhone"
                    name="contactPhone"
                    type="tel"
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  name="website"
                  type="url"
                  placeholder="https://venue.com"
                />
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
                  defaultValue="ACTIVE"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={loading}>
                {loading ? "Creating..." : "Create Venue"}
              </Button>
              <Link href="/admin/venues">
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
