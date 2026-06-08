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

export const runtime = "edge";

interface Vendor {
  id: string;
  businessName: string;
  slug: string;
  vendorType: string | null;
  verified: boolean;
  commercial: boolean;
  canSelfConfirm: boolean;
  user: { email: string; name: string | null } | null;
  _count: { events: number };
}

export default function AdminVendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "businessName",
    direction: "asc",
  });

  useEffect(() => {
    fetchVendors();
  }, []);

  const fetchVendors = async () => {
    try {
      const res = await fetch("/api/admin/vendors");
      const data = (await res.json()) as Vendor[];
      setVendors(data);
    } catch (error) {
      console.error("Failed to fetch vendors:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, businessName: string) => {
    // Include the business name in the confirm so the operator can
    // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
    if (!confirm(`Delete vendor "${businessName}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/admin/vendors/${id}`, { method: "DELETE" });
      if (res.ok) {
        setVendors(vendors.filter((v) => v.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete vendor:", error);
    }
  };

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const sortedVendors = sortData(vendors, sortConfig, {
    businessName: (v) => v.businessName,
    vendorType: (v) => v.vendorType || "",
    user: (v) => v.user?.email || "",
    events: (v) => v._count.events,
    verified: (v) => v.verified,
    commercial: (v) => v.commercial,
    canSelfConfirm: (v) => v.canSelfConfirm,
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
        <h1 className="text-2xl font-bold text-foreground">Manage Vendors</h1>
        <Link href="/admin/vendors/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Vendor
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">{vendors.length} vendors total</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <SortableHeader
                    column="businessName"
                    label="Business"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="vendorType"
                    label="Type"
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
                  <SortableHeader
                    column="commercial"
                    label="Commercial"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="canSelfConfirm"
                    label="Self-Confirm"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedVendors.map((vendor) => (
                  <tr key={vendor.id} className="border-b border-border">
                    <td className="py-3 px-4">
                      <p className="font-medium text-foreground">{vendor.businessName}</p>
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">{vendor.vendorType || "-"}</td>
                    <td className="py-3 px-4 text-muted-foreground">{vendor.user?.email || "-"}</td>
                    <td className="py-3 px-4 text-muted-foreground">{vendor._count.events}</td>
                    <td className="py-3 px-4">
                      {vendor.verified ? (
                        <Badge variant="success" className="inline-flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" />
                          Verified
                        </Badge>
                      ) : (
                        <Badge variant="default">Unverified</Badge>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {vendor.commercial ? (
                        <Badge variant="default">Commercial</Badge>
                      ) : (
                        <Badge variant="default">Non-Commercial</Badge>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {vendor.canSelfConfirm && <Badge variant="success">Self-Confirm</Badge>}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        {/* IconLink + IconButton primitives — type-enforced
                            aria-label, ≥40px hit area, single interactive
                            element (no nested Link>Button). UX-R2, 2026-06-01. */}
                        <IconLink
                          href={`/vendors/${vendor.slug}`}
                          aria-label={`View ${vendor.businessName}`}
                          icon={<Eye />}
                        />
                        <IconLink
                          href={`/admin/vendors/${vendor.id}/edit`}
                          aria-label={`Edit ${vendor.businessName}`}
                          icon={<Pencil />}
                        />
                        <IconButton
                          variant="danger"
                          onClick={() => handleDelete(vendor.id, vendor.businessName)}
                          aria-label={`Delete ${vendor.businessName}`}
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
