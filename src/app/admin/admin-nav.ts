/**
 * OPE-1602 — the admin sidebar, in the six groups from the 2026-11-09 console
 * review. Pages the review merges into one tab stay as separate entries here
 * until those merges land, each already in the group it will end up in.
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
  Link2,
  Mail,
  MapPin,
  Megaphone,
  MessagesSquare,
  Mic2,
  Send,
  ShieldCheck,
  Store,
  Tags,
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
      { name: "Claim Review", href: "/admin/claims", icon: ShieldCheck },
      { name: "Vendor Claim", href: "/admin/vendor-claim-leaderboard", icon: Store },
      { name: "Duplicates", href: "/admin/duplicates", icon: GitMerge },
      { name: "Duplicate Flags", href: "/admin/duplicates/flags", icon: GitMerge },
      { name: "Inbound Emails", href: "/admin/inbound-emails", icon: Inbox },
      { name: "Sent Emails", href: "/admin/sent-emails", icon: Send },
      { name: "Correspondents", href: "/admin/correspondents", icon: MessagesSquare },
      { name: "Classifier Accuracy", href: "/admin/classifier-accuracy", icon: Tags },
      { name: "Email Source Suggestions", href: "/admin/email-source-suggestions", icon: Mail },
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
      { name: "Import Events", href: "/admin/import", icon: Download },
      { name: "Import from URL", href: "/admin/import-url", icon: Link2 },
      { name: "Promoter Quality", href: "/admin/promoter-quality", icon: Megaphone },
      { name: "Source Quality", href: "/admin/source-quality", icon: Gauge },
    ],
  },
  {
    label: "Content & SEO",
    items: [
      { name: "Blog Posts", href: "/admin/blog", icon: FileText },
      { name: "Blog Coverage", href: "/admin/coverage", icon: FileText },
      { name: "Stuck URLs", href: "/admin/stuck-urls", icon: BarChart3 },
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
