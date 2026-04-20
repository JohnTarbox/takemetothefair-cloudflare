"use client";

import { useEffect } from "react";
import { trackApiError } from "@/lib/analytics";

type ClientErrorReport = {
  message: string;
  stack?: string;
  url: string;
  errorType: "window-error" | "unhandledrejection";
  statusCode?: number;
};

function reportClientError(report: ClientErrorReport) {
  try {
    const body = JSON.stringify(report);
    const endpoint = "/api/client-errors";
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(endpoint, blob)) return;
    }
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // Fire-and-forget: never cascade errors from the error reporter itself
    });
  } catch {
    // Ignore — never throw from the error handler
  }
}

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
