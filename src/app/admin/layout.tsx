import Link from "next/link";
import {
  LayoutDashboard,
  Calendar,
  MapPin,
  Store,
  Users,
  ClipboardList,
  ShieldCheck,
  Megaphone,
  Download,
  GitMerge,
  Link2,
  Database,
  FileWarning,
  FileText,
  BarChart3,
  Inbox,
  Send,
} from "lucide-react";
import { requireAdmin } from "@/lib/require-admin";

const adminNav = [
  { name: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { name: "Events", href: "/admin/events", icon: Calendar },
  { name: "Import Events", href: "/admin/import", icon: Download },
  { name: "Import from URL", href: "/admin/import-url", icon: Link2 },
  { name: "Venues", href: "/admin/venues", icon: MapPin },
  { name: "Vendors", href: "/admin/vendors", icon: Store },
  { name: "Vendor Claim", href: "/admin/vendor-claim-leaderboard", icon: Store },
  { name: "Claim Review", href: "/admin/claims", icon: ShieldCheck },
  { name: "Promoters", href: "/admin/promoters", icon: Megaphone },
  { name: "Promoter Quality", href: "/admin/promoter-quality", icon: Megaphone },
  { name: "Users", href: "/admin/users", icon: Users },
  { name: "Submissions", href: "/admin/submissions", icon: ClipboardList },
  { name: "Inbound Emails", href: "/admin/inbound-emails", icon: Inbox },
  { name: "Sent Emails", href: "/admin/sent-emails", icon: Send },
  { name: "Duplicates", href: "/admin/duplicates", icon: GitMerge },
  { name: "Duplicate Flags", href: "/admin/duplicates/flags", icon: GitMerge },
  { name: "Blog Coverage", href: "/admin/coverage", icon: FileText },
  { name: "Blog Posts", href: "/admin/blog", icon: FileText },
  { name: "Stuck URLs", href: "/admin/stuck-urls", icon: BarChart3 },
  { name: "Analytics", href: "/admin/analytics", icon: BarChart3 },
  { name: "Database", href: "/admin/database", icon: Database },
  { name: "Error Logs", href: "/admin/logs", icon: FileWarning },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Same rule every admin page.tsx applies for itself (OPE-1365): a layout is
  // NOT an authorization boundary — an RSC request whose Next-Router-State-Tree
  // says this layout is already mounted renders only the page segment and never
  // runs this function. This call is navigation-time defense in depth; the
  // per-page requireAdmin() is what actually protects the data.
  await requireAdmin();
  return renderShell(children);
}

function renderShell(children: React.ReactNode) {
  return (
    <div className="min-h-screen bg-muted">
      <div className="flex">
        <aside className="w-64 bg-card border-r border-border min-h-[calc(100vh-4rem)]">
          <nav className="p-4 space-y-1">
            {adminNav.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2 text-foreground rounded-lg hover:bg-muted transition-colors"
              >
                <item.icon className="w-5 h-5" />
                {item.name}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
