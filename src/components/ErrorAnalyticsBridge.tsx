"use client";

import { useEffect } from "react";
import { trackApiError } from "@/lib/analytics";
// OPE-25 — reporter extracted to a shared module so the React error boundaries
// (app/error.tsx, app/global-error.tsx) report through the same path + dedup.
import { reportClientError } from "@/lib/report-client-error";
// OPE-485 — stale-chunk-after-deploy recovery. Reported first, then recovered:
// reportClientError uses sendBeacon, which survives the unload a reload causes,
// so the occurrence is still counted. This ticket's acceptance check is a DROP
// in error volume, which needs the errors to keep being measured.
import { recoverFromStaleChunkInBrowser } from "@/lib/stale-chunk-recovery";

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
      const stack = event.error instanceof Error ? event.error.stack : undefined;
      reportClientError({
        message,
        stack,
        url: window.location.href,
        errorType: "window-error",
        // OPE-614 scope 3 — the script that threw. Cross-origin scripts without
        // CORS report "", and that absence is itself informative.
        filename: event.filename || undefined,
      });
      recoverFromStaleChunkInBrowser({ message, stack });
    }

    function handleRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      trackApiError(window.location.pathname, 0, message);
      const stack = reason instanceof Error ? reason.stack : undefined;
      reportClientError({
        message,
        stack,
        url: window.location.href,
        errorType: "unhandledrejection",
        // OPE-614 — when the rejection value is NOT an Error there is no
        // `.stack` to take, which is why all 34 rows of the `.id` family are
        // stackless while 307 of 450 client rows overall carry one. Record what
        // it actually was instead: our own code rejects with Errors, and
        // injected scripts frequently reject with strings or plain objects, so
        // the type is itself an origin signal.
        reasonType: typeof reason,
        reasonConstructor:
          reason === null || reason === undefined
            ? undefined
            : (reason.constructor?.name ?? undefined),
      });
      // A lazy route chunk fails as a REJECTED import, so this handler — not
      // window.onerror — is the one that sees most of them.
      recoverFromStaleChunkInBrowser({ message, stack });
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
