"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutGrid, Table, Store, CheckCircle, ExternalLink, Download } from "lucide-react";
import { VendorCard } from "./vendor-card";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";
import { Badge } from "@/components/ui/badge";

interface VendorEvent {
  id: string;
  name: string;
  slug: string;
  startDate: Date | null;
  endDate: Date | null;
  imageUrl: string | null;
  venue: {
    name: string;
    city: string | null;
    state: string | null;
  } | null;
}

interface VendorWithEvents {
  id: string;
  businessName: string;
  slug: string;
  description: string | null;
  vendorType: string | null;
  products: string | null;
  logoUrl: string | null;
  website: string | null;
  verified: boolean | null;
  commercial: boolean | null;
  claimed?: boolean | null;
  enhancedProfile?: boolean | null;
  verifiedPro?: boolean | null;
  city?: string | null;
  state?: string | null;
  events: VendorEvent[];
}

interface VendorsViewProps {
  vendors: VendorWithEvents[];
  emptyMessage?: string;
}

export function VendorsView({ vendors, emptyMessage = "No vendors found" }: VendorsViewProps) {
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "businessName",
    direction: "asc",
  });

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const downloadCSV = () => {
    const currentParams = new URLSearchParams(window.location.search);
    const exportUrl = `/api/vendors/export?${currentParams.toString()}`;
    window.location.href = exportUrl;
  };

  const sortedVendors = sortData(vendors, sortConfig, {
    businessName: (v) => v.businessName.toLowerCase(),
    vendorType: (v) => v.vendorType?.toLowerCase() || "",
    events: (v) => v.events.length,
    verified: (v) => v.verified || false,
  });

  if (vendors.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      {/* View Toggle and Download */}
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-muted-foreground">
          {vendors.length} vendor{vendors.length !== 1 ? "s" : ""} found
        </p>
        <div className="flex items-center gap-3">
          {viewMode === "table" && (
            <button
              onClick={downloadCSV}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted border border-border bg-card transition-colors"
              aria-label="Download vendors as CSV"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              Download CSV
            </button>
          )}
          <div
            className="inline-flex rounded-lg border border-border p-1 bg-card"
            role="group"
            aria-label="View mode"
          >
            <button
              onClick={() => setViewMode("cards")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === "cards"
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              aria-pressed={viewMode === "cards"}
              aria-label="Card view"
            >
              <LayoutGrid className="w-4 h-4" aria-hidden="true" />
              Cards
            </button>
            <button
              onClick={() => setViewMode("table")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === "table"
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              aria-pressed={viewMode === "table"}
              aria-label="Table view"
            >
              <Table className="w-4 h-4" aria-hidden="true" />
              Table
            </button>
          </div>
        </div>
      </div>

      {/* Cards View */}
      {viewMode === "cards" && (
        <div className="space-y-6">
          {sortedVendors.map((vendor) => (
            <VendorCard key={vendor.id} vendor={vendor} />
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === "table" && (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <SortableHeader
                    column="businessName"
                    label="Vendor"
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
                    column="events"
                    label="Events"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    className="w-24"
                  />
                  <SortableHeader
                    column="verified"
                    label="Status"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    className="w-28"
                  />
                  <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground w-24">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedVendors.map((vendor) => (
                  <tr key={vendor.id} className="hover:bg-muted">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden relative">
                          {vendor.logoUrl ? (
                            <img
                              src={vendor.logoUrl}
                              alt={vendor.businessName}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Store className="w-5 h-5 text-muted-foreground" />
                          )}
                        </div>
                        <div>
                          <Link
                            href={`/vendors/${vendor.slug}`}
                            className="font-medium text-foreground hover:text-navy"
                          >
                            {vendor.businessName}
                          </Link>
                          {vendor.description && (
                            <p className="text-xs text-muted-foreground line-clamp-1 max-w-md">
                              {vendor.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground">
                      {vendor.vendorType || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground">
                      {vendor.events.length}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        {vendor.verified && (
                          <span className="inline-flex items-center gap-1 text-xs text-royal">
                            <CheckCircle className="w-3 h-3" />
                            Verified
                          </span>
                        )}
                        {vendor.commercial && (
                          <Badge variant="default" className="text-xs">
                            Commercial
                          </Badge>
                        )}
                        {!vendor.verified && !vendor.commercial && (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/vendors/${vendor.slug}`}
                          className="text-royal hover:text-navy-dark text-sm font-medium"
                        >
                          View
                        </Link>
                        {vendor.website && (
                          <a
                            href={vendor.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-muted-foreground"
                            title="Vendor Website"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
