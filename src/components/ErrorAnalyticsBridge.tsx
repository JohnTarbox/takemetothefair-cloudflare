"use client";

import { useEffect } from "react";
import { trackApiError } from "@/lib/analytics";

/**
 * Intercepts global unhandled errors and fetch failures,
 * reporting them to GA4 for visibility alongside user behavior data.
 */
export function ErrorAnalyticsBridge() {
  useEffect(() => {
    // Track unhandled JS errors
    function handleError(event: ErrorEvent) {
      trackApiError(window.location.pathname, 0, event.message);
    }

    // Track unhandled promise rejections (e.g., failed fetches)
    function handleRejection(event: PromiseRejectionEvent) {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      trackApiError(window.location.pathname, 0, reason);
    }

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  return null;
}
