import { NextResponse, type NextRequest } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, desc } from "drizzle-orm";
import { vendors, events, eventSlugHistory, blogPosts, blogSlugHistory } from "@/lib/db/schema";
import { isPubliclyVisible, publicEventWhere, type EventLifecycle } from "@/lib/event-lifecycle";
import { unsafeSlug } from "@/lib/utils";

/**
 * Middleware handles five pre-route concerns that must NOT be cached:
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
 *   3. Event status + slug-rename redirect — `/events/<slug>`. REJECTED
 *      events return 410; non-public statuses return 404; renamed events
 *      301 to the canonical slug via event_slug_history (chain walked up to
 *      5 hops). Same caching argument as vendors: the page renderer's
 *      `notFound()` becomes a cached 200 under ISR, so middleware is the
 *      only place that can reliably set non-200 status post-rename.
 *   4. Blog slug-rename / consolidation redirect — `/blog/<slug>`. When the
 *      slug doesn't resolve to a live post, walk blog_slug_history (max 5
 *      hops) and 301 to the canonical slug. Covers both rename (title
 *      change regenerates slug — PUT /api/blog-posts/[slug]) and
 *      consolidation (DELETE ...?successor=<slug>) cases.
 *   5. Claude read-only Bearer method gate — for any request to /admin/* or
 *      /api/admin/* with `Authorization: Bearer <CLAUDE_READONLY_TOKEN>`,
 *      enforce that the method is one of GET/HEAD/OPTIONS. Anything else
 *      gets a 403 at the edge before any route handler runs. The actual
 *      authorize-by-Bearer happens in src/lib/api-auth.ts (for /api/admin
 *      routes) and src/app/admin/layout.tsx (for /admin pages); this gate is
 *      a defense-in-depth for the read-only invariant.
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
    // Event detail pages (single slug only; not /events itself, not state
    // pages like /events/maine, not category pages, not /events/past, etc.
    // Those are handled by their own static routes — see app/events/).
    "/events/:slug",
    // Blog detail pages (single slug only; not /blog itself, not /blog/tag/*,
    // not /blog/feed.xml — feed.xml is excluded by name below).
    "/blog/:slug",
    // Admin pages + admin API routes — for the Claude read-only Bearer
    // method gate. Matcher does NOT cover /admin or /api/admin themselves
    // (only `/<seg>/*` shapes), so the gate doesn't fire for the listing
    // pages — no big deal because the gate is method-based, not path-based,
    // and the layout/route auth still runs.
    "/admin/:path*",
    "/api/admin/:path*",
  ],
};

// Static event sub-routes that share the /events/<slug> shape but must NOT
// be intercepted by the event status check. Order matters: any new state
// page or category page added under app/events/ should be added here too.
const EVENT_STATIC_SUBROUTES = new Set([
  "all",
  "past",
  "maine",
  "vermont",
  "new-hampshire",
  "massachusetts",
  "connecticut",
  "rhode-island",
  "fairs",
  "festivals",
  "craft-shows",
  "craft-fairs",
  "markets",
  "farmers-markets",
]);

// Static blog sub-routes that share the /blog/<slug> shape but must NOT be
// intercepted by the blog slug check. `feed.xml` is the RSS feed served by
// app/blog/feed.xml/route.ts; any future static blog routes (e.g. an
// /blog/archive page) should be added here.
const BLOG_STATIC_SUBROUTES = new Set(["feed.xml"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function bearerHeaderPresent(request: NextRequest): boolean {
  const h = request.headers.get("authorization");
  return !!h && h.startsWith("Bearer ");
}

function bearerMatchesEnv(request: NextRequest, env: Record<string, unknown>): boolean {
  const h = request.headers.get("authorization");
  if (!h || !h.startsWith("Bearer ")) return false;
  const presented = h.slice("Bearer ".length).trim();
  if (!presented) return false;
  const expected = (env as { CLAUDE_READONLY_TOKEN?: string }).CLAUDE_READONLY_TOKEN;
  if (!expected) return false;
  return presented === expected;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let env: Record<string, unknown> | null = null;
  try {
    env = getRequestContext().env as unknown as Record<string, unknown>;
  } catch {
    // Outside the Cloudflare runtime (local `next build`) — fall through.
    return NextResponse.next();
  }

  // ── /admin/* + /api/admin/* — read-only Bearer method gate ─────
  // For requests carrying a valid CLAUDE_READONLY_TOKEN Bearer header,
  // reject any non-safe method at the edge with 403. Bypass for cookie /
  // X-Internal-Key auth flows (those don't carry an Authorization: Bearer
  // header). Cheap: header check + one env read; no DB.
  if (pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) {
    if (bearerHeaderPresent(request) && bearerMatchesEnv(request, env)) {
      if (!SAFE_METHODS.has(request.method)) {
        return NextResponse.json(
          {
            error: "Read-only token cannot perform mutations",
            method: request.method,
          },
          { status: 403 }
        );
      }
    }
    // Either no Bearer, wrong Bearer, or Bearer + safe method — let the
    // layout / route handler authorize. Don't fall through to the keyfile
    // / vendor branches below; they don't apply.
    return NextResponse.next();
  }

  // ── /events/<slug> ─────────────────────────────────────────────
  // Status check (REJECTED → 410, non-public → 404) and slug-rename 301
  // redirect via event_slug_history. Runs before ISR cache so a REJECTED
  // event can't continue serving as cached 200 HTML.
  if (pathname.startsWith("/events/")) {
    const slug = pathname.slice("/events/".length);
    // Skip empty slug, sub-paths, and the static state/category sub-routes
    // (those are real Next.js routes that need to render normally).
    if (!slug || slug.includes("/") || EVENT_STATIC_SUBROUTES.has(slug)) {
      return NextResponse.next();
    }

    const d1 = env.DB as D1Database | undefined;
    if (!d1) return NextResponse.next();
    const db = drizzle(d1);

    try {
      const [row] = await db
        .select({ status: events.status, lifecycleStatus: events.lifecycleStatus })
        .from(events)
        .where(eq(events.slug, unsafeSlug(slug)))
        .limit(1);

      if (row) {
        // Event exists at this slug — gate by editorial + lifecycle status.
        if (row.status === "REJECTED") {
          // 410 Gone: crawlers treat as "intentionally removed, drop from
          // index" — sharper signal than 404 for content we deliberately
          // pulled from the public set (vs 404 = "we have no idea what this
          // is", which crawlers retry).
          return new NextResponse("Gone", {
            status: 410,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        if (!isPubliclyVisible(row.status, row.lifecycleStatus as EventLifecycle)) {
          // Hidden by either editorial (DRAFT/PENDING/legacy-CANCELLED) or
          // lifecycle (lifecycle CANCELLED/NO_SHOW). 404 rather than 410:
          // these may transition back to public (a CANCELLED-lifecycle event
          // can be uncancelled; a DRAFT can be approved). We don't want
          // crawlers to drop the URL permanently.
          return new NextResponse("Not Found", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        // Public — let the page render.
        return NextResponse.next();
      }

      // No event at this slug — walk slug history (max 5 hops) for a 301.
      let cursor = slug;
      const seen = new Set<string>([cursor]);
      for (let hop = 0; hop < 5; hop++) {
        const [historyRow] = await db
          .select({ newSlug: eventSlugHistory.newSlug })
          .from(eventSlugHistory)
          .where(eq(eventSlugHistory.oldSlug, unsafeSlug(cursor)))
          .orderBy(desc(eventSlugHistory.changedAt))
          .limit(1);
        if (!historyRow || seen.has(historyRow.newSlug)) break;
        cursor = historyRow.newSlug;
        seen.add(cursor);
      }
      if (cursor !== slug) {
        // Verify the chain terminus is a live, public event before 301-ing
        // (otherwise we'd 301 into a 410 / 404 chain).
        const [target] = await db
          .select({ status: events.status })
          .from(events)
          .where(and(eq(events.slug, unsafeSlug(cursor)), publicEventWhere()))
          .limit(1);
        if (target) {
          const url = request.nextUrl.clone();
          url.pathname = `/events/${cursor}`;
          return NextResponse.redirect(url, 301);
        }
      }
      // Fall through — the page renderer's notFound() will display the
      // "Event Not Found" UI (cached 200 under ISR; acceptable for
      // genuinely-unknown slugs that have no rename history).
      return NextResponse.next();
    } catch {
      // DB error — let the page handler take over.
      return NextResponse.next();
    }
  }

  // ── /blog/<slug> ───────────────────────────────────────────────
  // Slug-rename / consolidation redirect. If the slug resolves to a live
  // blog post, fall through to the page renderer. If not, walk
  // blog_slug_history (up to 5 hops) and 301 to the canonical slug.
  // Static subroutes like feed.xml are explicitly excluded.
  if (pathname.startsWith("/blog/")) {
    const slug = pathname.slice("/blog/".length);
    if (!slug || slug.includes("/") || BLOG_STATIC_SUBROUTES.has(slug)) {
      return NextResponse.next();
    }

    const d1 = env.DB as D1Database | undefined;
    if (!d1) return NextResponse.next();
    const db = drizzle(d1);

    try {
      // Live post at this slug → render normally.
      const [post] = await db
        .select({ id: blogPosts.id })
        .from(blogPosts)
        .where(eq(blogPosts.slug, unsafeSlug(slug)))
        .limit(1);
      if (post) return NextResponse.next();

      // No post → walk slug history. Same shape as the events branch
      // above (max 5 hops, dedupe to break cycles).
      let cursor = slug;
      const seen = new Set<string>([cursor]);
      for (let hop = 0; hop < 5; hop++) {
        const [historyRow] = await db
          .select({ newSlug: blogSlugHistory.newSlug })
          .from(blogSlugHistory)
          .where(eq(blogSlugHistory.oldSlug, unsafeSlug(cursor)))
          .orderBy(desc(blogSlugHistory.changedAt))
          .limit(1);
        if (!historyRow || seen.has(historyRow.newSlug)) break;
        cursor = historyRow.newSlug;
        seen.add(cursor);
      }
      if (cursor !== slug) {
        // Verify the terminus is a live blog post before 301-ing.
        // (Status filter intentionally absent: a DRAFT post would still
        // 301 from its old slug, then the page renderer enforces
        // admin-only visibility.)
        const [target] = await db
          .select({ id: blogPosts.id })
          .from(blogPosts)
          .where(eq(blogPosts.slug, unsafeSlug(cursor)))
          .limit(1);
        if (target) {
          const url = request.nextUrl.clone();
          url.pathname = `/blog/${cursor}`;
          return NextResponse.redirect(url, 301);
        }
      }
      return NextResponse.next();
    } catch {
      return NextResponse.next();
    }
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
        .where(eq(vendors.slug, unsafeSlug(slug)))
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
