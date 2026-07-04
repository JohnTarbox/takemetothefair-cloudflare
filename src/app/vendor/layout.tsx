import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Store, FileText, Settings, CalendarPlus, Send, Calendar } from "lucide-react";
import { auth } from "@/lib/auth";
import { VendorProfileCompleteness } from "@/components/vendor/profile-completeness";

// OPE-87 — the vendor portal is private (auth-gated below). noindex makes that
// protection robust at the app layer instead of relying on a robots.txt Disallow
// (a robots-blocked URL can still get indexed URL-only). Applies to every page
// under /vendor/*.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const vendorNav = [
  { name: "My Profile", href: "/vendor/profile", icon: Store },
  { name: "Applications", href: "/vendor/applications", icon: FileText },
  { name: "My Calendar", href: "/vendor/calendar", icon: Calendar },
  { name: "Suggest Event", href: "/vendor/suggest-event", icon: CalendarPlus },
  { name: "My Submissions", href: "/vendor/submissions", icon: Send },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
];

export default async function VendorLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect("/login?callbackUrl=/vendor/profile");
  }

  if (session.user.role !== "VENDOR" && session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-muted">
      <div className="flex">
        <aside className="w-64 bg-card border-r border-border min-h-[calc(100vh-4rem)]">
          <div className="p-4">
            <h2 className="text-lg font-semibold text-foreground">Vendor Portal</h2>
          </div>
          <nav className="p-4 space-y-1">
            {vendorNav.map((item) => (
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
        <main className="flex-1 p-8">
          {session.user.role === "VENDOR" && <VendorProfileCompleteness userId={session.user.id} />}
          {children}
        </main>
      </div>
    </div>
  );
}
