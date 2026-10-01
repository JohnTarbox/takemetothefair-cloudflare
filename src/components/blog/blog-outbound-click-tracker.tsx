"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { classifyBlogOutboundLink, trackBlogOutboundClick } from "@/lib/analytics";

/**
 * OPE-1128 — the ONLY client part of MarkdownContent. The markdown itself now
 * renders on the server, which keeps remark-gfm out of the browser bundle: its
 * email-autolink regex is a lookbehind LITERAL, and Safari < 16.4 refuses to
 * parse a chunk that contains one, so every route sharing that chunk crashed.
 */
export function BlogOutboundClickTracker({
  sourceSlug,
  className,
  children,
}: {
  sourceSlug?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // BC2 — delegated click attribution. One listener on the prose container
  // beats N listeners on every <a>, and the container outlives any
  // re-render of inner markdown nodes. The listener intentionally fires
  // BEFORE the navigation (default click action) — sendBeacon is queued
  // by the browser and survives the page transition, so the GA4 hit
  // doesn't depend on the new page rendering.
  useEffect(() => {
    if (!sourceSlug) return;
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      // Bail on middle/right clicks + modified clicks (ctrl/cmd+click) —
      // those usually open a new tab and don't represent a real "I'm
      // leaving this blog post" intent.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as HTMLElement | null)?.closest("a");
      if (!link) return;
      const classified = classifyBlogOutboundLink(link.getAttribute("href"));
      if (!classified) return;
      trackBlogOutboundClick(sourceSlug, classified.targetType, classified.targetSlug);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [sourceSlug]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
