"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const runtime = "edge";

interface Promoter {
  id: string;
  companyName: string;
  slug: string;
  verified: boolean;
  user: { email: string; name: string | null } | null;
  _count: { events: number };
}

export default function AdminPromotersPage() {
  const [promoters, setPromoters] = useState<Promoter[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPromoters();
  }, []);

  const fetchPromoters = async () => {
    try {
      const res = await fetch("/api/admin/promoters");
      const data = await res.json() as Promoter[];
      setPromoters(data);
    } catch (error) {
      console.error("Failed to fetch promoters:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this promoter?")) return;

    try {
      const res = await fetch(`/api/admin/promoters/${id}`, { method: "DELETE" });
      if (res.ok) {
        setPromoters(promoters.filter((p) => p.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete promoter:", error);
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

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Manage Promoters</h1>
        <Link href="/admin/promoters/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Promoter
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">{promoters.length} promoters total</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                    Company
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                    User
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                    Events
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                    Status
                  </th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {promoters.map((promoter) => (
                  <tr key={promoter.id} className="border-b border-gray-100">
                    <td className="py-3 px-4">
                      <p className="font-medium text-gray-900">{promoter.companyName}</p>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {promoter.user?.email || "-"}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {promoter._count.events}
                    </td>
                    <td className="py-3 px-4">
                      {promoter.verified ? (
                        <Badge variant="success" className="inline-flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" />
                          Verified
                        </Badge>
                      ) : (
                        <Badge variant="default">Unverified</Badge>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/promoters/${promoter.slug}`}>
                          <Button variant="ghost" size="sm" aria-label={`View ${promoter.companyName}`}>
                            <Eye className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Link href={`/admin/promoters/${promoter.id}/edit`}>
                          <Button variant="ghost" size="sm" aria-label={`Edit ${promoter.companyName}`}>
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(promoter.id)}
                          aria-label={`Delete ${promoter.companyName}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
