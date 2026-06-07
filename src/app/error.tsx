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
      {/* K2 Phase B marker (2026-06-07): the apex Worker (apex-worker/src/index.ts)
          inspects the rendered HTML for this data attribute and rewrites the
          response status to 500 when present. Gated on isFetchError so only
          true data-fetch failures trigger the rewrite — non-fatal client-side
          errors keep their 200. Test pin: apex-worker/__tests__/inspect.test.ts. */}
      {isFetchError && (
        <span data-x-render-error="fetch" hidden>
          fetch
        </span>
      )}
      <div className="text-center max-w-md">
        <div className="mb-6 flex justify-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center">
            <AlertTriangle className="w-8 h-8 text-red-600" aria-hidden="true" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          {isFetchError ? "Service temporarily unavailable" : "Something went wrong"}
        </h1>
        <p className="text-gray-600 mb-4">
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
        <div className="text-sm text-gray-500 mb-8 space-y-1">
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

        {error.digest && <p className="mt-8 text-xs text-gray-600">Error ID: {error.digest}</p>}
      </div>
    </div>
  );
}
