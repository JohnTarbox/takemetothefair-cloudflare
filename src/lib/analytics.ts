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
  }
) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", action, {
      event_category: params?.category,
      event_label: params?.label,
      value: params?.value,
    });
  }
}
