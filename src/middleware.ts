import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, desc, inArray } from "drizzle-orm";
import { canonicalParentSlugFor, timingSafeEqualString } from "@takemetothefair/utils";
import {
  vendors,
  events,
  eventSeries,
  eventSlugHistory,
  seriesSlugHistory,
  blogPosts,
  blogSlugHistory,
  venues,
  venueSlugHistory,
  promoters,
  promoterSlugHistory,
  performers,
  performerSlugHistory,
} from "@/lib/db/schema";
import { isPubliclyVisible, publicEventWhere, type EventLifecycle } from "@/lib/event-lifecycle";
import {
  buildEntityEtag,
  hasSessionCookie,
  isNotModified,
  matchConditionalRoute,
  type ConditionalEntityType,
} from "@/lib/conditional-get";
import { getHelpArticle } from "@/lib/help-articles";
import { unsafeSlug } from "@/lib/utils";
import { shouldSample, writeRequestSample } from "@/lib/request-sampling";

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
    // Venue + promoter detail pages — for the slug-history walker added by
    // E remainder (Dev backlog 2026-06-05). Pre-PR, merge_venue /
    // merge_promoter wrote tombstone-renamed slugs but the old slugs 404'd
    // instead of 301-redirecting.
    "/venues/:slug",
    "/promoters/:slug",
    // Performer detail pages (OPE-115) — slug-history walker for merge/alias renames.
    "/performers/:slug",
    // Singular typo paths (OPE-87) — a stray `/vendor/<slug>` / `/promoter/<slug>`
    // link (e.g. a hand-authored blog typo) 301s to the plural public detail page.
    // Single-segment only, so the private portal sub-routes (/vendor/profile,
    // /promoter/events/new, …) are untouched. A blanket next.config redirect can't
    // do this — real portal pages live under the same singular prefix.
    "/vendor/:slug",
    "/promoter/:slug",
    // OPE-120 — performers have NO singular portal, so every /performer/<slug>
    // 301s to the plural public page (mirrors the vendor/promoter typo redirect).
    "/performer/:slug",
    // Raw-markdown twin of a help article — `/help/<slug>.md` (OPE-62). App
    // Router can't express this as a dynamic route (see the handler comment),
    // so middleware serves it, matching only the `.md` shape so regular
    // `/help/<slug>` HTML pages don't invoke middleware.
    "/help/:file([^/]+\\.md)",
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

async function bearerMatchesEnv(
  request: NextRequest,
  env: Record<string, unknown>
): Promise<boolean> {
  const h = request.headers.get("authorization");
  if (!h || !h.startsWith("Bearer ")) return false;
  const presented = h.slice("Bearer ".length).trim();
  if (!presented) return false;
  const expected = (env as { CLAUDE_READONLY_TOKEN?: string }).CLAUDE_READONLY_TOKEN;
  return timingSafeEqualString(presented, expected);
}

