import Link from "next/link";
import { requireAdmin } from "@/lib/require-admin";
import { adminNavGroups } from "./admin-nav";
import { AdminSectionTabs } from "./admin-section-tabs";

// OPE-1380 — a nonce-CSP route (src/lib/csp.ts): it must render per request,
// or the HTML carries no nonce and every script on it is blocked. Guarded by
// scripts/check-nonce-csp-routes.ts.
export const dynamic = "force-dynamic";

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
          {/* OPE-1573: prefetch={false}. Every admin route is force-dynamic, so each
              in-viewport sidebar link fired its own RSC render (auth + D1) on every
              admin page load. During the 2026-11-04 01:43Z D1 overload those
              prefetches returned 503 alongside the page itself. Guarded by
              src/app/admin/__tests__/admin-link-prefetch.test.ts. */}
          <nav className="p-4 space-y-4">
            {adminNavGroups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label} className="space-y-1">
                <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                {group.items.map((item) => (
                  <Link
                    prefetch={false}
                    key={item.name}
                    href={item.href}
                    className="flex items-center gap-3 px-3 py-2 text-foreground rounded-lg hover:bg-muted transition-colors"
                  >
                    <item.icon className="w-5 h-5" />
                    {item.name}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="flex-1 p-8">
          <AdminSectionTabs />
          {children}
        </main>
      </div>
    </div>
  );
}
