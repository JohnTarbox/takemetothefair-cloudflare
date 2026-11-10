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
import type { AdminPromoterRow } from "@/lib/admin-list/lists";

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
];

async function deletePromoter(promoter: AdminPromoterRow, reload: () => void) {
  // Include the company name in the confirm so the operator can
  // re-confirm they targeted the right row (UX-R2, 2026-06-01 EVE).
  if (!confirm(`Delete promoter "${promoter.companyName}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/promoters/${promoter.id}`, { method: "DELETE" });
    if (res.ok) {
      reload();
    } else {
      // OPE-1125 — the route refuses to delete a promoter that still owns
      // events (the delete would cascade to them). Say why, instead of the
      // row silently staying put.
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      alert(data.message ?? data.error ?? `Delete failed (${res.status}).`);
    }
  } catch (error) {
    console.error("Failed to delete promoter:", error);
  }
}

const COLUMNS: AdminColumn<AdminPromoterRow>[] = [
  {
    key: "companyName",
    label: "Company",
    sortKey: "companyName",
    cell: (p) => <p className="font-medium text-foreground">{p.companyName}</p>,
  },
  {
    key: "user",
    label: "User",
    sortKey: "user",
    cell: (p) =>
      p.unclaimed ? (
        <Badge variant="default">Unclaimed</Badge>
      ) : (
        <span className="text-muted-foreground">{p.ownerEmail}</span>
      ),
  },
  {
    key: "events",
    label: "Events",
    sortKey: "events",
    cell: (p) => <span className="text-muted-foreground">{p.eventCount}</span>,
  },
  {
    key: "verified",
    label: "Status",
    sortKey: "verified",
    cell: (p) =>
      p.verified ? (
        <Badge variant="success" className="inline-flex items-center gap-1">
          <CheckCircle className="w-3 h-3" />
          Verified
        </Badge>
      ) : (
        <Badge variant="default">Unverified</Badge>
      ),
  },
  {
    key: "actions",
    label: "Actions",
    align: "right",
    cell: (p, { reload }) => (
      <div className="flex items-center justify-end gap-1">
        <IconLink
          href={`/promoters/${p.slug}`}
          aria-label={`View ${p.companyName}`}
          icon={<Eye />}
        />
        <IconLink
          href={`/admin/promoters/${p.id}/edit`}
          aria-label={`Edit ${p.companyName}`}
          icon={<Pencil />}
        />
        <IconButton
          variant="danger"
          onClick={() => void deletePromoter(p, reload)}
          aria-label={`Delete ${p.companyName}`}
          icon={<Trash2 />}
        />
      </div>
    ),
  },
];

export default function AdminPromotersPage() {
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
      <AdminPagedTable<AdminPromoterRow>
        endpoint="/api/admin/promoters"
        columns={COLUMNS}
        rowKey={(p) => p.id}
        noun="promoter"
        searchPlaceholder="Search promoters by name…"
        filters={FILTERS}
        defaultSort={{ column: "companyName", direction: "asc" }}
      />
    </div>
  );
}
