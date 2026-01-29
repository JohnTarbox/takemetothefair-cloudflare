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
  const [lookupResults, setLookupResults] = useState<{
    field: string; label: string; value: string; checked: boolean; currentValue: string;
  }[] | null>(null);
  const [googleData, setGoogleData] = useState<Record<string, string>>({});

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
      googlePlaceId: googleData.googlePlaceId || null,
      googleMapsUrl: googleData.googleMapsUrl || null,
      openingHours: googleData.openingHours || null,
      googleRating: googleData.googleRating ? parseFloat(googleData.googleRating) : null,
      googleRatingCount: googleData.googleRatingCount ? parseInt(googleData.googleRatingCount) : null,
      googleTypes: googleData.googleTypes || null,
      accessibility: googleData.accessibility || null,
      parking: googleData.parking || null,
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
        name: string | null;
        phone: string | null;
        website: string | null;
        lat: number | null;
        lng: number | null;
        address: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
        formattedAddress: string | null;
        photoUrl: string | null;
        googlePlaceId: string | null;
        googleMapsUrl: string | null;
        openingHours: string | null;
        googleRating: number | null;
        googleRatingCount: number | null;
        googleTypes: string | null;
        accessibility: string | null;
        parking: string | null;
        description: string | null;
        businessStatus: string | null;
        outdoorSeating: boolean | null;
      };
      const fieldMap: { field: string; label: string; value: string | null }[] = [
        { field: "name", label: "Name", value: result.name },
        { field: "address", label: "Address", value: result.address || result.formattedAddress },
        { field: "city", label: "City", value: result.city },
        { field: "state", label: "State", value: result.state },
        { field: "contactPhone", label: "Phone", value: result.phone },
        { field: "website", label: "Website", value: result.website },
        { field: "zip", label: "ZIP", value: result.zip },
        { field: "latitude", label: "Latitude", value: result.lat != null ? String(result.lat) : null },
        { field: "longitude", label: "Longitude", value: result.lng != null ? String(result.lng) : null },
        { field: "imageUrl", label: "Photo", value: result.photoUrl },
        { field: "description", label: "Description", value: result.description },
        { field: "googlePlaceId", label: "Google Place ID", value: result.googlePlaceId },
        { field: "googleMapsUrl", label: "Google Maps URL", value: result.googleMapsUrl },
        { field: "openingHours", label: "Opening Hours", value: result.openingHours },
        { field: "googleRating", label: "Rating", value: result.googleRating != null ? String(result.googleRating) : null },
        { field: "googleRatingCount", label: "Rating Count", value: result.googleRatingCount != null ? String(result.googleRatingCount) : null },
        { field: "googleTypes", label: "Types", value: result.googleTypes },
        { field: "accessibility", label: "Accessibility", value: result.accessibility },
        { field: "parking", label: "Parking", value: result.parking },
        { field: "businessStatus", label: "Business Status", value: result.businessStatus },
        { field: "outdoorSeating", label: "Outdoor Seating", value: result.outdoorSeating != null ? String(result.outdoorSeating) : null },
      ];
      const items = fieldMap.filter(f => f.value != null).map(f => {
        const input = document.getElementById(f.field) as HTMLInputElement;
        const currentValue = input?.value || "";
        return { field: f.field, label: f.label, value: f.value!, checked: !currentValue, currentValue };
      });
      if (items.length === 0) {
        setError("Lookup returned no data from Google.");
      } else {
        setLookupResults(items);
      }
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
                    {item.currentValue && (
                      <span className="block text-xs text-gray-500">Current: {item.currentValue}</span>
                    )}
                  </span>
                </label>
              ))}
              <div className="flex gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const newGoogleData: Record<string, string> = { ...googleData };
                    for (const item of lookupResults) {
                      if (!item.checked) continue;
                      const input = document.getElementById(item.field) as HTMLInputElement;
                      if (input) input.value = item.value;
                      const googleFields = ["googlePlaceId", "googleMapsUrl", "openingHours", "googleRating", "googleRatingCount", "googleTypes", "accessibility", "parking"];
                      if (googleFields.includes(item.field)) {
                        newGoogleData[item.field] = item.value;
                      }
                    }
                    setGoogleData(newGoogleData);
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

            {/* Google Places Data Section */}
            {Object.keys(googleData).length > 0 && (
              <div className="border-t pt-4 mt-4">
                <p className="text-sm font-medium text-gray-700 mb-3">Google Places Data</p>
                <div className="space-y-3">
                  {googleData.googlePlaceId && (
                    <div>
                      <Label htmlFor="googlePlaceId" className="text-xs text-gray-500">Place ID</Label>
                      <Input id="googlePlaceId" name="googlePlaceId" readOnly defaultValue={googleData.googlePlaceId} className="bg-gray-50 text-sm" />
                    </div>
                  )}
                  {googleData.googleMapsUrl && (
                    <div>
                      <Label htmlFor="googleMapsUrl" className="text-xs text-gray-500">Google Maps URL</Label>
                      <div className="flex gap-2">
                        <Input id="googleMapsUrl" name="googleMapsUrl" readOnly defaultValue={googleData.googleMapsUrl} className="bg-gray-50 text-sm" />
                        <a href={googleData.googleMapsUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 inline-flex items-center px-3 py-2 text-xs border rounded-md hover:bg-gray-50">Open</a>
                      </div>
                    </div>
                  )}
                  {(googleData.googleRating || googleData.googleRatingCount) && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="googleRating" className="text-xs text-gray-500">Rating</Label>
                        <Input id="googleRating" name="googleRating" readOnly defaultValue={googleData.googleRating ?? ""} className="bg-gray-50 text-sm" />
                      </div>
                      <div>
                        <Label htmlFor="googleRatingCount" className="text-xs text-gray-500">Rating Count</Label>
                        <Input id="googleRatingCount" name="googleRatingCount" readOnly defaultValue={googleData.googleRatingCount ?? ""} className="bg-gray-50 text-sm" />
                      </div>
                    </div>
                  )}
                  {googleData.googleTypes && (
                    <div>
                      <Label className="text-xs text-gray-500">Types</Label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(JSON.parse(googleData.googleTypes) as string[]).map((t: string) => (
                          <span key={t} className="px-2 py-0.5 bg-gray-100 rounded text-xs">{t.replace(/_/g, " ")}</span>
                        ))}
                      </div>

                    </div>
                  )}
                  {googleData.openingHours && (
                    <div>
                      <Label className="text-xs text-gray-500">Opening Hours</Label>
                      <div className="mt-1 text-sm bg-gray-50 rounded-md p-2 space-y-0.5">
                        {(() => {
                          try {
                            const hours = JSON.parse(googleData.openingHours) as { weekdayDescriptions?: string[] };
                            return hours.weekdayDescriptions?.map((d: string, i: number) => (
                              <div key={i} className="text-xs">{d}</div>
                            )) || <div className="text-xs text-gray-400">No schedule available</div>;
                          } catch { return <div className="text-xs text-gray-400">Invalid format</div>; }
                        })()}
                      </div>

                    </div>
                  )}
                  {googleData.accessibility && (
                    <div>
                      <Label className="text-xs text-gray-500">Accessibility</Label>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {Object.entries(JSON.parse(googleData.accessibility) as Record<string, boolean>)
                          .filter(([, v]) => v)
                          .map(([k]) => (
                            <span key={k} className="px-2 py-0.5 bg-green-50 text-green-700 rounded text-xs">
                              {k.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim()}
                            </span>
                          ))}
                      </div>

                    </div>
                  )}
                  {googleData.parking && (
                    <div>
                      <Label className="text-xs text-gray-500">Parking</Label>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {Object.entries(JSON.parse(googleData.parking) as Record<string, boolean>)
                          .filter(([, v]) => v)
                          .map(([k]) => (
                            <span key={k} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">
                              {k.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim()}
                            </span>
                          ))}
                      </div>

                    </div>
                  )}
                </div>
              </div>
            )}

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
