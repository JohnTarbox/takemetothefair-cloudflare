/**
 * OPE-1602 — the admin sidebar, in the six groups from the 2026-11-09 console
 * review. A merged section is one entry here, pointing at its first tab
 * (admin-sections.ts).
 *
 * A separate module because a Next layout may only export its reserved names, and
 * the reachability test needs this list.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Calendar,
  ClipboardList,
  Database,
  Download,
  FileText,
  FileWarning,
  Gauge,
  GitMerge,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  MapPin,
  Megaphone,
  Mic2,
  ShieldCheck,
  Store,
  Users,
} from "lucide-react";

export type AdminNavItem = { name: string; href: string; icon: LucideIcon };
export type AdminNavGroup = { label: string; items: AdminNavItem[] };

export const adminNavGroups: AdminNavGroup[] = [
  {
    label: "Today",
    items: [{ name: "Dashboard", href: "/admin", icon: LayoutDashboard }],
  },
  {
    label: "Work queues",
    items: [
      { name: "Submissions", href: "/admin/submissions", icon: ClipboardList },
      { name: "Claims", href: "/admin/claims", icon: ShieldCheck },
      { name: "Duplicates", href: "/admin/duplicates", icon: GitMerge },
      { name: "Duplicate Flags", href: "/admin/duplicates/flags", icon: GitMerge },
      { name: "Inbox", href: "/admin/inbound-emails", icon: Inbox },
      { name: "Problem Reports", href: "/admin/problem-reports", icon: AlertTriangle },
    ],
  },
  {
    label: "Catalog",
    items: [
      { name: "Events", href: "/admin/events", icon: Calendar },
      { name: "Venues", href: "/admin/venues", icon: MapPin },
      { name: "Vendors", href: "/admin/vendors", icon: Store },
      { name: "Promoters", href: "/admin/promoters", icon: Megaphone },
      { name: "Performers", href: "/admin/performers", icon: Mic2 },
      { name: "Users", href: "/admin/users", icon: Users },
    ],
  },
  {
    label: "Ingest",
    items: [
      { name: "Import", href: "/admin/import", icon: Download },
      { name: "Sources", href: "/admin/promoter-quality", icon: Gauge },
    ],
  },
  {
    label: "Content & SEO",
    items: [
      { name: "Blog", href: "/admin/blog", icon: FileText },
      { name: "Search", href: "/admin/analytics?tab=google", icon: BarChart3 },
    ],
  },
  {
    label: "System",
    items: [
      { name: "Analytics", href: "/admin/analytics", icon: BarChart3 },
      { name: "Error Logs", href: "/admin/logs", icon: FileWarning },
      { name: "Diagnostics", href: "/admin/diagnostics", icon: Activity },
      { name: "Database", href: "/admin/database", icon: Database },
      { name: "Ideas", href: "/admin/ideas", icon: Lightbulb },
    ],
  },
];
