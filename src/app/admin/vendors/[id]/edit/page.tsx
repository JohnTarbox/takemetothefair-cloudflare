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
import { FocalPointPicker } from "@/components/admin/FocalPointPicker";

interface Vendor {
  id: string;
  userId: string;
  businessName: string;
  slug: string;
  description: string | null;
  vendorType: string | null;
  website: string | null;
  logoUrl: string | null;
  imageFocalX?: number;
  imageFocalY?: number;
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
  // EH1 hierarchy (drizzle/0106 + 0107). Phase 1 full relationship model.
  // Display resolution rule:
  //   override permitted + mode != 'inherit' → mode wins
  //   else → parent.defaultChildDisplay
  // Pure function in src/lib/vendor-hierarchy.ts.
  role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
  brandParentVendorId: string | null;
  operatorParentVendorId: string | null;
  aliasOfVendorId: string | null;
  relationshipType:
    | "branch"
    | "franchise"
    | "dealer"
    | "member"
    | "agent"
    | "employee_branch"
    | "government"
    | "independent";
  defaultChildDisplay: "self" | "brand_parent" | "both" | null;
  displayOverridePermitted: boolean;
  displayMode: "inherit" | "self" | "brand_parent" | "operator_parent" | "both" | null;
}

export default function EditVendorPage() {
  const router = useRouter();
  const params = useParams();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [vendor, setVendor] = useState<Vendor | null>(null);
  // IMG1 §1b Phase 1 — focal-point state for the logo. Read-only re:
  // the URL itself (VendorLogoUpload owns that flow); the picker uses
  // vendor.logoUrl which was loaded from the API on mount.
  const [imageFocalX, setImageFocalX] = useState<number>(0.5);
  const [imageFocalY, setImageFocalY] = useState<number>(0.5);
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
    // EH1 hierarchy fields. UI uses camelCase; submit handler maps them
    // to snake_case (matching vendorUpdateSchema's input shape). Empty
    // strings are sentinels for "unset" and get mapped to null at submit
    // time so Zod's nullable-enum check passes.
    role: "INDEPENDENT" as "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT",
    brandParentVendorId: "",
    operatorParentVendorId: "",
    aliasOfVendorId: "",
    relationshipType: "independent" as
      | "branch"
      | "franchise"
      | "dealer"
      | "member"
      | "agent"
      | "employee_branch"
      | "government"
      | "independent",
    defaultChildDisplay: "" as "" | "self" | "brand_parent" | "both",
    displayOverridePermitted: false,
    displayMode: "" as "" | "inherit" | "self" | "brand_parent" | "operator_parent" | "both",
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

        setImageFocalX(typeof data.imageFocalX === "number" ? data.imageFocalX : 0.5);
        setImageFocalY(typeof data.imageFocalY === "number" ? data.imageFocalY : 0.5);
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
          brandParentVendorId: data.brandParentVendorId ?? "",
          operatorParentVendorId: data.operatorParentVendorId ?? "",
          aliasOfVendorId: data.aliasOfVendorId ?? "",
          relationshipType: data.relationshipType ?? "independent",
          defaultChildDisplay: data.defaultChildDisplay ?? "",
          displayOverridePermitted: data.displayOverridePermitted ?? false,
          displayMode: data.displayMode ?? "",
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
        brandParentVendorId,
        operatorParentVendorId,
        aliasOfVendorId,
        relationshipType,
        defaultChildDisplay,
        displayOverridePermitted,
        displayMode,
        ...restFormData
      } = formData;
      const submitData = {
        ...restFormData,
        imageFocalX,
        imageFocalY,
        yearEstablished: formData.yearEstablished ? parseInt(formData.yearEstablished, 10) : null,
        role,
        brand_parent_vendor_id:
          brandParentVendorId.trim() === "" ? null : brandParentVendorId.trim(),
        operator_parent_vendor_id:
          operatorParentVendorId.trim() === "" ? null : operatorParentVendorId.trim(),
        alias_of_vendor_id: aliasOfVendorId.trim() === "" ? null : aliasOfVendorId.trim(),
        relationship_type: relationshipType,
        default_child_display: defaultChildDisplay === "" ? null : defaultChildDisplay,
        display_override_permitted: displayOverridePermitted,
        display_mode: displayMode === "" ? null : displayMode,
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
        <div className="h-8 bg-muted rounded w-1/4"></div>
        <div className="h-64 bg-muted rounded"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/vendors"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Vendors
        </Link>
      </div>

      {vendor && (
        <div className="mb-6 space-y-6">
          <VendorLogoUpload vendorId={vendor.id} currentLogoUrl={vendor.logoUrl} />
          {vendor.logoUrl && (
            <Card>
              <CardHeader>
                <CardTitle>Logo focal point</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">
                  Drag the dot to mark the focal point of the logo. Most logos are square so the
                  default center works; use this if your logo crops badly into the square card slot.
                  Set + Save here, then upload a new logo above if you want to replace it.
                </p>
                <FocalPointPicker
                  src={vendor.logoUrl}
                  x={imageFocalX}
                  y={imageFocalY}
                  onChange={(nx, ny) => {
                    setImageFocalX(nx);
                    setImageFocalY(ny);
                  }}
                  previewAspect={1}
                />
              </CardContent>
            </Card>
          )}
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
                  <p className="text-xs text-muted-foreground">Separate with commas</p>
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

            {/* EH1 Vendor Hierarchy Section — full relationship model
                (drizzle/0107). Surfaces 8 fields:
                  - role (always visible) — fast NATIONAL/LOCAL_OFFICE/INDEPENDENT discriminator.
                  - relationshipType (always visible) — 8-shape typology.
                  - aliasOfVendorId (always visible) — same-entity dedup; admin-only.
                  - brandParentVendorId (LOCAL_OFFICE only) — the consumer-facing brand.
                  - operatorParentVendorId (LOCAL_OFFICE only) — the contracts/billing entity.
                  - defaultChildDisplay (NATIONAL only) — what offices show by default.
                  - displayOverridePermitted (LOCAL_OFFICE only) — the per-office gate.
                  - displayMode (LOCAL_OFFICE only) — the office's preference.
                Most vendors are INDEPENDENT and only see role + relationshipType + alias inputs. */}
            <div className="border-t pt-6">
              <h3 className="text-lg font-medium mb-4">Vendor Hierarchy</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Most vendors are <strong>Independent</strong>. Use <strong>National</strong> for
                parent brands (e.g. LeafFilter HQ) and <strong>Local Office</strong> for franchise /
                regional offices that should show under a national parent. Set{" "}
                <strong>Relationship Type</strong> to describe how the office relates to its parent.
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
                    className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
                  >
                    <option value="INDEPENDENT">Independent (default)</option>
                    <option value="NATIONAL">National (parent brand)</option>
                    <option value="LOCAL_OFFICE">Local Office (under a parent)</option>
                  </select>
                </div>

                {/* Relationship type — always visible. Maps to the 8-shape
                    typology from the design doc. Carried in the schema
                    even on INDEPENDENT rows so the column is uniform. */}
                <div className="space-y-2">
                  <Label htmlFor="relationshipType">Relationship Type</Label>
                  <select
                    id="relationshipType"
                    value={formData.relationshipType}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        relationshipType: e.target.value as Vendor["relationshipType"],
                      })
                    }
                    className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
                  >
                    <option value="independent">independent (default — no relationship)</option>
                    <option value="branch">branch (W-2 office of operator)</option>
                    <option value="franchise">franchise (independent operator)</option>
                    <option value="dealer">dealer (reseller)</option>
                    <option value="member">member (cooperative)</option>
                    <option value="agent">agent (1099 — e.g. NY Life)</option>
                    <option value="employee_branch">employee_branch (small-corp branch)</option>
                    <option value="government">government (gov entity)</option>
                  </select>
                </div>

                {/* Brand parent picker — only for LOCAL_OFFICE. ID input
                    rather than a search picker for now (handful of NATIONAL
                    parents today; pasting the id from /admin/vendors is
                    fine). Phase 5 can upgrade to a typeahead. */}
                {formData.role === "LOCAL_OFFICE" && (
                  <div className="space-y-2">
                    <Label htmlFor="brandParentVendorId">Brand Parent Vendor ID</Label>
                    <Input
                      id="brandParentVendorId"
                      value={formData.brandParentVendorId}
                      onChange={(e) =>
                        setFormData({ ...formData, brandParentVendorId: e.target.value })
                      }
                      placeholder="UUID of the NATIONAL brand parent vendor"
                    />
                    <p className="text-xs text-muted-foreground">
                      The consumer-facing brand (who appears on signage). Look up the NATIONAL
                      parent at <code>/admin/vendors</code> and paste its <code>id</code> here.
                    </p>
                  </div>
                )}

                {/* Operator parent — only for LOCAL_OFFICE. Distinct from
                    brand parent for Shape C (Esler-run RbA franchises,
                    Bath Fitter / Premier Bath). Often equals brand parent
                    for Shape A (branch shapes — LeafFilter, Goodhue). */}
                {formData.role === "LOCAL_OFFICE" && (
                  <div className="space-y-2">
                    <Label htmlFor="operatorParentVendorId">Operator Parent Vendor ID</Label>
                    <Input
                      id="operatorParentVendorId"
                      value={formData.operatorParentVendorId}
                      onChange={(e) =>
                        setFormData({ ...formData, operatorParentVendorId: e.target.value })
                      }
                      placeholder="UUID of the operator (contracts/billing) vendor"
                    />
                    <p className="text-xs text-muted-foreground">
                      Who signs contracts / pays booth fees. Equal to brand parent for branch
                      shapes; distinct for franchise-with-operator shapes (e.g. Esler Companies).
                    </p>
                  </div>
                )}

                {/* Alias of — admin-only. Marks this row as the SAME
                    operating entity as another row (different spelling).
                    The aliased row should also be soft-deleted +
                    redirectToVendorId-pointed-at-canonical via the
                    set_vendor_alias MCP tool. */}
                <div className="space-y-2">
                  <Label htmlFor="aliasOfVendorId">Alias Of Vendor ID</Label>
                  <Input
                    id="aliasOfVendorId"
                    value={formData.aliasOfVendorId}
                    onChange={(e) => setFormData({ ...formData, aliasOfVendorId: e.target.value })}
                    placeholder="UUID of the canonical vendor (if this is an alias)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Use the <code>set_vendor_alias</code> MCP tool instead to also repoint events.
                    This input is for read-only inspection or manual cleanup.
                  </p>
                </div>

                {/* Default child display — only for NATIONAL. Decides what
                    the public sees when a child has NO override (the
                    common case). 'self' means franchise pages surface;
                    'brand_parent' means franchise pages canonical-up to
                    the hub; 'both' means office is canonical but also
                    shown under the brand. */}
                {formData.role === "NATIONAL" && (
                  <div className="space-y-2">
                    <Label htmlFor="defaultChildDisplay">Default Child Display</Label>
                    <select
                      id="defaultChildDisplay"
                      value={formData.defaultChildDisplay}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          defaultChildDisplay: e.target.value as
                            | ""
                            | "self"
                            | "brand_parent"
                            | "both",
                        })
                      }
                      className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
                    >
                      <option value="">— Unset —</option>
                      <option value="self">self (children pages indexed)</option>
                      <option value="brand_parent">
                        brand_parent (children canonical-up to this hub)
                      </option>
                      <option value="both">both (office indexed + linked under brand)</option>
                    </select>
                  </div>
                )}

                {/* Override gate — only meaningful on LOCAL_OFFICE. Default
                    OFF: child can REQUEST a mode but the brand parent's
                    defaultChildDisplay wins. Flip ON to grant the child
                    its self-selected display. Encodes spec §4.4
                    "parent's gate always wins". */}
                {formData.role === "LOCAL_OFFICE" && (
                  <div className="space-y-2">
                    <Label htmlFor="displayOverridePermitted">
                      Display Override Permitted (gate)
                    </Label>
                    <div className="flex items-center gap-2 pt-2">
                      <input
                        type="checkbox"
                        id="displayOverridePermitted"
                        checked={formData.displayOverridePermitted}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            displayOverridePermitted: e.target.checked,
                          })
                        }
                        className="rounded border-border"
                      />
                      <span className="text-sm text-muted-foreground">
                        Let this office&apos;s preference override the brand&apos;s default
                      </span>
                    </div>
                  </div>
                )}

                {/* Child preference — only meaningful on LOCAL_OFFICE.
                    'inherit' = fall through to brand's defaultChildDisplay.
                    Setting one of the four resolved modes here only
                    takes effect when displayOverridePermitted is ON. */}
                {formData.role === "LOCAL_OFFICE" && (
                  <div className="space-y-2">
                    <Label htmlFor="displayMode">Display Mode</Label>
                    <select
                      id="displayMode"
                      value={formData.displayMode}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          displayMode: e.target.value as
                            | ""
                            | "inherit"
                            | "self"
                            | "brand_parent"
                            | "operator_parent"
                            | "both",
                        })
                      }
                      className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
                    >
                      <option value="">— Unset —</option>
                      <option value="inherit">inherit (fall through to brand)</option>
                      <option value="self">self (this office&apos;s page is canonical)</option>
                      <option value="brand_parent">brand_parent (canonical-up to brand hub)</option>
                      <option value="operator_parent">
                        operator_parent (canonical-up to operator)
                      </option>
                      <option value="both">both (office indexed + shown under brand)</option>
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Only takes effect when the brand parent grants{" "}
                      <em>Display Override Permitted</em>.
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
                  className="rounded border-border"
                />
                <Label htmlFor="verified">Verified Vendor</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="commercial"
                  checked={formData.commercial}
                  onChange={(e) => setFormData({ ...formData, commercial: e.target.checked })}
                  className="rounded border-border"
                />
                <Label htmlFor="commercial">Commercial Vendor</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="canSelfConfirm"
                  checked={formData.canSelfConfirm}
                  onChange={(e) => setFormData({ ...formData, canSelfConfirm: e.target.checked })}
                  className="rounded border-border"
                />
                <div>
                  <Label htmlFor="canSelfConfirm">Can Self-Confirm Events</Label>
                  <p className="text-xs text-muted-foreground">
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
