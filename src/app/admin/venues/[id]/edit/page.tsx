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
import { GooglePlaceSearch } from "@/components/google-place-search";
import type { PlaceLookupResult } from "@/lib/google-maps";

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
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  openingHours: string | null;
  googleRating: number | null;
  googleRatingCount: number | null;
  googleTypes: string | null;
  accessibility: string | null;
  parking: string | null;
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

  // Controlled form state
  const [formData, setFormData] = useState({
    name: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    latitude: "",
    longitude: "",
    capacity: "",
    description: "",
    contactEmail: "",
    contactPhone: "",
    website: "",
    imageUrl: "",
    status: "ACTIVE",
  });

  const [googleData, setGoogleData] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchVenue();
  }, [id]);

  const fetchVenue = async () => {
    try {
      const res = await fetch(`/api/admin/venues/${id}`);
      if (!res.ok) throw new Error("Venue not found");
      const data = (await res.json()) as Venue;
      setVenue(data);
      setFormData({
        name: data.name || "",
        address: data.address || "",
        city: data.city || "",
        state: data.state || "",
        zip: data.zip || "",
        latitude: data.latitude != null ? String(data.latitude) : "",
        longitude: data.longitude != null ? String(data.longitude) : "",
        capacity: data.capacity != null ? String(data.capacity) : "",
        description: data.description || "",
        contactEmail: data.contactEmail || "",
        contactPhone: data.contactPhone || "",
        website: data.website || "",
        imageUrl: data.imageUrl || "",
        status: data.status || "ACTIVE",
      });
      // Initialize google data from existing venue
      const existingGoogleData: Record<string, string> = {};
      if (data.googlePlaceId) existingGoogleData.googlePlaceId = data.googlePlaceId;
      if (data.googleMapsUrl) existingGoogleData.googleMapsUrl = data.googleMapsUrl;
      if (data.openingHours) existingGoogleData.openingHours = data.openingHours;
      if (data.googleRating != null) existingGoogleData.googleRating = String(data.googleRating);
      if (data.googleRatingCount != null)
        existingGoogleData.googleRatingCount = String(data.googleRatingCount);
      if (data.googleTypes) existingGoogleData.googleTypes = data.googleTypes;
      if (data.accessibility) existingGoogleData.accessibility = data.accessibility;
      if (data.parking) existingGoogleData.parking = data.parking;
      setGoogleData(existingGoogleData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load venue");
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handlePlaceSelect = (place: PlaceLookupResult) => {
    setFormData((prev) => ({
      ...prev,
      name: place.name || prev.name,
      address: place.address || place.formattedAddress || prev.address,
      city: place.city || prev.city,
      state: place.state || prev.state,
      zip: place.zip || prev.zip,
      latitude: place.lat != null ? String(place.lat) : prev.latitude,
      longitude: place.lng != null ? String(place.lng) : prev.longitude,
      contactPhone: place.phone || prev.contactPhone,
      website: place.website || prev.website,
      imageUrl: place.photoUrl || prev.imageUrl,
      description: place.description || prev.description,
    }));

    const newGoogleData: Record<string, string> = {};
    if (place.googlePlaceId) newGoogleData.googlePlaceId = place.googlePlaceId;
    if (place.googleMapsUrl) newGoogleData.googleMapsUrl = place.googleMapsUrl;
    if (place.openingHours) newGoogleData.openingHours = place.openingHours;
    if (place.googleRating != null) newGoogleData.googleRating = String(place.googleRating);
    if (place.googleRatingCount != null)
      newGoogleData.googleRatingCount = String(place.googleRatingCount);
    if (place.googleTypes) newGoogleData.googleTypes = place.googleTypes;
    if (place.accessibility) newGoogleData.accessibility = place.accessibility;
    if (place.parking) newGoogleData.parking = place.parking;
    if (place.businessStatus) newGoogleData.businessStatus = place.businessStatus;
    if (place.outdoorSeating != null) newGoogleData.outdoorSeating = String(place.outdoorSeating);
    setGoogleData(newGoogleData);
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setError("");

    const data = {
      name: formData.name,
      address: formData.address,
      city: formData.city,
      state: formData.state,
      zip: formData.zip,
      latitude: formData.latitude ? parseFloat(formData.latitude) : null,
      longitude: formData.longitude ? parseFloat(formData.longitude) : null,
      capacity: formData.capacity ? parseInt(formData.capacity) : null,
      contactEmail: formData.contactEmail || null,
      contactPhone: formData.contactPhone || null,
      website: formData.website || null,
      description: formData.description || null,
      imageUrl: formData.imageUrl || null,
      googlePlaceId: googleData.googlePlaceId || null,
      googleMapsUrl: googleData.googleMapsUrl || null,
      openingHours: googleData.openingHours || null,
      googleRating: googleData.googleRating ? parseFloat(googleData.googleRating) : null,
      googleRatingCount: googleData.googleRatingCount
        ? parseInt(googleData.googleRatingCount)
        : null,
      googleTypes: googleData.googleTypes || null,
      accessibility: googleData.accessibility || null,
      parking: googleData.parking || null,
      status: formData.status,
    };

    try {
      const res = await fetch(`/api/admin/venues/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = (await res.json()) as { error?: string };
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
      const res = await fetch("/api/admin/venues/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: formData.address,
          city: formData.city,
          state: formData.state,
          zip: formData.zip || undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Geocoding failed");
      }
      const result = (await res.json()) as { lat: number; lng: number; zip: string | null };
      setFormData((prev) => ({
        ...prev,
        latitude: String(result.lat),
        longitude: String(result.lng),
        zip: result.zip && !prev.zip ? result.zip : prev.zip,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Geocoding failed");
    } finally {
      setGeocoding(false);
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
          <CardTitle>Edit Venue</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search-first: Google Place Search */}
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm font-medium text-blue-900 mb-2">
              Re-link or update from Google Places
            </p>
            <GooglePlaceSearch
              onPlaceSelect={handlePlaceSelect}
              showUrlInput
              placeholder="Search for a venue name or address..."
            />
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Venue Name *</Label>
                <Input
                  id="name"
                  name="name"
                  required
                  value={formData.name}
                  onChange={handleChange}
                />
              </div>

              <div>
                <Label htmlFor="address">Address *</Label>
                <Input
                  id="address"
                  name="address"
                  required
                  value={formData.address}
                  onChange={handleChange}
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="city">City *</Label>
                  <Input
                    id="city"
                    name="city"
                    required
                    value={formData.city}
                    onChange={handleChange}
                  />
                </div>
                <div>
                  <Label htmlFor="state">State *</Label>
                  <Input
                    id="state"
                    name="state"
                    required
                    maxLength={2}
                    value={formData.state}
                    onChange={handleChange}
                  />
                </div>
                <div>
                  <Label htmlFor="zip">ZIP *</Label>
                  <Input
                    id="zip"
                    name="zip"
                    required
                    value={formData.zip}
                    onChange={handleChange}
                  />
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
                      value={formData.latitude}
                      onChange={handleChange}
                    />
                  </div>
                  <div>
                    <Label htmlFor="longitude">Longitude</Label>
                    <Input
                      id="longitude"
                      name="longitude"
                      type="number"
                      step="any"
                      value={formData.longitude}
                      onChange={handleChange}
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
                  value={formData.capacity}
                  onChange={handleChange}
                />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  value={formData.description}
                  onChange={handleChange}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="contactEmail">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    name="contactEmail"
                    type="email"
                    value={formData.contactEmail}
                    onChange={handleChange}
                  />
                </div>
                <div>
                  <Label htmlFor="contactPhone">Contact Phone</Label>
                  <Input
                    id="contactPhone"
                    name="contactPhone"
                    type="tel"
                    value={formData.contactPhone}
                    onChange={handleChange}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  name="website"
                  type="url"
                  value={formData.website}
                  onChange={handleChange}
                />
              </div>

              <div>
                <Label htmlFor="imageUrl">Image URL</Label>
                <Input
                  id="imageUrl"
                  name="imageUrl"
                  type="url"
                  value={formData.imageUrl}
                  onChange={handleChange}
                />
              </div>

              <div>
                <Label htmlFor="status">Status</Label>
                <select
                  id="status"
                  name="status"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={formData.status}
                  onChange={handleChange}
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
                      <Label className="text-xs text-gray-500">Place ID</Label>
                      <Input
                        readOnly
                        value={googleData.googlePlaceId}
                        className="bg-gray-50 text-sm"
                      />
                    </div>
                  )}
                  {googleData.googleMapsUrl && (
                    <div>
                      <Label className="text-xs text-gray-500">Google Maps URL</Label>
                      <div className="flex gap-2">
                        <Input
                          readOnly
                          value={googleData.googleMapsUrl}
                          className="bg-gray-50 text-sm"
                        />
                        <a
                          href={googleData.googleMapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 inline-flex items-center px-3 py-2 text-xs border rounded-md hover:bg-gray-50"
                        >
                          Open
                        </a>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs text-gray-500">Rating</Label>
                      <Input
                        readOnly
                        value={googleData.googleRating || ""}
                        className="bg-gray-50 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500">Rating Count</Label>
                      <Input
                        readOnly
                        value={googleData.googleRatingCount || ""}
                        className="bg-gray-50 text-sm"
                      />
                    </div>
                  </div>
                  {googleData.googleTypes && (
                    <div>
                      <Label className="text-xs text-gray-500">Types</Label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(() => {
                          try {
                            return (JSON.parse(googleData.googleTypes) as string[]).map(
                              (t: string) => (
                                <span key={t} className="px-2 py-0.5 bg-gray-100 rounded text-xs">
                                  {t.replace(/_/g, " ")}
                                </span>
                              )
                            );
                          } catch {
                            return null;
                          }
                        })()}
                      </div>
                    </div>
                  )}
                  {googleData.openingHours && (
                    <div>
                      <Label className="text-xs text-gray-500">Opening Hours</Label>
                      <div className="mt-1 text-sm bg-gray-50 rounded-md p-2 space-y-0.5">
                        {(() => {
                          try {
                            const hours = JSON.parse(googleData.openingHours) as {
                              weekdayDescriptions?: string[];
                            };
                            return (
                              hours.weekdayDescriptions?.map((d: string, i: number) => (
                                <div key={i} className="text-xs">
                                  {d}
                                </div>
                              )) || (
                                <div className="text-xs text-gray-400">No schedule available</div>
                              )
                            );
                          } catch {
                            return <div className="text-xs text-gray-400">Invalid format</div>;
                          }
                        })()}
                      </div>
                    </div>
                  )}
                  {googleData.accessibility && (
                    <div>
                      <Label className="text-xs text-gray-500">Accessibility</Label>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(() => {
                          try {
                            return Object.entries(
                              JSON.parse(googleData.accessibility) as Record<string, boolean>
                            )
                              .filter(([, v]) => v)
                              .map(([k]) => (
                                <span
                                  key={k}
                                  className="px-2 py-0.5 bg-green-50 text-green-700 rounded text-xs"
                                >
                                  {k
                                    .replace(/([A-Z])/g, " $1")
                                    .replace(/^./, (s) => s.toUpperCase())
                                    .trim()}
                                </span>
                              ));
                          } catch {
                            return null;
                          }
                        })()}
                      </div>
                    </div>
                  )}
                  {googleData.parking && (
                    <div>
                      <Label className="text-xs text-gray-500">Parking</Label>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(() => {
                          try {
                            return Object.entries(
                              JSON.parse(googleData.parking) as Record<string, boolean>
                            )
                              .filter(([, v]) => v)
                              .map(([k]) => (
                                <span
                                  key={k}
                                  className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs"
                                >
                                  {k
                                    .replace(/([A-Z])/g, " $1")
                                    .replace(/^./, (s) => s.toUpperCase())
                                    .trim()}
                                </span>
                              ));
                          } catch {
                            return null;
                          }
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

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
