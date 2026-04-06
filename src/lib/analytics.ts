/**
 * GA4 event tracking utility.
 * Safe to call anywhere — no-ops if gtag isn't loaded.
 */

declare global {
  interface Window {
    gtag?: (...args: [string, string, Record<string, unknown>?]) => void;
  }
}

export function trackEvent(
  action: string,
  params?: {
    category?: string;
    label?: string;
    value?: number;
    [key: string]: unknown;
  }
) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", action, {
      event_category: params?.category,
      event_label: params?.label,
      value: params?.value,
      ...params,
    });
  }
}

// ── Conversion funnel events ──────────────────────────────

/** Track when a user views an event detail page */
export function trackViewEventDetail(eventSlug: string, eventName: string) {
  trackEvent("view_event_detail", {
    category: "funnel",
    label: eventName,
    event_slug: eventSlug,
  });
}

/** Track when a user views a vendor detail page */
export function trackViewVendorDetail(vendorSlug: string, vendorName: string) {
  trackEvent("view_vendor_detail", {
    category: "funnel",
    label: vendorName,
    vendor_slug: vendorSlug,
  });
}

/** Track when a user views a venue detail page */
export function trackViewVenueDetail(venueSlug: string, venueName: string) {
  trackEvent("view_venue_detail", {
    category: "funnel",
    label: venueName,
    venue_slug: venueSlug,
  });
}

/** Track "add to calendar" clicks */
export function trackAddToCalendar(eventSlug: string, calendarType: string) {
  trackEvent("add_to_calendar", {
    category: "conversion",
    label: eventSlug,
    calendar_type: calendarType,
  });
}

/** Track when search returns zero results */
export function trackZeroResults(query: string) {
  trackEvent("zero_results_search", {
    category: "engagement",
    label: query,
  });
}

// ── Engagement tracking ──────────────────────────────────

/** Track scroll depth milestones (25%, 50%, 75%, 100%) */
export function trackScrollDepth(depth: number, pageType: string) {
  trackEvent("scroll_depth", {
    category: "engagement",
    label: pageType,
    value: depth,
    scroll_percentage: depth,
  });
}

/** Track client-side errors sent to GA4 for visibility */
export function trackApiError(endpoint: string, statusCode: number, requestId?: string) {
  trackEvent("api_error", {
    category: "error",
    label: endpoint,
    value: statusCode,
    request_id: requestId,
  });
}
