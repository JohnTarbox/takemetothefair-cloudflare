"use client";

/**
 * K — HTTP 5xx fallback (Dev backlog 2026-06-05).
 *
 * Root-level error boundary. Catches throws from the root `layout.tsx`
 * itself — the one scope `error.tsx` cannot cover, because `error.tsx`
 * renders inside the layout it's a sibling of. When the root layout
 * (which renders the global providers, the SessionProvider, the
 * FavoritesProvider, etc.) throws synchronously during render, this
 * file is what Next.js falls back to.
 *
 * ## HTTP status behavior
 *
 * Next.js documents `global-error.tsx` as the canonical place to handle
 * root-layout errors. In practice on Cloudflare Pages + the App Router,
 * whether the rendered response carries HTTP 500 depends on:
 *
 *   1. Where the throw originated (layout vs. page vs. data-fetcher).
 *   2. Whether a more specific `error.tsx` boundary already caught it
 *      (yes -> 200 framed inside the layout; no -> 500 framed inside
 *      this global-error.tsx).
 *
 * For data-fetcher throws (FetchError from getEvents/getVenue/etc.),
 * the existing `src/app/error.tsx` catches them at the page-segment
 * level, returning HTTP 200 with the "Service temporarily unavailable"
 * framing. That's intentional from REL1' §1 — users see the friendly
 * UI and crawlers see the page exists (transient outage messaging).
 *
 * This file is the LAYOUT-LEVEL fallback: if the layout itself can't
 * render (provider crash, malformed cookie, edge-runtime env missing),
 * Next.js falls back here and the response status reflects the
 * unrecoverability — typically 500. Treating that consistently as a
 * 5xx signal to crawlers is the K deliverable.
 *
 * ## Status code (B5, 2026-06-12 — apex Worker retired)
 *
 * Neither `error.tsx` nor `global-error.tsx` reliably sets HTTP 500 under
 * `@opennextjs/cloudflare`: on ISR / cacheable routes the cache/stream
 * layer commits the response status before/independent of the error
 * boundary — the same wall that makes `notFound()` a soft-404 (see
 * docs/mig4-soft-404-opennext-isr.md). The K2 apex Worker that previously
 * sat in front of the app and rewrote 200->500 by reading a hidden marker
 * in this HTML was retired by the OpenNext cutover (the OpenNext Worker
 * claimed the apex route 2026-06-10) and has been deleted. Reviving a
 * proxy-worker just for the status rewrite isn't justified — outage
 * detection is covered by error_logs + the page-error Slack canary.
 *
 * What remains is the right user-facing framing (transient-outage copy)
 * plus a `noindex` so a crawl-during-outage can't index the error UI.
 *
 * Per Next.js requirement, this component must include `<html>` and
 * `<body>` itself — it renders ABOVE the root layout (which is what
 * normally provides them).
 */

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { reportClientError } from "@/lib/report-client-error";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // FetchError shouldn't normally hit this boundary — error.tsx catches
  // it first. If we DO see one here, it means the layout itself
  // attempted a fetch that failed; same framing applies.
  const isFetchError = error.name === "FetchError";

  useEffect(() => {
    // Layout-level errors are rarer than page-level. Log with a
    // distinctive prefix so log filters can pick them out.
    console.error("[global-error] root layout error:", error);
    // OPE-25 — report root-layout boundary crashes to error_logs (own errorType
    // so triage can tell layout-level from page-level). global-error renders
    // ABOVE the root layout, but window + the fetch/sendBeacon path are still
    // available in this client effect.
    reportClientError({
      message: error.message || "Unknown root-layout error",
      stack: error.stack,
      url: window.location.href,
      errorType: "react-global-error",
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <head>
        {/* B5 (2026-06-12): an error boundary should never be indexed. The
            apex Worker that used to rewrite 200->500 by reading a hidden
            marker here was retired by the OpenNext cutover and deleted. */}
        <meta name="robots" content="noindex" />
      </head>
      <body>
        <div
          style={{
            minHeight: "60vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          }}
        >
          <div style={{ textAlign: "center", maxWidth: "28rem" }}>
            <div
              style={{
                marginBottom: "1.5rem",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: "4rem",
                  height: "4rem",
                  background: "#fee2e2",
                  borderRadius: "9999px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AlertTriangle style={{ width: "2rem", height: "2rem", color: "#dc2626" }} />
              </div>
            </div>

            {/* SMOKE DEPENDENCY: the post-deploy smoke at
                .github/workflows/deploy.yml asserts a known-good page does NOT
                contain the "Service temporarily unavailable" H1 below.
                Coordinate any copy change to that string with the smoke step. */}
            <h1
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "#111827",
                marginBottom: "0.5rem",
              }}
            >
              {isFetchError ? "Service temporarily unavailable" : "Something went wrong"}
            </h1>
            <p style={{ color: "#4b5563", marginBottom: "1rem" }}>
              {isFetchError ? (
                <>
                  We&apos;re having trouble loading this page. This is usually a brief outage on our
                  end — please try again in a moment.
                </>
              ) : (
                <>We&apos;re sorry, but something unexpected happened. Please try again.</>
              )}
            </p>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
                marginTop: "2rem",
              }}
            >
              <button
                onClick={reset}
                style={{
                  background: "#1d4ed8",
                  color: "white",
                  padding: "0.5rem 1rem",
                  borderRadius: "0.375rem",
                  border: 0,
                  cursor: "pointer",
                  fontSize: "1rem",
                }}
              >
                Try Again
              </button>
              {/* Plain <a> rather than next/link — at this fallback level
                  the Next.js router runtime may not be available
                  (we're above the root layout). */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                style={{
                  color: "#1d4ed8",
                  textDecoration: "underline",
                  fontSize: "0.875rem",
                }}
              >
                Go to the homepage
              </a>
            </div>

            {error.digest && (
              <p style={{ marginTop: "2rem", fontSize: "0.75rem", color: "#6b7280" }}>
                Error ID: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
