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
  address: string;
  city: string;
  state: string;
  zip: string;
  latitude: number | null;
  longitude: number | null;
  capacity: number | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  description: string | null;
  imageUrl: string | null;
  status: string;
}

export default function EditVenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [venue, setVenue] = useState<Venue | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [geocoding, setGeocoding] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResults, setLookupResults] = useState<{
    field: string; label: string; value: string; checked: boolean;
  }[] | null>(null);

  useEffect(() => {
    fetchVenue();
  }, [id]);

  const fetchVenue = async () => {
    try {
      const res = await fetch(`/api/admin/venues/${id}`);
      if (!res.ok) throw new Error("Venue not found");
      const data = await res.json() as Venue;
      setVenue(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load venue");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
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
      status: formData.get("status"),
    };

    try {
      const res = await fetch(`/api/admin/venues/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = await res.json() as { error?: string };
        throw new Error(result.error || "Failed to update venue");
      }

      router.push("/admin/venues");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update venue");
    } finally {
      setSaving(false);
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
      const fieldMap: { field: string; label: string; value: string | null }[] = [
        { field: "contactPhone", label: "Phone", value: result.phone },
        { field: "website", label: "Website", value: result.website },
        { field: "zip", label: "ZIP", value: result.zip },
        { field: "latitude", label: "Latitude", value: result.lat != null ? String(result.lat) : null },
        { field: "longitude", label: "Longitude", value: result.lng != null ? String(result.lng) : null },
        { field: "imageUrl", label: "Photo", value: result.photoUrl },
      ];
      const applicable = fieldMap.filter(f => {
        if (!f.value) return false;
        const input = document.getElementById(f.field) as HTMLInputElement;
        return !input?.value;
      }).map(f => ({ field: f.field, label: f.label, value: f.value!, checked: true }));
      if (applicable.length === 0) {
        setError("Lookup returned no new data for empty fields.");
      } else {
        setLookupResults(applicable);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLookingUp(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/4"></div>
        <div className="h-96 bg-gray-200 rounded"></div>
      </div>
    );
  }

  if (!venue) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Venue not found</p>
        <Link href="/admin/venues" className="text-blue-600 hover:underline mt-2 inline-block">
          Back to Venues
        </Link>
      </div>
    );
  }

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
            <CardTitle>Edit Venue</CardTitle>
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

          {lookupResults && (
            <div className="mb-4 p-4 border rounded-md bg-blue-50 space-y-3">
              <p className="font-medium text-sm">Google Lookup Results</p>
              {lookupResults.map((item, i) => (
                <label key={item.field} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={() => {
                      setLookupResults(prev => prev!.map((r, j) => j === i ? { ...r, checked: !r.checked } : r));
                    }}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="font-medium">{item.label}:</span>{" "}
                    {item.field === "imageUrl" ? (
                      <span className="block">
                        <img src={item.value} alt="Preview" className="mt-1 max-h-24 rounded" />
                        <span className="text-xs text-gray-500 break-all">{item.value}</span>
                      </span>
                    ) : (
                      <span>{item.value}</span>
                    )}
                  </span>
                </label>
              ))}
              <div className="flex gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    for (const item of lookupResults) {
                      if (!item.checked) continue;
                      const input = document.getElementById(item.field) as HTMLInputElement;
                      if (input) input.value = item.value;
                    }
                    setLookupResults(null);
                  }}
                >
                  Apply Selected
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setLookupResults(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Venue Name *</Label>
                <Input id="name" name="name" required defaultValue={venue.name} />
              </div>

              <div>
                <Label htmlFor="address">Address *</Label>
                <Input id="address" name="address" required defaultValue={venue.address} />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="city">City *</Label>
                  <Input id="city" name="city" required defaultValue={venue.city} />
                </div>
                <div>
                  <Label htmlFor="state">State *</Label>
                  <Input id="state" name="state" required maxLength={2} defaultValue={venue.state} />
                </div>
                <div>
                  <Label htmlFor="zip">ZIP *</Label>
                  <Input id="zip" name="zip" required defaultValue={venue.zip} />
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
                      defaultValue={venue.latitude ?? ""}
                    />
                  </div>
                  <div>
                    <Label htmlFor="longitude">Longitude</Label>
                    <Input
                      id="longitude"
                      name="longitude"
                      type="number"
                      step="any"
                      defaultValue={venue.longitude ?? ""}
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
                  defaultValue={venue.capacity ?? ""}
                />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  defaultValue={venue.description ?? ""}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="contactEmail">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    name="contactEmail"
                    type="email"
                    defaultValue={venue.contactEmail ?? ""}
                  />
                </div>
                <div>
                  <Label htmlFor="contactPhone">Contact Phone</Label>
                  <Input
                    id="contactPhone"
                    name="contactPhone"
                    type="tel"
                    defaultValue={venue.contactPhone ?? ""}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  name="website"
                  type="url"
                  defaultValue={venue.website ?? ""}
                />
              </div>

              <div>
                <Label htmlFor="imageUrl">Image URL</Label>
                <Input
                  id="imageUrl"
                  name="imageUrl"
                  type="url"
                  defaultValue={venue.imageUrl ?? ""}
                />
              </div>

              <div>
                <Label htmlFor="status">Status</Label>
                <select
                  id="status"
                  name="status"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  defaultValue={venue.status}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
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
