"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GooglePlaceSearch } from "@/components/google-place-search";
import type { PlaceLookupResult } from "@/lib/google-maps";
import { WelcomeBanner } from "@/components/onboarding/welcome-banner";

export const runtime = "edge";

interface VendorProfile {
  id: string;
  businessName: string;
  slug: string;
  description: string | null;
  vendorType: string | null;
  products: string[];
  website: string | null;
  logoUrl: string | null;
  verified: boolean;
  // Contact Information
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // Physical Address
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  // Business Details
  yearEstablished: number | null;
  paymentMethods: string | null;
  licenseInfo: string | null;
  insuranceInfo: string | null;
}

export default function VendorProfilePage() {
  const [profile, setProfile] = useState<VendorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [showGoogleLookup, setShowGoogleLookup] = useState(false);
  const [formData, setFormData] = useState({
    businessName: "",
    description: "",
    vendorType: "",
    products: "",
    website: "",
    logoUrl: "",
    // Contact Information
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    // Physical Address
    address: "",
    city: "",
    state: "",
    zip: "",
    latitude: null as number | null,
    longitude: null as number | null,
    // Business Details
    yearEstablished: "",
    paymentMethods: "",
    licenseInfo: "",
    insuranceInfo: "",
  });

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      const res = await fetch("/api/vendor/profile");
      if (res.ok) {
        const data = (await res.json()) as VendorProfile;
        setProfile(data);
        // Parse paymentMethods from JSON string
        let paymentMethods: string[] = [];
        try {
          if (data.paymentMethods) {
            paymentMethods = JSON.parse(data.paymentMethods);
          }
        } catch {
          paymentMethods = [];
        }

        setFormData({
          businessName: data.businessName || "",
          description: data.description || "",
          vendorType: data.vendorType || "",
          products: data.products?.join(", ") || "",
          website: data.website || "",
          logoUrl: data.logoUrl || "",
          // Contact Information
          contactName: data.contactName || "",
          contactEmail: data.contactEmail || "",
          contactPhone: data.contactPhone || "",
          // Physical Address
          address: data.address || "",
          city: data.city || "",
          state: data.state || "",
          zip: data.zip || "",
          latitude: data.latitude,
          longitude: data.longitude,
          // Business Details
          yearEstablished: data.yearEstablished?.toString() || "",
          paymentMethods: paymentMethods.join(", "),
          licenseInfo: data.licenseInfo || "",
          insuranceInfo: data.insuranceInfo || "",
        });
      }
    } catch (error) {
      console.error("Failed to fetch profile:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleGooglePlaceSelect = (place: PlaceLookupResult) => {
    setFormData((prev) => ({
      ...prev,
      address: place.address || place.formattedAddress || prev.address,
      city: place.city || prev.city,
      state: place.state || prev.state,
      zip: place.zip || prev.zip,
      latitude: place.lat ?? prev.latitude,
      longitude: place.lng ?? prev.longitude,
      website: place.website || prev.website,
      contactPhone: place.phone || prev.contactPhone,
      description: place.description || prev.description,
    }));
    setShowGoogleLookup(false);
    setMessage("Address auto-filled from Google. Review and save changes.");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");

    try {
      const res = await fetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          products: formData.products
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
          paymentMethods: formData.paymentMethods
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
          yearEstablished: formData.yearEstablished ? parseInt(formData.yearEstablished, 10) : null,
        }),
      });

      if (res.ok) {
        setMessage("Profile updated successfully");
        fetchProfile();
      } else {
        setMessage("Failed to update profile");
      }
    } catch {
      setMessage("An error occurred");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/4"></div>
        <div className="h-64 bg-gray-200 rounded"></div>
      </div>
    );
  }

  if (!profile) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-gray-500">No vendor profile found. Please contact support.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-2xl">
      <WelcomeBanner
        storageKey="mmatf.welcome.vendor"
        title="Welcome to Meet Me at the Fair!"
        body="Complete your vendor profile below so promoters have what they need to approve your event applications."
      />
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Vendor Profile</h1>
          <p className="mt-1 text-gray-600">Manage your business information</p>
        </div>
        {profile.verified && <Badge variant="success">Verified</Badge>}
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Business Information</h2>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {message && (
              <div
                className={`p-3 rounded-lg text-sm ${
                  message.includes("success")
                    ? "bg-green-50 text-green-700"
                    : "bg-red-50 text-red-600"
                }`}
              >
                {message}
              </div>
            )}

            <Input
              label="Business Name"
              name="businessName"
              value={formData.businessName}
              onChange={handleChange}
              required
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={4}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Tell us about your business..."
              />
            </div>

            <Input
              label="Vendor Type"
              name="vendorType"
              value={formData.vendorType}
              onChange={handleChange}
              placeholder="e.g., Food, Arts & Crafts, Jewelry"
            />

            <Input
              label="Products/Services (comma-separated)"
              name="products"
              value={formData.products}
              onChange={handleChange}
              placeholder="e.g., Pottery, Jewelry, Woodwork"
            />

            <Input
              label="Website"
              type="url"
              name="website"
              value={formData.website}
              onChange={handleChange}
              placeholder="https://..."
            />

            <Input
              label="Logo URL"
              type="url"
              name="logoUrl"
              value={formData.logoUrl}
              onChange={handleChange}
              placeholder="https://..."
            />

            {/* Contact Information Section */}
            <div className="border-t pt-6 mt-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Contact Information</h3>
              <div className="space-y-4">
                <Input
                  label="Contact Name"
                  name="contactName"
                  value={formData.contactName}
                  onChange={handleChange}
                  placeholder="Primary contact person"
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                    label="Contact Email"
                    type="email"
                    name="contactEmail"
                    value={formData.contactEmail}
                    onChange={handleChange}
                    placeholder="contact@business.com"
                  />
                  <Input
                    label="Contact Phone"
                    type="tel"
                    name="contactPhone"
                    value={formData.contactPhone}
                    onChange={handleChange}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
            </div>

            {/* Physical Address Section */}
            <div className="border-t pt-6 mt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Physical Address</h3>
                <button
                  type="button"
                  onClick={() => setShowGoogleLookup(!showGoogleLookup)}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  {showGoogleLookup ? "Hide" : "Find my business on Google"}
                </button>
              </div>
              {showGoogleLookup && (
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-xs text-blue-700 mb-2">
                    Search for your business to auto-fill address and contact info
                  </p>
                  <GooglePlaceSearch
                    onPlaceSelect={handleGooglePlaceSelect}
                    placeholder="Search for your business name..."
                  />
                </div>
              )}
              <div className="space-y-4">
                <Input
                  label="Street Address"
                  name="address"
                  value={formData.address}
                  onChange={handleChange}
                  placeholder="123 Main Street"
                />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="col-span-2">
                    <Input label="City" name="city" value={formData.city} onChange={handleChange} />
                  </div>
                  <Input
                    label="State"
                    name="state"
                    value={formData.state}
                    onChange={handleChange}
                    placeholder="ME"
                    maxLength={2}
                  />
                  <Input
                    label="ZIP Code"
                    name="zip"
                    value={formData.zip}
                    onChange={handleChange}
                    placeholder="04101"
                  />
                </div>
                {formData.latitude && formData.longitude && (
                  <p className="text-xs text-gray-500 mt-2">
                    Coordinates: {formData.latitude.toFixed(4)}, {formData.longitude.toFixed(4)}{" "}
                    (auto-detected from address)
                  </p>
                )}
              </div>
            </div>

            {/* Business Details Section */}
            <div className="border-t pt-6 mt-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Business Details</h3>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                    label="Year Established"
                    type="number"
                    name="yearEstablished"
                    value={formData.yearEstablished}
                    onChange={handleChange}
                    placeholder="2020"
                    min={1800}
                    max={new Date().getFullYear()}
                  />
                  <div>
                    <Input
                      label="Payment Methods"
                      name="paymentMethods"
                      value={formData.paymentMethods}
                      onChange={handleChange}
                      placeholder="Cash, Credit, Venmo"
                    />
                    <p className="text-xs text-gray-500 mt-1">Separate with commas</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                    label="License/Permit Info"
                    name="licenseInfo"
                    value={formData.licenseInfo}
                    onChange={handleChange}
                    placeholder="License number or details"
                  />
                  <Input
                    label="Insurance Info"
                    name="insuranceInfo"
                    value={formData.insuranceInfo}
                    onChange={handleChange}
                    placeholder="Insurance details"
                  />
                </div>
              </div>
            </div>

            <div className="pt-6">
              <Button type="submit" isLoading={saving} disabled={saving}>
                Save Changes
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
