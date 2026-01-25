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

interface Promoter {
  id: string;
  companyName: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  verified: boolean;
  user: { email: string; name: string | null } | null;
}

export default function EditPromoterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [promoter, setPromoter] = useState<Promoter | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchPromoter();
  }, [id]);

  const fetchPromoter = async () => {
    try {
      const res = await fetch(`/api/admin/promoters/${id}`);
      if (!res.ok) throw new Error("Promoter not found");
      const data = await res.json();
      setPromoter(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load promoter");
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
      companyName: formData.get("companyName"),
      description: formData.get("description") || null,
      website: formData.get("website") || null,
      logoUrl: formData.get("logoUrl") || null,
      verified: formData.get("verified") === "on",
    };

    try {
      const res = await fetch(`/api/admin/promoters/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = await res.json();
        throw new Error(result.error || "Failed to update promoter");
      }

      router.push("/admin/promoters");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update promoter");
    } finally {
      setSaving(false);
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

  if (!promoter) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Promoter not found</p>
        <Link href="/admin/promoters" className="text-blue-600 hover:underline mt-2 inline-block">
          Back to Promoters
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/promoters"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Promoters
        </Link>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Edit Promoter</CardTitle>
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
                <Label>User Account</Label>
                <Input
                  value={promoter.user?.email || "-"}
                  disabled
                  className="bg-gray-100"
                />
                <p className="text-xs text-gray-500 mt-1">User cannot be changed</p>
              </div>

              <div>
                <Label htmlFor="companyName">Company Name *</Label>
                <Input
                  id="companyName"
                  name="companyName"
                  required
                  defaultValue={promoter.companyName}
                />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  defaultValue={promoter.description ?? ""}
                />
              </div>

              <div>
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  name="website"
                  type="url"
                  defaultValue={promoter.website ?? ""}
                />
              </div>

              <div>
                <Label htmlFor="logoUrl">Logo URL</Label>
                <Input
                  id="logoUrl"
                  name="logoUrl"
                  type="url"
                  defaultValue={promoter.logoUrl ?? ""}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="verified"
                  name="verified"
                  type="checkbox"
                  defaultChecked={promoter.verified}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="verified" className="font-normal">
                  Verified Promoter
                </Label>
              </div>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
              <Link href="/admin/promoters">
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
