"use client";

import Link from "next/link";
import { Plus, Pencil, Trash2, Eye, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import {
  AdminPagedTable,
  type AdminColumn,
  type AdminFilter,
} from "@/components/admin/admin-paged-table";
import type { AdminVendorRow } from "@/lib/admin-list/lists";

type VendorRow = Omit<AdminVendorRow, "deletedAt"> & { deletedAt: string | null };

const FILTERS: AdminFilter[] = [
  {
    param: "claim",
    allLabel: "All owners",
    options: [
      { value: "claimed", label: "Claimed" },
      { value: "unclaimed", label: "Unclaimed" },
    ],
  },
  {
    param: "verified",
    allLabel: "All statuses",
    options: [
      { value: "yes", label: "Verified" },
      { value: "no", label: "Unverified" },
    ],
  },
  {
    param: "commercial",
    allLabel: "Commercial + non",
    options: [
      { value: "yes", label: "Commercial" },
      { value: "no", label: "Non-commercial" },
    ],
  },
  {
    param: "selfConfirm",
    allLabel: "Self-confirm: any",
    options: [
      { value: "yes", label: "Can self-confirm" },
      { value: "no", label: "Cannot self-confirm" },
    ],
  },
  {
    param: "deleted",
    allLabel: "Live vendors",
    title: "Soft-deleted vendors, which is what a merge leaves behind",
    options: [{ value: "only", label: "Deleted only" }],
  },
];

async function deleteVendor(vendor: VendorRow, reload: () => void) {
  // Include the business name in the confirm so the operator can
  // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
  if (!confirm(`Delete vendor "${vendor.businessName}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/vendors/${vendor.id}`, { method: "DELETE" });
    if (res.ok) reload();
  } catch (error) {
    console.error("Failed to delete vendor:", error);
  }
}

const COLUMNS: AdminColumn<VendorRow>[] = [
  {
    key: "businessName",
    label: "Business",
    sortKey: "businessName",
    cell: (v) => (
      <p className="font-medium text-foreground">
        {v.businessName}
        {v.deletedAt && (
          <Badge variant="default" className="ml-2">
            Deleted
          </Badge>
        )}
      </p>
    ),
  },
  {
    key: "vendorType",
    label: "Type",
    sortKey: "vendorType",
    cell: (v) => <span className="text-muted-foreground">{v.vendorType || "-"}</span>,
  },
  {
    key: "user",
    label: "User",
    sortKey: "user",
    cell: (v) =>
      v.unclaimed ? (
        <Badge variant="default">Unclaimed</Badge>
      ) : (
        <span className="text-muted-foreground">{v.ownerEmail}</span>
      ),
  },
  {
    key: "events",
    label: "Events",
    sortKey: "events",
    cell: (v) => <span className="text-muted-foreground">{v.eventCount}</span>,
  },
  {
    key: "verified",
    label: "Status",
    sortKey: "verified",
    cell: (v) =>
      v.verified ? (
        <Badge variant="success" className="inline-flex items-center gap-1">
          <CheckCircle className="w-3 h-3" />
          Verified
        </Badge>
      ) : (
        <Badge variant="default">Unverified</Badge>
      ),
  },
  {
    key: "commercial",
    label: "Commercial",
    sortKey: "commercial",
    cell: (v) => <Badge variant="default">{v.commercial ? "Commercial" : "Non-Commercial"}</Badge>,
  },
  {
    key: "canSelfConfirm",
    label: "Self-Confirm",
    sortKey: "canSelfConfirm",
    cell: (v) => (v.canSelfConfirm ? <Badge variant="success">Self-Confirm</Badge> : null),
  },
  {
    key: "actions",
    label: "Actions",
    align: "right",
    cell: (v, { reload }) => (
      <div className="flex items-center justify-end gap-1">
        <IconLink
          href={`/vendors/${v.slug}`}
          aria-label={`View ${v.businessName}`}
          icon={<Eye />}
        />
        <IconLink
          href={`/admin/vendors/${v.id}/edit`}
          aria-label={`Edit ${v.businessName}`}
          icon={<Pencil />}
        />
        <IconButton
          variant="danger"
          onClick={() => void deleteVendor(v, reload)}
          aria-label={`Delete ${v.businessName}`}
          icon={<Trash2 />}
        />
      </div>
    ),
  },
];

export default function AdminVendorsPage() {
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
      <AdminPagedTable<VendorRow>
        endpoint="/api/admin/vendors"
        columns={COLUMNS}
        rowKey={(v) => v.id}
        noun="vendor"
        searchPlaceholder="Search vendors by name…"
        filters={FILTERS}
        defaultSort={{ column: "businessName", direction: "asc" }}
      />
    </div>
  );
}
