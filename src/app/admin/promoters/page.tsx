"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";

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
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "companyName",
    direction: "asc",
  });

  useEffect(() => {
    fetchPromoters();
  }, []);

  const fetchPromoters = async () => {
    try {
      const res = await fetch("/api/admin/promoters");
      const data = (await res.json()) as Promoter[];
      setPromoters(data);
    } catch (error) {
      console.error("Failed to fetch promoters:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, companyName: string) => {
    // Include the company name in the confirm so the operator can
    // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
    if (!confirm(`Delete promoter "${companyName}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/admin/promoters/${id}`, { method: "DELETE" });
      if (res.ok) {
        setPromoters(promoters.filter((p) => p.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete promoter:", error);
    }
  };

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const sortedPromoters = sortData(promoters, sortConfig, {
    companyName: (p) => p.companyName,
    user: (p) => p.user?.email || "",
    events: (p) => p._count.events,
    verified: (p) => p.verified,
  });

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-muted rounded w-1/4"></div>
        <div className="h-64 bg-muted rounded"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-foreground">Manage Promoters</h1>
        <Link href="/admin/promoters/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Promoter
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">{promoters.length} promoters total</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <SortableHeader
                    column="companyName"
                    label="Company"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="user"
                    label="User"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="events"
                    label="Events"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="verified"
                    label="Status"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedPromoters.map((promoter) => (
                  <tr key={promoter.id} className="border-b border-border">
                    <td className="py-3 px-4">
                      <p className="font-medium text-foreground">{promoter.companyName}</p>
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {promoter.user?.email || "-"}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">{promoter._count.events}</td>
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
                      <div className="flex items-center justify-end gap-1">
                        {/* IconLink + IconButton primitives — type-enforced
                            aria-label, ≥40px hit area, single interactive
                            element (no nested Link>Button). UX-R2, 2026-06-01. */}
                        <IconLink
                          href={`/promoters/${promoter.slug}`}
                          aria-label={`View ${promoter.companyName}`}
                          icon={<Eye />}
                        />
                        <IconLink
                          href={`/admin/promoters/${promoter.id}/edit`}
                          aria-label={`Edit ${promoter.companyName}`}
                          icon={<Pencil />}
                        />
                        <IconButton
                          variant="danger"
                          onClick={() => handleDelete(promoter.id, promoter.companyName)}
                          aria-label={`Delete ${promoter.companyName}`}
                          icon={<Trash2 />}
                        />
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
