"use client";

import { useEffect } from "react";
import { trackViewEventDetail, trackViewVendorDetail, trackViewVenueDetail } from "@/lib/analytics";

interface DetailPageTrackerProps {
  type: "event" | "vendor" | "venue";
  slug: string;
  name: string;
}

/**
 * Client component that fires a funnel tracking event on mount.
 * Place in Server Component detail pages to track views.
 */
export function DetailPageTracker({ type, slug, name }: DetailPageTrackerProps) {
  useEffect(() => {
    switch (type) {
      case "event":
        trackViewEventDetail(slug, name);
        break;
      case "vendor":
        trackViewVendorDetail(slug, name);
        break;
      case "venue":
        trackViewVenueDetail(slug, name);
        break;
    }
  }, [type, slug, name]);

  return null;
}
