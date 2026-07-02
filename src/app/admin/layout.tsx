import { redirect } from "next/navigation";
import { headers } from "next/headers";
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
} from "lucide-react";
import { auth } from "@/lib/auth";
import { bearerTokenMatches } from "@/lib/api-auth";

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
  { name: "Duplicates", href: "/admin/duplicates", icon: GitMerge },
  { name: "Blog Coverage", href: "/admin/coverage", icon: FileText },
  { name: "Blog Posts", href: "/admin/blog", icon: FileText },
  { name: "Stuck URLs", href: "/admin/stuck-urls", icon: BarChart3 },
  { name: "Analytics", href: "/admin/analytics", icon: BarChart3 },
  { name: "Database", href: "/admin/database", icon: Database },
  { name: "Error Logs", href: "/admin/logs", icon: FileWarning },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Read-only Bearer pre-check for the Claude service-account identity.
  // Layouts only render on GET (page renders), so no method gate is needed
  // here — the edge middleware (src/middleware.ts) blocks any non-safe-method
  // request to /admin/* with the same Bearer header before this layout runs.
  // We pass a synthetic Request with just the Authorization header so
  // bearerTokenMatches has the shape it expects.
  const hdrs = await headers();
  const authHeader = hdrs.get("authorization");
  if (authHeader) {
    const synthetic = new Request("https://internal/", {
      headers: { authorization: authHeader },
    });
    if (await bearerTokenMatches(synthetic)) {
      return renderShell(children);
    }
  }

  const session = await auth();

  if (!session || session.user.role !== "ADMIN") {
    redirect("/login?callbackUrl=/admin");
  }

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
