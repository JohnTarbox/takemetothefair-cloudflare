"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/duplicates/flags", label: "Flagged at intake" },
  { href: "/admin/duplicates", label: "Similarity sweep" },
];

export function DuplicatesTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-2 mb-6 border-b border-border" aria-label="Duplicates">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
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
