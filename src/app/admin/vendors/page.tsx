"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      const data = await res.json() as Vendor[];
      setVendors(data);
    } catch (error) {
      console.error("Failed to fetch vendors:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this vendor?")) return;

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
  });

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
        <h1 className="text-2xl font-bold text-gray-900">Manage Vendors</h1>
        <Link href="/admin/vendors/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Vendor
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">{vendors.length} vendors total</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
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
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedVendors.map((vendor) => (
                  <tr key={vendor.id} className="border-b border-gray-100">
                    <td className="py-3 px-4">
                      <p className="font-medium text-gray-900">{vendor.businessName}</p>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {vendor.vendorType || "-"}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {vendor.user?.email || "-"}
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {vendor._count.events}
                    </td>
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
                        <Badge variant="outline">Non-Commercial</Badge>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/vendors/${vendor.slug}`}>
                          <Button variant="ghost" size="sm" aria-label={`View ${vendor.businessName}`}>
                            <Eye className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Link href={`/admin/vendors/${vendor.id}/edit`}>
                          <Button variant="ghost" size="sm" aria-label={`Edit ${vendor.businessName}`}>
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(vendor.id)}
                          aria-label={`Delete ${vendor.businessName}`}
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
