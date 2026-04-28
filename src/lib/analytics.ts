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

/** Track a completed site search with the number of results. Fires once per
 *  distinct (query, resultsCount) pair so re-renders don't re-emit. */
export function trackSearchResults(searchTerm: string, resultsCount: number) {
  trackEvent("view_search_results", {
    category: "engagement",
    label: searchTerm,
    value: resultsCount,
    search_term: searchTerm,
    results_count: resultsCount,
  });
  sendBeacon("internal_search_performed", "engagement", {
    searchTerm,
    resultsCount,
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
export function trackApiError(endpoint: string, statusCode: number, detail?: string) {
  trackEvent("api_error", {
    category: "error",
    label: endpoint,
    value: statusCode,
    error_detail: detail,
  });
}

// ── First-party beacon (dual-emit alongside GA4) ────────────────────────────
//
// These helpers send events to /api/analytics/track in addition to GA4 so we
// own a copy of the signal in D1. Server name allowlist lives in the route
// handler — adding a name here without updating that allowlist will 400.

type BeaconCategory = "funnel" | "engagement" | "conversion";

function sendBeacon(name: string, category: BeaconCategory, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const payload = JSON.stringify({ name, category, properties });
  // sendBeacon is the right primitive for fire-and-forget on click/unload —
  // it's queued by the browser and survives navigation. Fall back to fetch
  // with keepalive when sendBeacon isn't available (or the payload is rejected
  // by the browser, which can happen for some Content-Type combinations).
  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon("/api/analytics/track", blob)) return;
  }
  fetch("/api/analytics/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Beacon failures are non-critical — never surface to the user.
  });
}

/** Track a click on an outbound application URL on an event detail page. */
export function trackOutboundApplicationClick(eventSlug: string, destinationUrl: string) {
  trackEvent("outbound_application_click", {
    category: "conversion",
    label: eventSlug,
    destination_url: destinationUrl,
  });
  sendBeacon("outbound_application_click", "conversion", {
    eventSlug,
    destinationUrl,
  });
}

/** Track a click on an outbound ticket URL on an event detail page. */
export function trackOutboundTicketClick(eventSlug: string, destinationUrl: string) {
  trackEvent("outbound_ticket_click", {
    category: "conversion",
    label: eventSlug,
    destination_url: destinationUrl,
  });
  sendBeacon("outbound_ticket_click", "conversion", {
    eventSlug,
    destinationUrl,
  });
}

/** Track a filter change on a listing page (events, venues, vendors). */
export function trackFilterApplied(filterType: string, filterValue: string, pageType: string) {
  trackEvent("filter_applied", {
    category: "engagement",
    label: filterType,
    filter_type: filterType,
    filter_value: filterValue,
    page_type: pageType,
  });
  sendBeacon("filter_applied", "engagement", {
    filterType,
    filterValue,
    pageType,
  });
}
