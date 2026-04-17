"use client";

import { useEffect, useState } from "react";
import { List } from "lucide-react";
import type { MarkdownHeading } from "@/lib/markdown-utils";

interface Props {
  headings: MarkdownHeading[];
}

/**
 * Sticky table of contents for long blog posts. Uses IntersectionObserver to
 * highlight the heading currently in view.
 *
 * Renders nothing when fewer than 3 headings (too sparse to be useful).
 */
export function TableOfContents({ headings }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (headings.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 }
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [headings]);

  if (headings.length < 3) return null;

  return (
    <nav
      aria-label="Table of contents"
      className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto rounded-lg border border-stone-100 bg-stone-50 p-4 text-sm"
    >
      <p className="flex items-center gap-2 text-xs uppercase tracking-wide font-semibold text-stone-600 mb-3">
        <List className="w-3.5 h-3.5" aria-hidden />
        On this page
      </p>
      <ul className="space-y-1.5">
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? "ml-4" : ""}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(h.id);
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
                history.replaceState(null, "", `#${h.id}`);
              }}
              className={`block py-0.5 leading-snug transition-colors ${
                activeId === h.id
                  ? "text-navy font-semibold"
                  : "text-stone-600 hover:text-stone-900"
              }`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
