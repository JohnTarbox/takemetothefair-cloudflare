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
 * ## Why this is a scoped fix, not a full status-rewrite
 *
 * The Dev backlog plan acknowledged that neither `error.tsx` nor
 * `global-error.tsx` reliably sets HTTP 500 for every Server Component
 * throw on Cloudflare Pages. The durable fix for "every render error
 * returns 5xx" requires moving fetcher-error handling out of the
 * error boundary entirely and into route-handler code that explicitly
 * returns Response objects with the right status. That's larger
 * surgery than K's scope. What this file delivers is:
 *
 *   - The Next.js-documented root error catch surface exists, so
 *     layout-level throws (the worst class — they crash the whole
 *     page shell) are at least framed for the user instead of
 *     resolving to a Cloudflare Pages 500 default page with no
 *     branding.
 *   - The class hooks are in place for a follow-up to wire FetchError
 *     into a Worker-level header sentinel that middleware (or the
 *     Pages runtime) reads to override the response status.
 *
 * Per Next.js requirement, this component must include `<html>` and
 * `<body>` itself — it renders ABOVE the root layout (which is what
 * normally provides them).
 */

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

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
  }, [error]);

  return (
    <html lang="en">
      <body>
        {/* K2 Phase B marker (2026-06-07): the apex Worker
            (apex-worker/src/index.ts) inspects the rendered HTML for this
            data attribute and rewrites the response status to 500 when
            present. Gated on isFetchError so only true data-fetch
            failures trigger the rewrite. Test pin:
            apex-worker/__tests__/inspect.test.ts. */}
        {isFetchError && (
          <span data-x-render-error="fetch" hidden>
            fetch
          </span>
        )}
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

            {/* B5 SMOKE DEPENDENCY (K2 Phase A, 2026-06-07): the post-deploy
                smoke at .github/workflows/deploy.yml greps for the FetchError
                H1 text below to fail on error-UI-rendered-at-200. Coordinate
                any copy change with the smoke step. See
                docs/k2-spike-status-rewrite.md for the underlying K2 context. */}
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
