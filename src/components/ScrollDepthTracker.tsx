"use client";

import { useEffect, useRef } from "react";
import { trackScrollDepth } from "@/lib/analytics";

interface ScrollDepthTrackerProps {
  pageType: string;
}

/**
 * Tracks scroll depth milestones (25%, 50%, 75%, 100%) and sends to GA4.
 * Place once per detail page. Fires each milestone at most once per page view.
 */
export function ScrollDepthTracker({ pageType }: ScrollDepthTrackerProps) {
  const firedRef = useRef(new Set<number>());

  useEffect(() => {
    const milestones = [25, 50, 75, 100];
    const fired = firedRef.current;

    function handleScroll() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;

      const percent = Math.round((scrollTop / docHeight) * 100);

      for (const milestone of milestones) {
        if (percent >= milestone && !fired.has(milestone)) {
          fired.add(milestone);
          trackScrollDepth(milestone, pageType);
        }
      }
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [pageType]);

  return null;
}
