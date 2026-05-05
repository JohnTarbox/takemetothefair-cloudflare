import { NextResponse, type NextRequest } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { vendors } from "@/lib/db/schema";

/**
 * Middleware handles two pre-route concerns that must NOT be cached:
 *
 *   1. IndexNow keyfile  — `/<key>.txt` served from site root for the
 *      IndexNow path-scope rule (see comment block below).
 *   2. Soft-deleted vendor redirect — `/vendors/<slug>` for any vendor with
 *      a non-null `deleted_at`. The page-component check at
 *      src/app/vendors/[slug]/page.tsx still exists as a defense-in-depth
 *      fallback, but middleware runs before any ISR / edge cache, so a stale
 *      cached HTML response can't masquerade as a live vendor page after the
 *      soft-delete write. Adds ~5ms (one indexed lookup) per vendor page
 *      view; cheaper than the joins the page itself does.
 *
 * IndexNow key file path scope: the IndexNow spec ties the file's path to
 * the URL scope it authorizes. A file in a subdirectory (e.g.
 * `/api/indexnow-key/<key>.txt`) only authorizes URLs under that
 * subdirectory, so submissions of `/blog/...`, `/events/...`, `/venues/...`
 * were rejected with HTTP 422. The file must live at the root.
 *
 * We use middleware (not a top-level dynamic route like
 * `app/[key]/route.ts`) because adding a dynamic catch-all at the root
 * makes Next.js's `no-html-link-for-pages` lint rule treat every internal
 * path as a "known page", flooding the build with errors on every existing
 * `<a href="/...">`. Middleware intercepts the specific path before
 * routing without polluting the routes manifest.
 */

export const config = {
  matcher: [
    // Single-segment top-level path ending in `.txt` — IndexNow keyfile.
    "/:keyfile([^/]+\\.txt)",
    // Vendor detail pages (single slug only; not /vendors itself or sub-routes).
    "/vendors/:slug",
  ],
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let env: Record<string, unknown> | null = null;
  try {
    env = getRequestContext().env as unknown as Record<string, unknown>;
  } catch {
    // Outside the Cloudflare runtime (local `next build`) — fall through.
    return NextResponse.next();
  }

  // ── /vendors/<slug> ────────────────────────────────────────────
  if (pathname.startsWith("/vendors/")) {
    const slug = pathname.slice("/vendors/".length);
    if (!slug || slug.includes("/")) return NextResponse.next();

    const d1 = env.DB as D1Database | undefined;
    if (!d1) return NextResponse.next();
    const db = drizzle(d1);

    try {
      const [row] = await db
        .select({
          deletedAt: vendors.deletedAt,
          redirectToVendorId: vendors.redirectToVendorId,
        })
        .from(vendors)
        .where(eq(vendors.slug, slug))
        .limit(1);
      if (!row || !row.deletedAt) return NextResponse.next();

      // Deleted with redirect target → 301 to target's slug if target is live.
      if (row.redirectToVendorId) {
        const [target] = await db
          .select({ slug: vendors.slug, deletedAt: vendors.deletedAt })
          .from(vendors)
          .where(eq(vendors.id, row.redirectToVendorId))
          .limit(1);
        if (target && !target.deletedAt) {
          const url = request.nextUrl.clone();
          url.pathname = `/vendors/${target.slug}`;
          return NextResponse.redirect(url, 301);
        }
      }

      // Deleted without (live) redirect target → 410 Gone. Crawlers treat 410
      // as "intentionally removed, drop from index" — sharper signal than 404.
      return new NextResponse("Gone", {
        status: 410,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch {
      // DB error — let the page handler take over (it has its own check too).
      return NextResponse.next();
    }
  }

  // ── /<key>.txt (IndexNow keyfile) ──────────────────────────────
  const requested = pathname.slice(1);
  const key = (env as { INDEXNOW_KEY?: string }).INDEXNOW_KEY;
  if (!key || requested !== `${key}.txt`) {
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
