"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { findAdminSection } from "./admin-sections";

/** OPE-1602 — the tab bar for whichever merged section this page belongs to. */
export function AdminSectionTabs() {
  const pathname = usePathname();
  const section = findAdminSection(pathname);
  if (!section) return null;
  return (
    <nav className="flex flex-wrap gap-2 mb-6 border-b border-border" aria-label={section.label}>
      {section.tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            prefetch={false}
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              active
                ? "border-royal text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
