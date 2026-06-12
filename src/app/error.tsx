"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  // REL1' §1 (2026-06-04): FetchError is thrown by page-level data
  // fetchers (getEvents/getEvent/getVenue/getPromoter) when the
  // underlying D1 query fails. Distinguish it from generic Error so
  // the user sees "service temporarily unavailable" framing — both
  // visually distinct from a real-zero-results empty state, and a
  // signal to crawlers that this is a transient outage, not a
  // permanent 404 or a sparse-content page worth indexing.
  const isFetchError = error.name === "FetchError";

  useEffect(() => {
    // Log the error to an error reporting service
    console.error("Application error:", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      {/* B5 (2026-06-12): keep error states out of the index. error.tsx
          renders at HTTP 200 under @opennextjs/cloudflare — the ISR/stream
          layer commits the status before this boundary runs, the same wall
          that makes notFound() a soft-404 (docs/mig4-soft-404-opennext-isr.md).
          The apex Worker that previously rewrote 200->500 by reading a hidden
          marker here was retired by the OpenNext cutover and deleted, so the
          marker is gone. noindex prevents a crawl-during-outage from indexing
          the "temporarily unavailable" UI on an otherwise-valid URL; the page
          re-indexes normally once the underlying fetch recovers. Rendered in
          JSX because client error boundaries can't export metadata — React 19 /
          Next 15 hoist <meta> to <head> on both server and client render. */}
      <meta name="robots" content="noindex" />
      <div className="text-center max-w-md">
        <div className="mb-6 flex justify-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center">
            <AlertTriangle className="w-8 h-8 text-red-600" aria-hidden="true" />
          </div>
        </div>

        {/* SMOKE DEPENDENCY: the post-deploy smoke at
            .github/workflows/deploy.yml asserts a known-good page does NOT
            contain the "Service temporarily unavailable" H1 below (i.e. the
            error UI didn't render on a healthy route). Coordinate any copy
            change to that string with the smoke step. */}
        <h1 className="text-2xl font-bold text-foreground mb-2">
          {isFetchError ? "Service temporarily unavailable" : "Something went wrong"}
        </h1>
        <p className="text-muted-foreground mb-4">
          {isFetchError ? (
            <>
              We&apos;re having trouble loading the data for this page. This is usually a brief
              outage on our end — please try again in a moment. If it persists, you can{" "}
              <Link href="/report-problem" className="text-royal underline">
                let us know
              </Link>
              .
            </>
          ) : (
            <>We&apos;re sorry, but something unexpected happened while loading this page.</>
          )}
        </p>
        <div className="text-sm text-muted-foreground mb-8 space-y-1">
          <p>You can try:</p>
          <ul className="list-disc list-inside text-left max-w-xs mx-auto">
            <li>Clicking &quot;Try Again&quot; to reload</li>
            <li>Checking your internet connection</li>
            <li>Going back to the home page</li>
          </ul>
        </div>

        {isAdmin && (
          <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-lg text-left">
            <h2 className="text-sm font-semibold text-red-800 mb-2">Admin Debug Info:</h2>
            <p className="text-sm text-red-700 mb-2">
              <strong>Error:</strong> {error.name}: {error.message}
            </p>
            {error.stack && (
              <details className="text-xs">
                <summary className="cursor-pointer text-red-600 hover:text-red-800">
                  Stack Trace
                </summary>
                <pre className="mt-2 p-2 bg-red-100 rounded overflow-x-auto whitespace-pre-wrap text-red-800">
                  {error.stack}
                </pre>
              </details>
            )}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button onClick={reset} className="w-full sm:w-auto">
            <RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" />
            Try Again
          </Button>
          <Link href="/">
            <Button variant="outline" className="w-full sm:w-auto">
              <Home className="w-4 h-4 mr-2" aria-hidden="true" />
              Go Home
            </Button>
          </Link>
        </div>

        {error.digest && (
          <p className="mt-8 text-xs text-muted-foreground">Error ID: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
