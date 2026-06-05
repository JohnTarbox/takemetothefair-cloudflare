"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VendorEnhancedProfilePanel } from "@/components/admin/VendorEnhancedProfilePanel";
import { VendorLogoUpload } from "@/components/admin/VendorLogoUpload";

export const runtime = "edge";

interface Vendor {
  id: string;
  userId: string;
  businessName: string;
  slug: string;
  description: string | null;
  vendorType: string | null;
  website: string | null;
  logoUrl: string | null;
  verified: boolean;
  commercial: boolean;
  canSelfConfirm: boolean;
  // Contact Information
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // Physical Address
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  // Business Details
  yearEstablished: number | null;
  paymentMethods: string | null;
  licenseInfo: string | null;
  insuranceInfo: string | null;
  // Enhanced Profile (round-3) — read-only display + a child panel
  // mutates these via PATCH directly.
  enhancedProfile: boolean;
  enhancedProfileStartedAt: string | null;
  enhancedProfileExpiresAt: string | null;
  galleryImages: string;
  featuredPriority: number;
  // Claimed tier (drizzle/0049) — same panel grants/revokes via PATCH.
  claimed: boolean;
  claimedAt: string | null;
  // Verified Pro tier (drizzle/0052) — same pattern.
  verifiedPro: boolean;
  verifiedProAt: string | null;
  // EH1 hierarchy (drizzle/0106). Phase 4 surfaces these in the form;
  // API perimeter shipped in #341. Display resolution rule:
  // override_permitted && display_preference != 'INHERIT' → preference
  // else → parent.default_display. Pure function in
  // src/lib/vendor-hierarchy.ts.
  role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
  parentVendorId: string | null;
  defaultDisplay: "NATIONAL" | "LOCAL" | null;
  overridePermitted: boolean;
  displayPreference: "NATIONAL" | "LOCAL" | "INHERIT" | null;
}