async function handleRouting(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── /help/<slug>.md — raw-markdown twin of a help article (OPE-62) ──────
  // App Router can't express `/help/<slug>.md` as a dynamic route: Next 15
  // treats a `[slug].md` folder as a LITERAL static path (it never lands in
  // routesManifest.dynamicRoutes), and a bare `[slug]` segment is already the
  // help *page*. So we serve the markdown here, before routing — the same
  // technique the IndexNow keyfile uses below. HELP_ARTICLES is a static
  // import (no DB), so this needs no Cloudflare env and runs even in
  // `next build`. The matcher restricts this branch to the `.md` shape.
  if (pathname.startsWith("/help/") && pathname.endsWith(".md")) {
    const slug = pathname.slice("/help/".length, -".md".length);
    const article = getHelpArticle(slug);
    if (!article) {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new NextResponse(article.body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  }

  // ── Singular /vendor/<slug> + /promoter/<slug> → plural (OPE-87) ─────────
  // The public detail pages live at the PLURAL path (/vendors, /promoters); the
  // singular prefix is the private user portal. A stray singular link to a public
  // record (a blog typo, an external link) would otherwise 404 — and, while
  // robots.txt used to block the singular prefix, get indexed URL-only. We 301 it
  // to the plural canonical. The reserved sets are the portal's own nav routes,
  // which must pass through untouched (they're auth-gated + noindex). Pure path
  // rewrite — runs before the env lookup, no DB. Matcher restricts this to a
  // single segment, so multi-segment portal routes (/promoter/events/new) never
  // reach here.
  const VENDOR_PORTAL_ROUTES = new Set([
    "profile",
    "calendar",
    "applications",
    "submissions",
    "suggest-event",
  ]);
  const PROMOTER_PORTAL_ROUTES = new Set(["events"]);
  if (pathname.startsWith("/vendor/")) {
    const seg = pathname.slice("/vendor/".length);
    if (seg && !seg.includes("/") && !VENDOR_PORTAL_ROUTES.has(seg)) {
      const url = request.nextUrl.clone();
      url.pathname = `/vendors/${seg}`;
      return NextResponse.redirect(url, 301);
    }
    return NextResponse.next();
  }
  if (pathname.startsWith("/promoter/")) {
    const seg = pathname.slice("/promoter/".length);
    if (seg && !seg.includes("/") && !PROMOTER_PORTAL_ROUTES.has(seg)) {
      const url = request.nextUrl.clone();
      url.pathname = `/promoters/${seg}`;
      return NextResponse.redirect(url, 301);
    }
    return NextResponse.next();
  }
  // OPE-120 — /performer/<slug> → /performers/<slug>. Performers have no private
  // portal (unlike vendors/promoters), so there are no reserved routes to skip;
  // any single-segment singular path 301s to the plural public detail page. If a
  // performer portal is ever added under /performer/*, add a reserved set here.
  if (pathname.startsWith("/performer/")) {
    const seg = pathname.slice("/performer/".length);
    if (seg && !seg.includes("/")) {
      const url = request.nextUrl.clone();
      url.pathname = `/performers/${seg}`;
      return NextResponse.redirect(url, 301);
    }
    return NextResponse.next();
  }

  let env: Record<string, unknown> | null = null;
  try {
    env = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    // Outside the Cloudflare runtime (local `next build`) — fall through.
    return NextResponse.next();
  }

  // ── A9 — edge request sampling ─────────────────────────────────
  // Sample a small slice of PUBLIC page requests (UA/IP/ASN/path) so the
  // recurring 21st-of-month bot is identifiable from edge data (the zone is
  // Free-plan → no Logpush). Fire-and-forget via ctx.waitUntil; the whole block
  // is wrapped so it can NEVER affect routing or the response. Skips admin/api
  // (our own traffic, not bot targets); coverage is the matcher's detail-page
  // set (events/vendors/venues/blog/promoters) — where a content crawler walks.
  if (
    !pathname.startsWith("/admin") &&
    !pathname.startsWith("/api/") &&
    shouldSample(Math.random())
  ) {
    try {
      const cfCtx = getCloudflareContext();
      const d1 = (cfCtx.env as unknown as { DB?: D1Database }).DB;
      const cf = cfCtx.cf as
        | { asn?: number; asOrganization?: string; country?: string }
        | undefined;
      if (d1) {
        cfCtx.ctx.waitUntil(
          writeRequestSample(drizzle(d1), {
            path: pathname,
            method: request.method,
            userAgent: request.headers.get("user-agent"),
            ip: request.headers.get("cf-connecting-ip"),
            asn: cf?.asn ?? null,
            asOrganization: cf?.asOrganization ?? null,
            country: request.headers.get("cf-ipcountry") ?? cf?.country ?? null,
            referer: request.headers.get("referer"),
            ray: request.headers.get("cf-ray"),
          })
        );
      }
    } catch {
      // sampling must never affect the response path
    }
  }

  // ── /admin/* + /api/admin/* — read-only Bearer method gate ─────
  // For requests carrying a valid CLAUDE_READONLY_TOKEN Bearer header,
  // reject any non-safe method at the edge with 403. Bypass for cookie /
  // X-Internal-Key auth flows (those don't carry an Authorization: Bearer
  // header). Cheap: header check + one env read; no DB.
  if (pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) {
    if (bearerHeaderPresent(request) && (await bearerMatchesEnv(request, env))) {
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
  // ── /events/<series-slug>/<year> — the occurrence form ─────────────
  //
  // OPE-471. The single-segment walker below bails on any path containing a
  // "/", so a retired series slug in the OCCURRENCE form would never have been
  // redirected even once `series_slug_history` existed. The ticket asks for
  // both forms, and this is the one that would have been missed silently.
  //
  // Deliberately narrow: exactly two segments, the second exactly four digits.
  // Anything else falls through to the routes that already handle it.
  {
    const rest = pathname.startsWith("/events/") ? pathname.slice("/events/".length) : "";
    const parts = rest.split("/");
    if (parts.length === 2 && /^\d{4}$/.test(parts[1])) {
      const [seriesSlug, year] = parts;
      const d1 = env.DB as D1Database | undefined;
      if (d1) {
        const db = drizzle(d1);
        try {
          const [live] = await db
            .select({ id: eventSeries.id })
            .from(eventSeries)
            .where(eq(eventSeries.canonicalSlug, unsafeSlug(seriesSlug)))
            .limit(1);
          // Only walk history on a MISS — a live series renders normally.
          if (!live) {
            let cursor = seriesSlug;
            const seen = new Set<string>([cursor]);
            for (let hop = 0; hop < 5; hop++) {
              const [h] = await db
                .select({ newSlug: seriesSlugHistory.newSlug })
                .from(seriesSlugHistory)
                .where(eq(seriesSlugHistory.oldSlug, unsafeSlug(cursor)))
                .orderBy(desc(seriesSlugHistory.changedAt))
                .limit(1);
              if (!h || seen.has(h.newSlug)) break;
              cursor = h.newSlug;
              seen.add(cursor);
            }
            if (cursor !== seriesSlug) {
              const [target] = await db
                .select({ id: eventSeries.id })
                .from(eventSeries)
                .where(eq(eventSeries.canonicalSlug, unsafeSlug(cursor)))
                .limit(1);
              if (target) {
                const url = request.nextUrl.clone();
                // Keep the year: a reader asking for the 2026 edition should
                // land on the 2026 edition, not the hub.
                url.pathname = `/events/${cursor}/${year}`;
                return NextResponse.redirect(url, 301);
              }
            }
          }
        } catch {
          // DB error — let the page handler take over.
        }
      }
    }
  }

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
        .select({
          status: events.status,
          lifecycleStatus: events.lifecycleStatus,
          // EH3 P2.6 — series occurrence → canonical /events/<series>/<year> 301.
          startDate: events.startDate,
          seriesSlug: eventSeries.canonicalSlug,
        })
        .from(events)
        .leftJoin(eventSeries, eq(events.seriesId, eventSeries.id))
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
        // EH3 P2.6 — a public occurrence of a series 301s to its canonical
        // Option-A URL /events/<series-slug>/<year>. Skip when the slug already
        // EQUALS the series canonical slug: that bare slug is the series LANDING
        // (a clean-slug member), which the page must render, not redirect.
        if (row.seriesSlug && row.startDate && slug !== row.seriesSlug) {
          const year = new Date(row.startDate).getUTCFullYear();
          const url = request.nextUrl.clone();
          url.pathname = `/events/${row.seriesSlug}/${year}`;
          return NextResponse.redirect(url, 301);
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
      // OPE-471 — the SERIES leg of the same question.
      //
      // `/events/<slug>` serves two shapes: an event detail page and an
      // evergreen series hub (Option A, deliberate). The event walk above
      // covers the first; a retired SERIES slug had no redirect path at all,
      // because `series_slug_history` did not exist until drizzle/0209.
      //
      // That matters because the hubs due for retirement are the ranking
      // assets: `/events/the-big-e-eastern-states-exposition-ma` holds 19
      // clicks and 2,434 impressions at position 5.1 while its clean twin is
      // unknown to Google. Retiring it without a 301 would spend that.
      //
      // Same 5-hop cap and `seen` set as the event walk — a slug that moved
      // twice needs following, and a cycle must not hang the request.
      let seriesCursor = slug;
      const seriesSeen = new Set<string>([seriesCursor]);
      for (let hop = 0; hop < 5; hop++) {
        const [historyRow] = await db
          .select({ newSlug: seriesSlugHistory.newSlug })
          .from(seriesSlugHistory)
          .where(eq(seriesSlugHistory.oldSlug, unsafeSlug(seriesCursor)))
          .orderBy(desc(seriesSlugHistory.changedAt))
          .limit(1);
        if (!historyRow || seriesSeen.has(historyRow.newSlug)) break;
        seriesCursor = historyRow.newSlug;
        seriesSeen.add(seriesCursor);
      }
      if (seriesCursor !== slug) {
        // Only 301 to a series that still exists — otherwise the redirect
        // lands on a 404, which is worse than the 404 it replaced because it
        // also burns a hop.
        const [targetSeries] = await db
          .select({ id: eventSeries.id })
          .from(eventSeries)
          .where(eq(eventSeries.canonicalSlug, unsafeSlug(seriesCursor)))
          .limit(1);
        if (targetSeries) {
          const url = request.nextUrl.clone();
          url.pathname = `/events/${seriesCursor}`;
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
          id: vendors.id,
          deletedAt: vendors.deletedAt,
          redirectToVendorId: vendors.redirectToVendorId,
          role: vendors.role,
          displayMode: vendors.displayMode,
          displayOverridePermitted: vendors.displayOverridePermitted,
          brandParentVendorId: vendors.brandParentVendorId,
          operatorParentVendorId: vendors.operatorParentVendorId,
          aliasOfVendorId: vendors.aliasOfVendorId,
        })
        .from(vendors)
        .where(eq(vendors.slug, unsafeSlug(slug)))
        .limit(1);
      if (!row) return NextResponse.next();

      // Soft-deleted vendor handling.
      if (row.deletedAt) {
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
      }

      // EH2 brand_parent/operator collapse — a live LOCAL_OFFICE that
      // canonical-ups to a parent (brand_parent or operator_parent mode)
      // should 301 to that hub, so the public never lands on a regional
      // office page. The office row still exists and keeps its event
      // attribution at the data layer; only its public URL redirects.
      // self/both-mode offices (RbA franchises etc.) return null here and
      // render their own page normally. Reuses canonicalParentSlugFor so
      // the 301 target always matches the page's rel=canonical.
      if (row.role === "LOCAL_OFFICE" && (row.brandParentVendorId || row.operatorParentVendorId)) {
        const parentIds = [row.brandParentVendorId, row.operatorParentVendorId].filter(
          (v): v is string => v != null
        );
        const parents = await db
          .select({
            id: vendors.id,
            slug: vendors.slug,
            role: vendors.role,
            defaultChildDisplay: vendors.defaultChildDisplay,
            deletedAt: vendors.deletedAt,
          })
          .from(vendors)
          .where(inArray(vendors.id, parentIds));
        const brandParent = parents.find((p) => p.id === row.brandParentVendorId) ?? null;
        const operatorParent = parents.find((p) => p.id === row.operatorParentVendorId) ?? null;
        const targetSlug = canonicalParentSlugFor(
          {
            role: row.role,
            brandParentVendorId: row.brandParentVendorId,
            operatorParentVendorId: row.operatorParentVendorId,
            aliasOfVendorId: row.aliasOfVendorId,
            displayOverridePermitted: row.displayOverridePermitted,
            displayMode: row.displayMode,
          },
          brandParent
            ? {
                id: brandParent.id,
                role: brandParent.role,
                defaultChildDisplay: brandParent.defaultChildDisplay,
              }
            : null,
          brandParent?.slug ?? null,
          operatorParent?.slug ?? null
        );
        if (targetSlug) {
          // Don't 301 into a deleted parent (would chain into a 410).
          const targetParent = targetSlug === brandParent?.slug ? brandParent : operatorParent;
          if (targetParent && !targetParent.deletedAt) {
            const url = request.nextUrl.clone();
            url.pathname = `/vendors/${targetSlug}`;
            return NextResponse.redirect(url, 301);
          }
        }
      }

      return NextResponse.next();
    } catch {
      // DB error — let the page handler take over (it has its own check too).
      return NextResponse.next();
    }
  }

  // ── /venues/<slug> ─────────────────────────────────────────────
  // E remainder (Dev backlog 2026-06-05): slug-rename redirect via
  // venue_slug_history (drizzle/0109). Same shape as the events branch
  // above: live row at this slug -> render normally; no row -> walk
  // history up to 5 hops, verify terminus is a live venue, 301.
  if (pathname.startsWith("/venues/")) {
    const slug = pathname.slice("/venues/".length);
    if (!slug || slug.includes("/")) return NextResponse.next();

    const d1 = env.DB as D1Database | undefined;
    if (!d1) return NextResponse.next();
    const db = drizzle(d1);

    try {
      const [row] = await db
        .select({ id: venues.id })
        .from(venues)
        .where(eq(venues.slug, unsafeSlug(slug)))
        .limit(1);
      if (row) return NextResponse.next();

      // Walk slug history.
      let cursor = slug;
      const seen = new Set<string>([cursor]);
      for (let hop = 0; hop < 5; hop++) {
        const [historyRow] = await db
          .select({ newSlug: venueSlugHistory.newSlug })
          .from(venueSlugHistory)
          .where(eq(venueSlugHistory.oldSlug, unsafeSlug(cursor)))
          .orderBy(desc(venueSlugHistory.changedAt))
          .limit(1);
        if (!historyRow || seen.has(historyRow.newSlug)) break;
        cursor = historyRow.newSlug;
        seen.add(cursor);
      }
      if (cursor !== slug) {
        const [target] = await db
          .select({ id: venues.id })
          .from(venues)
          .where(eq(venues.slug, unsafeSlug(cursor)))
          .limit(1);
        if (target) {
          const url = request.nextUrl.clone();
          url.pathname = `/venues/${cursor}`;
          return NextResponse.redirect(url, 301);
        }
      }
      return NextResponse.next();
    } catch {
      return NextResponse.next();
    }
  }

  // ── /promoters/<slug> ──────────────────────────────────────────
  // E remainder (Dev backlog 2026-06-05): slug-rename redirect via
  // promoter_slug_history (drizzle/0109). Same shape as venues.
  if (pathname.startsWith("/promoters/")) {
    const slug = pathname.slice("/promoters/".length);
    if (!slug || slug.includes("/")) return NextResponse.next();

    const d1 = env.DB as D1Database | undefined;
    if (!d1) return NextResponse.next();
    const db = drizzle(d1);

    try {
      const [row] = await db
        .select({ id: promoters.id })
        .from(promoters)
        .where(eq(promoters.slug, unsafeSlug(slug)))
        .limit(1);
      if (row) return NextResponse.next();

      let cursor = slug;
      const seen = new Set<string>([cursor]);
      for (let hop = 0; hop < 5; hop++) {
        const [historyRow] = await db
          .select({ newSlug: promoterSlugHistory.newSlug })
          .from(promoterSlugHistory)
          .where(eq(promoterSlugHistory.oldSlug, unsafeSlug(cursor)))
          .orderBy(desc(promoterSlugHistory.changedAt))
          .limit(1);
        if (!historyRow || seen.has(historyRow.newSlug)) break;
        cursor = historyRow.newSlug;
        seen.add(cursor);
      }
      if (cursor !== slug) {
        const [target] = await db
          .select({ id: promoters.id })
          .from(promoters)
          .where(eq(promoters.slug, unsafeSlug(cursor)))
          .limit(1);
        if (target) {
          const url = request.nextUrl.clone();
          url.pathname = `/promoters/${cursor}`;
          return NextResponse.redirect(url, 301);
        }
      }
      return NextResponse.next();
    } catch {
      return NextResponse.next();
    }
  }

  // ── /performers/<slug> ─────────────────────────────────────────
  // OPE-115: slug-rename 301 via performer_slug_history. Same shape as promoters —
  // set_performer_alias / merge_performer write oldSlug → live-canonical newSlug.
  if (pathname.startsWith("/performers/")) {
    const slug = pathname.slice("/performers/".length);
    if (!slug || slug.includes("/")) return NextResponse.next();

    const d1 = env.DB as D1Database | undefined;
    if (!d1) return NextResponse.next();
    const db = drizzle(d1);

    try {
      const [row] = await db
        .select({ id: performers.id })
        .from(performers)
        .where(eq(performers.slug, unsafeSlug(slug)))
        .limit(1);
      if (row) return NextResponse.next();

      let cursor = slug;
      const seen = new Set<string>([cursor]);
      for (let hop = 0; hop < 5; hop++) {
        const [historyRow] = await db
          .select({ newSlug: performerSlugHistory.newSlug })
          .from(performerSlugHistory)
          .where(eq(performerSlugHistory.oldSlug, unsafeSlug(cursor)))
          .orderBy(desc(performerSlugHistory.changedAt))
          .limit(1);
        if (!historyRow || seen.has(historyRow.newSlug)) break;
        cursor = historyRow.newSlug;
        seen.add(cursor);
      }
      if (cursor !== slug) {
        const [target] = await db
          .select({ id: performers.id })
          .from(performers)
          .where(eq(performers.slug, unsafeSlug(cursor)))
          .limit(1);
        if (target) {
          const url = request.nextUrl.clone();
          url.pathname = `/performers/${cursor}`;
          return NextResponse.redirect(url, 301);
        }
      }
      return NextResponse.next();
    } catch {
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

/**
 * OPE-332 — HTTP conditional-request support, layered OVER the routing above.
 *
 * Deliberately a wrapper rather than an edit to each branch. `handleRouting`
 * has ~15 separate exit points (per-entity slug-history walkers, status gates,
 * the series canonicaliser, the keyfile). Threading a 304 check through all of
 * them would mean getting every one right and keeping them right; wrapping the
 * result means the check runs exactly once, after routing has decided.
 *
 * That ordering is the safety property. We only ever consider a 304 when
 * routing produced a plain pass-through — so a pending event that routing
 * 404s, or a renamed slug it 301s, can never be answered "nothing changed".
 */
export async function middleware(request: NextRequest) {
  const response = await handleRouting(request);
  return await applyConditionalGet(request, response);
}

/** Per-type lookup of the validator inputs. Slug is the public identity. */
async function loadEntityMtime(
  db: ReturnType<typeof drizzle>,
  type: ConditionalEntityType,
  slug: string
): Promise<Date | null | undefined> {
  const s = unsafeSlug(slug);
  // `undefined` = no such row (leave routing's answer alone); `null` = found
  // but no timestamp (still validatable — buildEntityEtag stamps it 0).
  switch (type) {
    case "event": {
      const [r] = await db
        .select({ u: events.updatedAt })
        .from(events)
        .where(eq(events.slug, s))
        .limit(1);
      return r ? r.u : undefined;
    }
    case "vendor": {
      const [r] = await db
        .select({ u: vendors.updatedAt })
        .from(vendors)
        .where(eq(vendors.slug, s))
        .limit(1);
      return r ? r.u : undefined;
    }
    case "venue": {
      const [r] = await db
        .select({ u: venues.updatedAt })
        .from(venues)
        .where(eq(venues.slug, s))
        .limit(1);
      return r ? r.u : undefined;
    }
    case "promoter": {
      const [r] = await db
        .select({ u: promoters.updatedAt })
        .from(promoters)
        .where(eq(promoters.slug, s))
        .limit(1);
      return r ? r.u : undefined;
    }
    case "performer": {
      const [r] = await db
        .select({ u: performers.updatedAt })
        .from(performers)
        .where(eq(performers.slug, s))
        .limit(1);
      return r ? r.u : undefined;
    }
    case "blog": {
      const [r] = await db
        .select({ u: blogPosts.updatedAt })
        .from(blogPosts)
        .where(eq(blogPosts.slug, s))
        .limit(1);
      return r ? r.u : undefined;
    }
  }
}

async function applyConditionalGet(
  request: NextRequest,
  response: NextResponse
): Promise<NextResponse> {
  // Only a plain pass-through is eligible. `x-middleware-next` is how
  // NextResponse.next() marks itself, so a redirect, a rewrite, or a
  // constructed body (the IndexNow keyfile) all fall out here untouched.
  if (request.method !== "GET") return response;
  if (!response.headers.has("x-middleware-next")) return response;

  // Personalized chrome (UnverifiedBanner -> auth()) renders into EVERY page,
  // so a signed-in request never gets a shared validator.
  if (hasSessionCookie(request.headers.get("cookie"))) return response;

  const matched = matchConditionalRoute(request.nextUrl.pathname);
  if (!matched) return response;

  let env: Record<string, unknown>;
  try {
    env = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    return response;
  }

  const d1 = env.DB as D1Database | undefined;
  if (!d1) return response;

  let updatedAt: Date | null | undefined;
  try {
    updatedAt = await loadEntityMtime(drizzle(d1), matched.type, matched.slug);
  } catch {
    // A validator is an optimisation; never fail a page render for one.
    return response;
  }
  if (updatedAt === undefined) return response;

  const etag = buildEntityEtag(matched.type, matched.slug, updatedAt);

  if (
    isNotModified({
      ifNoneMatch: request.headers.get("If-None-Match"),
      ifModifiedSince: request.headers.get("If-Modified-Since"),
      etag,
      lastModified: updatedAt,
    })
  ) {
    const headers = new Headers({ ETag: etag });
    if (updatedAt) headers.set("Last-Modified", updatedAt.toUTCString());
    applyPublicCachePolicy(env, headers);
    // 304 carries no body, and must repeat the validator so the client can
    // refresh its stored copy's freshness without another round trip.
    return new NextResponse(null, { status: 304, headers });
  }

  response.headers.set("ETag", etag);
  if (updatedAt) response.headers.set("Last-Modified", updatedAt.toUTCString());
  applyPublicCachePolicy(env, response.headers);
  return response;
}

/**
 * The GATED half (ticket's explicit STOP).
 *
 * Emitting validators is additive and safe. Relaxing `no-store` changes how
 * every public page is served and is customer-facing, so it ships OFF and John
 * flips `CONDITIONAL_GET_PUBLIC_CACHE` in wrangler.toml — not in the dashboard,
 * where a [vars] override is silently wiped by the next deploy (OPE-284).
 *
 * Worth being blunt about the consequence: while this is off, the 304 path
 * above is largely inert, because a client told `no-store` has nothing stored
 * to revalidate. The mechanism is real, the policy is what switches it on.
 *
 * `max-age=0, must-revalidate` when enabled: caches may STORE the response but
 * must revalidate before every reuse. That is what creates the conditional
 * request, while making it impossible to serve stale content.
 */
function applyPublicCachePolicy(env: Record<string, unknown>, headers: Headers): void {
  if (String(env.CONDITIONAL_GET_PUBLIC_CACHE ?? "false") !== "true") return;
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
}
