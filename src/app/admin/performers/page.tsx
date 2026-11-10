"use client";

/**
 * OPE-113 PR#2 — admin performers list: search + create. Admin-only route.
 * OPE-1595 — the list runs on the shared paged table.
 */
import { useState } from "react";
import Link from "next/link";
import { Music, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AdminPagedTable,
  type AdminColumn,
  type AdminFilter,
} from "@/components/admin/admin-paged-table";

interface Row {
  id: string;
  name: string;
  slug: string;
  verified: boolean;
}

const FILTERS: AdminFilter[] = [
  {
    param: "verified",
    allLabel: "All statuses",
    options: [
      { value: "yes", label: "Verified" },
      { value: "no", label: "Unverified" },
    ],
  },
];

const COLUMNS: AdminColumn<Row>[] = [
  {
    key: "name",
    label: "Act",
    sortKey: "name",
    cell: (r) => (
      <Link href={`/admin/performers/${r.id}`} className="font-medium text-royal hover:underline">
        {r.name}
      </Link>
    ),
  },
  {
    key: "slug",
    label: "Slug",
    cell: (r) => <code className="text-xs text-muted-foreground">{r.slug}</code>,
  },
  {
    key: "verified",
    label: "Status",
    cell: (r) => (r.verified ? <Badge>verified</Badge> : null),
  },
];

export default function PerformersListPage() {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/admin/performers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = (await res.json()) as { performer?: { id: string } };
      setNewName("");
      if (data.performer) window.location.href = `/admin/performers/${data.performer.id}`;
      else setRefreshKey((k) => k + 1);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Music className="w-5 h-5" /> Performers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Label>Create new</Label>
          <div className="flex gap-2 max-w-md">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New act name"
            />
            <Button disabled={creating} onClick={() => void create()} aria-label="Create performer">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
      <AdminPagedTable<Row>
        endpoint="/api/admin/performers"
        columns={COLUMNS}
        rowKey={(r) => r.id}
        noun="performer"
        searchPlaceholder="Search acts by name…"
        filters={FILTERS}
        defaultSort={{ column: "createdAt", direction: "desc" }}
        refreshKey={refreshKey}
      />
    </div>
  );
}
