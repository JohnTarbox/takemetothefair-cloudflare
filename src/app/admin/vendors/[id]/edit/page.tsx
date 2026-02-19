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

export const runtime = "edge";

interface Vendor {
  id: string;
  userId: string;
  businessName: string;
  slug: string;
  description: string | null;
  vendorType: string | null;
  website: string | null;
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
}

export default function EditVendorPage() {
  const router = useRouter();
  const params = useParams();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
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
        const data = await res.json() as Vendor;
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
      // Transform form data for API
      const submitData = {
        ...formData,
        yearEstablished: formData.yearEstablished ? parseInt(formData.yearEstablished, 10) : null,
      };

      const res = await fetch(`/api/admin/vendors/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitData),
      });

      if (res.ok) {
        router.push("/admin/vendors");
      } else {
        const data = await res.json() as { error?: string };
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
                  onChange={(e) =>
                    setFormData({ ...formData, businessName: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="vendorType">Vendor Type</Label>
                <Input
                  id="vendorType"
                  value={formData.vendorType}
                  onChange={(e) =>
                    setFormData({ ...formData, vendorType: e.target.value })
                  }
                  placeholder="e.g., Food, Crafts, Services"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  type="url"
                  value={formData.website}
                  onChange={(e) =>
                    setFormData({ ...formData, website: e.target.value })
                  }
                  placeholder="https://example.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
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
                    onChange={(e) =>
                      setFormData({ ...formData, contactName: e.target.value })
                    }
                    placeholder="Primary contact person"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactEmail">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    type="email"
                    value={formData.contactEmail}
                    onChange={(e) =>
                      setFormData({ ...formData, contactEmail: e.target.value })
                    }
                    placeholder="contact@business.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactPhone">Contact Phone</Label>
                  <Input
                    id="contactPhone"
                    type="tel"
                    value={formData.contactPhone}
                    onChange={(e) =>
                      setFormData({ ...formData, contactPhone: e.target.value })
                    }
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
                    onChange={(e) =>
                      setFormData({ ...formData, address: e.target.value })
                    }
                    placeholder="123 Main Street"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={formData.city}
                    onChange={(e) =>
                      setFormData({ ...formData, city: e.target.value })
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="state">State</Label>
                    <Input
                      id="state"
                      value={formData.state}
                      onChange={(e) =>
                        setFormData({ ...formData, state: e.target.value })
                      }
                      placeholder="ME"
                      maxLength={2}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="zip">ZIP Code</Label>
                    <Input
                      id="zip"
                      value={formData.zip}
                      onChange={(e) =>
                        setFormData({ ...formData, zip: e.target.value })
                      }
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
                    onChange={(e) =>
                      setFormData({ ...formData, yearEstablished: e.target.value })
                    }
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
                        paymentMethods: e.target.value.split(",").map(s => s.trim()).filter(Boolean)
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
                    onChange={(e) =>
                      setFormData({ ...formData, licenseInfo: e.target.value })
                    }
                    placeholder="License number or details"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insuranceInfo">Insurance Info</Label>
                  <Input
                    id="insuranceInfo"
                    value={formData.insuranceInfo}
                    onChange={(e) =>
                      setFormData({ ...formData, insuranceInfo: e.target.value })
                    }
                    placeholder="Insurance details"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4 border-t pt-6">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="verified"
                  checked={formData.verified}
                  onChange={(e) =>
                    setFormData({ ...formData, verified: e.target.checked })
                  }
                  className="rounded border-gray-300"
                />
                <Label htmlFor="verified">Verified Vendor</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="commercial"
                  checked={formData.commercial}
                  onChange={(e) =>
                    setFormData({ ...formData, commercial: e.target.checked })
                  }
                  className="rounded border-gray-300"
                />
                <Label htmlFor="commercial">Commercial Vendor</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="canSelfConfirm"
                  checked={formData.canSelfConfirm}
                  onChange={(e) =>
                    setFormData({ ...formData, canSelfConfirm: e.target.checked })
                  }
                  className="rounded border-gray-300"
                />
                <div>
                  <Label htmlFor="canSelfConfirm">Can Self-Confirm Events</Label>
                  <p className="text-xs text-gray-500">Vendor can confirm participation without admin approval</p>
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
