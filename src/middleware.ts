import { NextResponse, type NextRequest } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";

/**
 * Serves the IndexNow key file at the SITE ROOT — `/<key>.txt`.
 *
 * The IndexNow spec ties the file's path to the URL scope it authorizes:
 * a file in a subdirectory (e.g. `/api/indexnow-key/<key>.txt`) only
 * authorizes URLs under that subdirectory, which is why submissions of
 * `/blog/...`, `/events/...`, `/venues/...` were rejected with HTTP 422.
 * The file must live at the root.
 *
 * We use middleware (not a top-level dynamic route like `app/[key]/route.ts`)
 * because adding a dynamic catch-all at the root makes Next.js's
 * `no-html-link-for-pages` lint rule treat every internal path as a "known
 * page", flooding the build with errors on every existing `<a href="/...">`.
 * Middleware intercepts the specific path before routing without polluting
 * the routes manifest.
 */

export const config = {
  // Match any single-segment top-level path ending in `.txt`. The matcher
  // intentionally excludes paths with slashes after the first segment so
  // legitimate sub-routes (e.g. `/foo/bar.txt`) still hit normal routing.
  matcher: "/:keyfile([^/]+\\.txt)",
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Strip the leading slash so we compare against the env key + ".txt".
  const requested = pathname.slice(1);

  let key: string | undefined;
  try {
    const { env } = getRequestContext();
    key = (env as { INDEXNOW_KEY?: string }).INDEXNOW_KEY;
  } catch {
    // Outside the Cloudflare runtime (e.g. local `next build`) — fall through.
    return NextResponse.next();
  }

  if (!key || requested !== `${key}.txt`) {
    // Not the IndexNow keyfile — let Next render its normal 404 / route.
    return NextResponse.next();
  }

  return new NextResponse(key, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
