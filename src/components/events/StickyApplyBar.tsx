"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Store } from "lucide-react";

interface Props {
  /** The primary CTA label — usually "Apply as Vendor" or "Login to Apply". */
  label: string;
  /** If set, the bar renders as a Link. Otherwise renders as a scroll-to button. */
  href?: string;
  /** Element id to scroll into view when clicked (for same-page scroll). */
  scrollTarget?: string;
}

/**
 * Mobile-only bottom-sticky CTA for the event detail page. Hidden on lg+
 * where the sidebar apply card is already visible. Also hides itself when
 * the target is already on-screen (so it doesn't double-stack with the
 * in-page card).
 */
export function StickyApplyBar({ label, href, scrollTarget }: Props) {
  const [visible, setVisible] = useState(true);

  // Hide when the target apply card is already in view.
  useEffect(() => {
    if (!scrollTarget) return;
    const el = document.getElementById(scrollTarget);
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(!entry.isIntersecting), {
      threshold: 0.2,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollTarget]);

  const handleClick = () => {
    if (!scrollTarget) return;
    const el = document.getElementById(scrollTarget);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (!visible) return null;

  const className =
    "flex items-center justify-center w-full gap-2 px-4 py-3 rounded-lg bg-amber text-navy font-semibold shadow-lg";

  return (
    <div
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 p-3 bg-white/95 backdrop-blur border-t border-stone-100"
      role="region"
      aria-label="Event actions"
    >
      {href ? (
        <Link href={href} className={className}>
          <Store className="w-4 h-4" aria-hidden />
          {label}
        </Link>
      ) : (
        <button type="button" onClick={handleClick} className={className}>
          <Store className="w-4 h-4" aria-hidden />
          {label}
        </button>
      )}
    </div>
  );
}
