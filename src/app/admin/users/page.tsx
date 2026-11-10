"use client";

import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import {
  AdminPagedTable,
  type AdminColumn,
  type AdminFilter,
} from "@/components/admin/admin-paged-table";

interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
  // OPE-177 — verification timestamp (null = unverified).
  emailVerified: string | null;
}

const roleColors: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  ADMIN: "danger",
  PROMOTER: "warning",
  VENDOR: "info",
  USER: "default",
};

const FILTERS: AdminFilter[] = [
  {
    param: "role",
    allLabel: "All roles",
    options: [
      { value: "USER", label: "User" },
      { value: "VENDOR", label: "Vendor" },
      { value: "PROMOTER", label: "Promoter" },
      { value: "ADMIN", label: "Admin" },
    ],
  },
  {
    param: "includePlaceholders",
    allLabel: "Real accounts",
    title: "Placeholder owner accounts minted by the vendor and promoter creation tools",
    options: [{ value: "1", label: "Include placeholders" }],
  },
];

async function changeRole(userId: string, role: string, reload: () => void) {
  try {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (res.ok) reload();
  } catch (error) {
    console.error("Failed to update user role:", error);
  }
}

// OPE-177 — clear a stuck account by marking its email verified.
async function markVerified(userId: string, reload: () => void) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/mark-verified`, { method: "POST" });
    if (res.ok) reload();
  } catch (error) {
    console.error("Failed to mark user verified:", error);
  }
}

const COLUMNS: AdminColumn<User>[] = [
  {
    key: "email",
    label: "Email",
    sortKey: "email",
    cell: (u) => <p className="font-medium text-foreground">{u.email}</p>,
  },
  {
    key: "name",
    label: "Name",
    sortKey: "name",
    cell: (u) => <span className="text-muted-foreground">{u.name || "-"}</span>,
  },
  {
    key: "role",
    label: "Role",
    sortKey: "role",
    cell: (u) => <Badge variant={roleColors[u.role]}>{u.role}</Badge>,
  },
  {
    key: "createdAt",
    label: "Joined",
    sortKey: "createdAt",
    cell: (u) => <span className="text-muted-foreground">{formatDate(u.createdAt)}</span>,
  },
  {
    key: "actions",
    label: "Actions",
    align: "right",
    cell: (u, { reload }) => (
      <div className="flex items-center justify-end gap-2">
        {/* OPE-177 — verification state + manual override for accounts whose
            verification email never arrived. */}
        {u.emailVerified ? (
          <Badge variant="success">Verified</Badge>
        ) : (
          <button
            type="button"
            onClick={() => void markVerified(u.id, reload)}
            className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
            title="Manually mark this user's email as verified"
          >
            Mark verified
          </button>
        )}
        <select
          value={u.role}
          onChange={(e) => void changeRole(u.id, e.target.value, reload)}
          className="text-sm border rounded px-2 py-1"
          aria-label={`Role for ${u.email}`}
        >
          <option value="USER">User</option>
          <option value="VENDOR">Vendor</option>
          <option value="PROMOTER">Promoter</option>
          <option value="ADMIN">Admin</option>
        </select>
      </div>
    ),
  },
];

export default function AdminUsersPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-foreground">Manage Users</h1>
      </div>
      <AdminPagedTable<User>
        endpoint="/api/admin/users"
        columns={COLUMNS}
        rowKey={(u) => u.id}
        noun="user"
        searchPlaceholder="Search by email or name…"
        filters={FILTERS}
        defaultSort={{ column: "email", direction: "asc" }}
      />
    </div>
  );
}
