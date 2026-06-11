"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GooglePlaceSearch } from "@/components/google-place-search";
import type { PlaceLookupResult } from "@/lib/google-maps";
import { WelcomeBanner } from "@/components/onboarding/welcome-banner";
import { useAutosave, formatSavedAgo } from "@/lib/hooks/use-autosave";
import { VendorClaimWidget } from "@/components/vendor/claim-widget";

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
  claimed: boolean;
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
  // A5 vendor hierarchy display controls (read state for gating the UI).
  // `displayName` is a benign public alias; `displayMode` is editable only by
  // LOCAL_OFFICE rows and only *honored* publicly when the brand has granted
  // `displayOverridePermitted` (resolved in displayVendorName at render).
  displayName: string | null;
  displayMode: "inherit" | "self" | "brand_parent" | "operator_parent" | "both" | null;
  role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT" | null;
  displayOverridePermitted: boolean | null;
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
    // A5 — editable hierarchy display fields. "" means unset; buildPayload
    // maps displayName "" → null (clear) and omits displayMode when "" so a
    // non-LOCAL_OFFICE save never trips the route's displayMode role gate.
    displayName: "",
    displayMode: "",
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
          // A5 — "" sentinel for unset; displayMode "" === "inherit/none".
          displayName: data.displayName || "",
          displayMode: data.displayMode || "",
        });
      }
    } catch (error) {
      console.error("Failed to fetch profile:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
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

  const buildPayload = (form: typeof formData) => {
    const { displayMode, displayName, ...rest } = form;
    return {
      ...rest,
      products: form.products
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      paymentMethods: form.paymentMethods
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      yearEstablished: form.yearEstablished ? parseInt(form.yearEstablished, 10) : null,
      // A5 — empty display name clears the alias (→ business_name at render).
      displayName: displayName.trim() ? displayName.trim() : null,
      // A5 — only send displayMode when the office actually picked one. Sending
      // null/"" for a non-LOCAL_OFFICE vendor would trip the route's role gate
      // (400); `undefined` is dropped by JSON.stringify so the field is omitted.
      ...(displayMode ? { displayMode } : {}),
    };
  };

  // Serialize formData to a string for stable comparison — the form has
  // nested primitive fields only, so JSON is fine and cheap.
  const serialized = useMemo(() => JSON.stringify(formData), [formData]);

  const autosave = useAutosave({
    value: serialized,
    enabled: !loading && !!profile,
    debounceMs: 3000,
    onSave: async (_value, signal) => {
      const res = await fetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(formData)),
        signal,
      });
      if (!res.ok) {
        throw new Error("Could not autosave profile");
      }
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");

    try {
      const res = await fetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(formData)),
      });

      if (res.ok) {
        setMessage("Profile updated successfully");
        fetchProfile();
      } else {
        // Surface the server's actual error so we don't paper over the
        // real reason with a generic "Failed to update profile". The
        // route returns either {error: "email_unverified", message, verifyUrl}
        // (403) or {error: "field: msg, ..."} (validation 400) or a
        // plain {error: string}. Fall back to the generic message only
        // if the body isn't parseable.
        try {
          const body = (await res.json()) as {
            error?: string;
            message?: string;
            verifyUrl?: string;
          };
          if (body.error === "email_unverified") {
            setMessage(
              body.message ||
                "Please verify your email before saving changes. Check your inbox for the verification link, or request a new one from your dashboard banner."
            );
          } else if (body.message) {
            setMessage(body.message);
          } else if (body.error) {
            setMessage(body.error);
          } else {
            setMessage("Failed to update profile");
          }
        } catch {
          setMessage("Failed to update profile");
        }
      }
    } catch {
      setMessage("An error occurred");
    } finally {
      setSaving(false);
    }
  };

  const savedAgo = formatSavedAgo(autosave.lastSavedAt);

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-muted rounded w-1/4"></div>
        <div className="h-64 bg-muted rounded"></div>
      </div>
    );
  }

  if (!profile) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">No vendor profile found. Please contact support.</p>
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
      <VendorClaimWidget
        claimed={profile.claimed}
        vendorId={profile.id}
        vendorContactEmail={profile.contactEmail}
        vendorSlug={profile.slug}
        onClaimed={() => setProfile((p) => (p ? { ...p, claimed: true } : p))}
      />
      <div className="flex items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Vendor Profile</h1>
          <p className="mt-1 text-muted-foreground">Manage your business information</p>
          <p className="mt-1 text-sm text-muted-foreground">
            New here?{" "}
            <Link href="/vendor-guide" className="font-medium text-royal hover:text-navy underline">
              Read the Vendor Guide
            </Link>{" "}
            for a walkthrough of editing your profile and applying to events.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {autosave.status === "saving" && <span className="text-stone-600">Saving…</span>}
          {autosave.status === "saved" && savedAgo && (
            <span className="text-sage-700">Draft saved {savedAgo}</span>
          )}
          {autosave.status === "error" && (
            <span className="text-red-600">Autosave failed — use Save</span>
          )}
          {profile.verified && <Badge variant="success">Verified</Badge>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-foreground">Business Information</h2>
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

            {/* A5 — public display-name alias (any vendor). Distinct from the
                legal Business Name; render resolves COALESCE(displayName,
                businessName). */}
            <div>
              <Input
                label="Public Display Name (optional)"
                name="displayName"
                value={formData.displayName}
                onChange={handleChange}
                placeholder="Shown publicly instead of your business name"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Appears on your public listing in place of your legal business name. Leave blank to
                show “{formData.businessName || "your business name"}”.
              </p>
            </div>

            {/* A5 — displayMode: editable only by LOCAL_OFFICE rows. The choice
                is a *preference*; it's only honored publicly once the brand
                grants display override (displayOverridePermitted), enforced at
                render in displayVendorName. We surface that gate state here so
                the office knows whether the setting is live or pending. */}
            {profile?.role === "LOCAL_OFFICE" && (
              <div>
                <label
                  htmlFor="displayMode"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  Public Display (local office)
                </label>
                <select
                  id="displayMode"
                  name="displayMode"
                  value={formData.displayMode}
                  onChange={handleChange}
                  className="block w-full rounded-lg border border-border px-3 py-2 text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">Use brand default</option>
                  <option value="self">Show this office’s own name</option>
                  <option value="brand_parent">Show the brand’s name</option>
                  <option value="operator_parent">Show the operating company’s name</option>
                  <option value="both">Show both (office — brand)</option>
                </select>
                {formData.displayMode && formData.displayMode !== "inherit" ? (
                  profile?.displayOverridePermitted ? (
                    <p className="mt-1 text-xs text-green-700">
                      Active — your brand has granted display override, so this preference shows on
                      your public listing.
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-amber-700">
                      Saved, but not yet live: your brand hasn’t granted display override, so the
                      brand’s default is shown publicly until they do.
                    </p>
                  )
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your listing follows the brand’s default display.
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Description</label>
              <textarea
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={4}
                className="block w-full rounded-lg border border-border px-3 py-2 text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
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
              <h3 className="text-lg font-medium text-foreground mb-4">Contact Information</h3>
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
                <h3 className="text-lg font-medium text-foreground">Physical Address</h3>
                <button
                  type="button"
                  onClick={() => setShowGoogleLookup(!showGoogleLookup)}
                  className="text-sm text-royal hover:text-navy-dark"
                >
                  {showGoogleLookup ? "Hide" : "Find my business on Google"}
                </button>
              </div>
              {showGoogleLookup && (
                <div className="mb-4 p-3 bg-info-soft border border-info-soft rounded-lg">
                  <p className="text-xs text-navy mb-2">
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
                  <p className="text-xs text-muted-foreground mt-2">
                    Coordinates: {formData.latitude.toFixed(4)}, {formData.longitude.toFixed(4)}{" "}
                    (auto-detected from address)
                  </p>
                )}
              </div>
            </div>

            {/* Business Details Section */}
            <div className="border-t pt-6 mt-6">
              <h3 className="text-lg font-medium text-foreground mb-4">Business Details</h3>
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
                    <p className="text-xs text-muted-foreground mt-1">Separate with commas</p>
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
