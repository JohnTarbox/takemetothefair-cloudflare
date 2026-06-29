"use client";

import { useEffect } from "react";
import { trackApiError } from "@/lib/analytics";
// OPE-25 — reporter extracted to a shared module so the React error boundaries
// (app/error.tsx, app/global-error.tsx) report through the same path + dedup.
import { reportClientError } from "@/lib/report-client-error";

/**
 * Intercepts global unhandled errors and rejections, reporting them to
 * GA4 (aggregate counts) and to the D1 errorLogs table (full detail for
 * /admin/logs).
 */
export function ErrorAnalyticsBridge() {
  useEffect(() => {
    function handleError(event: ErrorEvent) {
      const message = event.message || "Unknown error";
      trackApiError(window.location.pathname, 0, message);
      reportClientError({
        message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
        url: window.location.href,
        errorType: "window-error",
      });
    }

    function handleRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      trackApiError(window.location.pathname, 0, message);
      reportClientError({
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
        url: window.location.href,
        errorType: "unhandledrejection",
      });
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
