"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const runtime = "edge";

interface User {
  id: string;
  email: string;
  name: string | null;
}

export default function NewVendorPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [formData, setFormData] = useState({
    userId: "",
    businessName: "",
    description: "",
    vendorType: "",
    website: "",
    verified: false,
    commercial: false,
    canSelfConfirm: false,
  });

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json() as User[];
      setUsers(data);
    } catch (error) {
      console.error("Failed to fetch users:", error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch("/api/admin/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        router.push("/admin/vendors");
      } else {
        const data = await res.json() as { error?: string };
        alert(data.error || "Failed to create vendor");
      }
    } catch (error) {
      console.error("Failed to create vendor:", error);
      alert("Failed to create vendor");
    } finally {
      setLoading(false);
    }
  };

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
          <CardTitle>Add New Vendor</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="userId">User Account *</Label>
                <select
                  id="userId"
                  value={formData.userId}
                  onChange={(e) =>
                    setFormData({ ...formData, userId: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  required
                >
                  <option value="">Select a user</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.email} {user.name ? `(${user.name})` : ""}
                    </option>
                  ))}
                </select>
              </div>

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

              <div className="space-y-2">
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

            <div className="flex items-center gap-4">
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
                {loading ? "Creating..." : "Create Vendor"}
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