export default function EditVendorPage() {
  const router = useRouter();
  const params = useParams();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [formData, setFormData] = useState({
    businessName: "",
    description: "",
    vendorType: "",
    website: "",
    verified: false,
    commercial: false,
    canSelfConfirm: false,
    // Contact Information
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    // Physical Address
    address: "",
    city: "",
    state: "",
    zip: "",
    // Business Details
    yearEstablished: "",
    paymentMethods: [] as string[],
    licenseInfo: "",
    insuranceInfo: "",
    // EH1 hierarchy fields. UI uses camelCase; submit handler maps them to
    // snake_case (role / parent_vendor_id / default_display / etc.) which
    // is what vendorUpdateSchema expects.
    role: "INDEPENDENT" as "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT",
    parentVendorId: "",
    defaultDisplay: "" as "" | "NATIONAL" | "LOCAL",
    overridePermitted: false,
    displayPreference: "" as "" | "NATIONAL" | "LOCAL" | "INHERIT",
  });

  useEffect(() => {
    if (params.id) {
      fetchVendor();
    }
  }, [params.id]);

  const fetchVendor = async () => {
    try {
      const res = await fetch(`/api/admin/vendors/${params.id}`);
      if (res.ok) {
        const data = (await res.json()) as Vendor;
        setVendor(data);
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
          businessName: data.businessName,
          description: data.description || "",
          vendorType: data.vendorType || "",
          website: data.website || "",
          verified: data.verified,
          commercial: data.commercial,
          canSelfConfirm: data.canSelfConfirm ?? false,
          // Contact Information
          contactName: data.contactName || "",
          contactEmail: data.contactEmail || "",
          contactPhone: data.contactPhone || "",
          // Physical Address
          address: data.address || "",
          city: data.city || "",
          state: data.state || "",
          zip: data.zip || "",
          // Business Details
          yearEstablished: data.yearEstablished?.toString() || "",
          paymentMethods,
          licenseInfo: data.licenseInfo || "",
          insuranceInfo: data.insuranceInfo || "",
          // EH1 hierarchy
          role: data.role ?? "INDEPENDENT",
          parentVendorId: data.parentVendorId ?? "",
          defaultDisplay: data.defaultDisplay ?? "",
          overridePermitted: data.overridePermitted ?? false,
          displayPreference: data.displayPreference ?? "",
        });
      }
    } catch (error) {
      console.error("Failed to fetch vendor:", error);
    } finally {
      setFetching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Transform form data for API. EH1 hierarchy fields are sent
      // snake_case because vendorUpdateSchema accepts snake_case for
      // these (mirroring the existing enhanced_profile / gallery_images
      // naming convention in that extend block); everything else stays
      // camelCase. Empty-string sentinels for the optional enums are
      // mapped to null so they don't fail Zod's enum gate.
      const {
        role,
        parentVendorId,
        defaultDisplay,
        overridePermitted,
        displayPreference,
        ...restFormData
      } = formData;
      const submitData = {
        ...restFormData,
        yearEstablished: formData.yearEstablished ? parseInt(formData.yearEstablished, 10) : null,
        role,
        parent_vendor_id: parentVendorId.trim() === "" ? null : parentVendorId.trim(),
        default_display: defaultDisplay === "" ? null : defaultDisplay,
        override_permitted: overridePermitted,
        display_preference: displayPreference === "" ? null : displayPreference,
      };

      const res = await fetch(`/api/admin/vendors/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitData),
      });

      if (res.ok) {
        router.push("/admin/vendors");
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "Failed to update vendor");
      }
    } catch (error) {
      console.error("Failed to update vendor:", error);
      alert("Failed to update vendor");
    } finally {
      setLoading(false);
    }
  };

  if (fetching) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/4"></div>
        <div className="h-64 bg-gray-200 rounded"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/vendors"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Vendors
        </Link>
      </div>

      {vendor && (
        <div className="mb-6 space-y-6">
          <VendorLogoUpload vendorId={vendor.id} currentLogoUrl={vendor.logoUrl} />
          <VendorEnhancedProfilePanel
            vendorId={vendor.id}
            enhancedProfile={vendor.enhancedProfile}
            enhancedProfileStartedAt={
              vendor.enhancedProfileStartedAt ? new Date(vendor.enhancedProfileStartedAt) : null
            }
            enhancedProfileExpiresAt={
              vendor.enhancedProfileExpiresAt ? new Date(vendor.enhancedProfileExpiresAt) : null
            }
            galleryImages={vendor.galleryImages || "[]"}
            slug={vendor.slug}
            featuredPriority={vendor.featuredPriority ?? 0}
            claimed={vendor.claimed ?? false}
            claimedAt={vendor.claimedAt ? new Date(vendor.claimedAt) : null}
            verifiedPro={vendor.verifiedPro ?? false}
            verifiedProAt={vendor.verifiedProAt ? new Date(vendor.verifiedProAt) : null}
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Edit Vendor</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="businessName">Business Name *</Label>
                <Input
                  id="businessName"
                  value={formData.businessName}
                  onChange={(e) => setFormData({ ...formData, businessName: e.target.value })}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="vendorType">Vendor Type</Label>
                <Input
                  id="vendorType"
                  value={formData.vendorType}
                  onChange={(e) => setFormData({ ...formData, vendorType: e.target.value })}
                  placeholder="e.g., Food, Crafts, Services"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  type="url"
                  value={formData.website}
                  onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                  placeholder="https://example.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={4}
              />
            </div>

            {/* Contact Information Section */}
            <div className="border-t pt-6">
              <h3 className="text-lg font-medium mb-4">Contact Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="contactName">Contact Name</Label>
                  <Input
                    id="contactName"
                    value={formData.contactName}
                    onChange={(e) => setFormData({ ...formData, contactName: e.target.value })}
                    placeholder="Primary contact person"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactEmail">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    type="email"
                    value={formData.contactEmail}
                    onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })}
                    placeholder="contact@business.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactPhone">Contact Phone</Label>
                  <Input
                    id="contactPhone"
                    type="tel"
                    value={formData.contactPhone}
                    onChange={(e) => setFormData({ ...formData, contactPhone: e.target.value })}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
            </div>

            {/* Physical Address Section */}
            <div className="border-t pt-6">
              <h3 className="text-lg font-medium mb-4">Physical Address</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="address">Street Address</Label>
                  <Input
                    id="address"
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    placeholder="123 Main Street"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="state">State</Label>
                    <Input
                      id="state"
                      value={formData.state}
                      onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                      placeholder="ME"
                      maxLength={2}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="zip">ZIP Code</Label>
                    <Input
                      id="zip"
                      value={formData.zip}
                      onChange={(e) => setFormData({ ...formData, zip: e.target.value })}
                      placeholder="04101"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Business Details Section */}
            <div className="border-t pt-6">
              <h3 className="text-lg font-medium mb-4">Business Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="yearEstablished">Year Established</Label>
                  <Input
                    id="yearEstablished"
                    type="number"
                    value={formData.yearEstablished}
                    onChange={(e) => setFormData({ ...formData, yearEstablished: e.target.value })}
                    placeholder="2020"
                    min={1800}
                    max={new Date().getFullYear()}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="paymentMethods">Payment Methods</Label>
                  <Input
                    id="paymentMethods"
                    value={formData.paymentMethods.join(", ")}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        paymentMethods: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="Cash, Credit, Venmo"
                  />
                  <p className="text-xs text-gray-500">Separate with commas</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="licenseInfo">License/Permit Info</Label>
                  <Input
                    id="licenseInfo"
                    value={formData.licenseInfo}
                    onChange={(e) => setFormData({ ...formData, licenseInfo: e.target.value })}
                    placeholder="License number or details"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insuranceInfo">Insurance Info</Label>
                  <Input
                    id="insuranceInfo"
                    value={formData.insuranceInfo}
                    onChange={(e) => setFormData({ ...formData, insuranceInfo: e.target.value })}
                    placeholder="Insurance details"
                  />
                </div>
              </div>
            </div>

            {/* EH1 Vendor Hierarchy Section (Phase 4) — exposes the 5
                national-brand / local-office columns. Most vendors are
                INDEPENDENT and only see the role select; the other
                fields conditionally appear based on the chosen role. */}
            <div className="border-t pt-6">
              <h3 className="text-lg font-medium mb-4">Vendor Hierarchy</h3>
              <p className="text-sm text-gray-600 mb-4">
                Most vendors are <strong>Independent</strong>. Use <strong>National</strong> for
                parent brands (e.g. LeafFilter HQ) and <strong>Local Office</strong> for franchise /
                regional offices that should show under a national parent.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="role">Role</Label>
                  <select
                    id="role"
                    value={formData.role}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        role: e.target.value as Vendor["role"],
                      })
                    }
                    className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
                  >
                    <option value="INDEPENDENT">Independent (default)</option>
                    <option value="NATIONAL">National (parent brand)</option>
                    <option value="LOCAL_OFFICE">Local Office (under a parent)</option>
                  </select>
                </div>

                {/* Parent picker — only for LOCAL_OFFICE. ID input rather
                    than a search picker for now (only ~2 NATIONAL parents
                    today; pasting the id from /admin/vendors is fine).
                    Phase 5 can upgrade to a typeahead. */}
                {formData.role === "LOCAL_OFFICE" && (
                  <div className="space-y-2">
                    <Label htmlFor="parentVendorId">Parent Vendor ID</Label>
                    <Input
                      id="parentVendorId"
                      value={formData.parentVendorId}
                      onChange={(e) => setFormData({ ...formData, parentVendorId: e.target.value })}
                      placeholder="UUID of the NATIONAL parent vendor"
                    />
                    <p className="text-xs text-gray-500">
                      Look up the NATIONAL parent at <code>/admin/vendors</code> and paste its{" "}
                      <code>id</code> here.
                    </p>
                  </div>
                )}

                {/* Default display — only for NATIONAL. Decides what the
                    public sees when a child has NO override (the common
                    case). LOCAL means franchise pages surface; NATIONAL
                    means franchise pages canonical-up to the hub. */}
                {formData.role === "NATIONAL" && (
                  <div className="space-y-2">
                    <Label htmlFor="defaultDisplay">Default Display (for children)</Label>
                    <select
                      id="defaultDisplay"
                      value={formData.defaultDisplay}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          defaultDisplay: e.target.value as "" | "NATIONAL" | "LOCAL",
                        })
                      }
                      className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
                    >
                      <option value="">— Unset —</option>
                      <option value="LOCAL">LOCAL (children pages indexed)</option>
                      <option value="NATIONAL">NATIONAL (children canonical-up to this hub)</option>
                    </select>
                  </div>
                )}

                {/* Override gate — only meaningful on LOCAL_OFFICE. Default
                    OFF: child can REQUEST a preference but the parent's
                    default_display wins. Flip ON to grant the child its
                    self-selected display. */}
                {formData.role === "LOCAL_OFFICE" && (
                  <div className="space-y-2">
                    <Label htmlFor="overridePermitted">Override Permitted (gate)</Label>
                    <div className="flex items-center gap-2 pt-2">
                      <input
                        type="checkbox"
                        id="overridePermitted"
                        checked={formData.overridePermitted}
                        onChange={(e) =>
                          setFormData({ ...formData, overridePermitted: e.target.checked })
                        }
                        className="rounded border-gray-300"
                      />
                      <span className="text-sm text-gray-600">
                        Let this office&apos;s preference override the parent&apos;s default
                      </span>
                    </div>
                  </div>
                )}

                {/* Child preference — only meaningful on LOCAL_OFFICE.
                    INHERIT = fall through to parent's default_display.
                    Setting NATIONAL or LOCAL here only takes effect when
                    override_permitted is ON. */}
                {formData.role === "LOCAL_OFFICE" && (
                  <div className="space-y-2">
                    <Label htmlFor="displayPreference">Display Preference</Label>
                    <select
                      id="displayPreference"
                      value={formData.displayPreference}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          displayPreference: e.target.value as
                            | ""
                            | "NATIONAL"
                            | "LOCAL"
                            | "INHERIT",
                        })
                      }
                      className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
                    >
                      <option value="">— Unset —</option>
                      <option value="INHERIT">INHERIT (fall through to parent)</option>
                      <option value="LOCAL">
                        LOCAL (this office&apos;s page is the canonical)
                      </option>
                      <option value="NATIONAL">NATIONAL (canonical-up to parent hub)</option>
                    </select>
                    <p className="text-xs text-gray-500">
                      Only takes effect when the parent grants <em>Override Permitted</em>.
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4 border-t pt-6">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="verified"
                  checked={formData.verified}
                  onChange={(e) => setFormData({ ...formData, verified: e.target.checked })}
                  className="rounded border-gray-300"
                />
                <Label htmlFor="verified">Verified Vendor</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="commercial"
                  checked={formData.commercial}
                  onChange={(e) => setFormData({ ...formData, commercial: e.target.checked })}
                  className="rounded border-gray-300"
                />
                <Label htmlFor="commercial">Commercial Vendor</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="canSelfConfirm"
                  checked={formData.canSelfConfirm}
                  onChange={(e) => setFormData({ ...formData, canSelfConfirm: e.target.checked })}
                  className="rounded border-gray-300"
                />
                <div>
                  <Label htmlFor="canSelfConfirm">Can Self-Confirm Events</Label>
                  <p className="text-xs text-gray-500">
                    Vendor can confirm participation without admin approval
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={loading}>
                {loading ? "Saving..." : "Save Changes"}
              </Button>
              <Link href="/admin/vendors">
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
