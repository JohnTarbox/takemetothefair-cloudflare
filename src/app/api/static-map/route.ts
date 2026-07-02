export const dynamic = "force-dynamic";
import type { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { getCloudflareDb } from "@/lib/cloudflare";

/**
 * Static map proxy for the print sheet.
 *
 * Per MMATF-UIUX-PrintSheet-Spec ("Map is the visual anchor, not a
 * photo: ~90% of events have coordinates vs ~19% with images; a
 * static map (from IMG1/coords) anchors the sheet").
 *
 * Why a proxy instead of fronting the URL directly:
 * The `GOOGLE_MAPS_API_KEY` is currently used only server-side for
 * places/geocoding/autocomplete (the four routes under
 * `src/app/api/venues/google-*`). Putting it in client-visible
 * `<img src="…?key=…">` URLs would be the first client-side leak and
 * the broadest abuse surface. This proxy holds the key server-side
 * and returns the image bytes, so the key never crosses the wire.
 *
 * Cache strategy (OPE-46):
 *   Static maps for a given (lat, lng, zoom, size, scale) are
 *   deterministic — we long-cache aggressively. Two layers:
 *     1. Workers Cache API (`caches.default`) — the load-bearing one.
 *        A live probe (2026-07-02) confirmed the immutable
 *        `Cache-Control` header alone did NOT edge-cache this route
 *        (`cf-cache-status` absent, Google re-hit every request),
 *        because the OpenNext Worker fronts the whole zone and
 *        *generates* the response — the CDN cache never sees it. So
 *        we explicitly `match`/`put` in the Worker's own edge cache,
 *        keyed on a NORMALISED (lat,lng,zoom,w,h,scale) URL so every
 *        event at the same venue shares one entry. On a hit we serve
 *        the stored PNG and never call Google.
 *     2. The `Cache-Control: public, max-age=31536000, immutable`
 *        header (kept) — lets any front CDN/Cache Rule cache too.
 *   Observability: `x-cache: HIT|MISS` is set on every 200 so the
 *   cache can be verified with a live probe (the Cache API a Worker
 *   manages is orthogonal to `cf-cache-status`, which only the front
 *   CDN layer emits). Caching is best-effort: any Cache API failure
 *   falls through to a direct Google fetch (current behaviour).
 *
 * Failure mode:
 *   If the API key is missing OR Google returns 4xx/5xx, the route
 *   returns 404 (not 500) so the print sheet's `<img onerror>`
 *   path can gracefully render the alt text + the QR/address
 *   fallback instead of a broken-image icon. The error is logged
 *   to error_logs so ops sees it without breaking the user-facing
 *   print preview.
 *
 * Param validation:
 *   - lat: -90..90
 *   - lng: -180..180
 *   - zoom: 1..21 (Google supports this range)
 *   - w/h: 1..640 (Google free-tier max is 640×640 per image)
 *   - scale: 1 or 2 (HiDPI). Default 2 for print legibility — print
 *     dpi is far above screen and a 2x asset prints crisply.
 *
 * Edge-runtime safe (per CLAUDE.md): no Node APIs, only fetch.
 */

const SOURCE = "app/api/static-map/route.ts:GET";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readNumberParam(
  searchParams: URLSearchParams,
  key: string,
  fallback: number | null
): number | null {
  const raw = searchParams.get(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Required: lat + lng
  const lat = readNumberParam(params, "lat", null);
  const lng = readNumberParam(params, "lng", null);
  if (lat == null || lng == null) {
    return new Response("lat and lng query params required", { status: 400 });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return new Response("lat/lng out of range", { status: 400 });
  }

  // Optional: zoom, w, h, scale
  const zoom = clamp(readNumberParam(params, "zoom", 15) ?? 15, 1, 21);
  const w = clamp(readNumberParam(params, "w", 600) ?? 600, 1, 640);
  const h = clamp(readNumberParam(params, "h", 300) ?? 300, 1, 640);
  // HiDPI by default: print resolution is dramatically higher than
  // screen, so a 2x asset prints crisply without ballooning bytes
  // (Google charges the same per-render whether scale=1 or 2).
  const scaleRaw = readNumberParam(params, "scale", 2) ?? 2;
  const scale = scaleRaw === 1 ? 1 : 2;

  // OPE-46 edge cache — build a NORMALISED cache key so param order and
  // coordinate-string formatting can't fragment the per-venue entry
  // (every event at a venue passes identical venue coords → one entry;
  // e.g. the 40 Vermont Farmers Food Center events share one render).
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.search = "";
  cacheKeyUrl.searchParams.set("lat", String(lat));
  cacheKeyUrl.searchParams.set("lng", String(lng));
  cacheKeyUrl.searchParams.set("zoom", String(zoom));
  cacheKeyUrl.searchParams.set("w", String(w));
  cacheKeyUrl.searchParams.set("h", String(h));
  cacheKeyUrl.searchParams.set("scale", String(scale));
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });

  // Cloudflare Workers edge cache. `caches.default` isn't part of the web
  // `CacheStorage` type, hence the cast; and the global is absent outside
  // the Workers runtime (e.g. under vitest), hence the typeof guard.
  // Best-effort throughout: if the Cache API is unavailable or throws, we
  // fall through to a direct Google fetch (the pre-OPE-46 behaviour).
  const edgeCache =
    typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
  if (edgeCache) {
    try {
      const hit = await edgeCache.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set("x-cache", "HIT");
        return new Response(hit.body, { status: hit.status, headers });
      }
    } catch {
      // cache read failed; continue to origin fetch
    }
  }

  const env = getCloudflareEnv();
  const apiKey = (env as { GOOGLE_MAPS_API_KEY?: string }).GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    // Log + degrade to 404 (not 500) so the print sheet falls back
    // to its QR + address path cleanly.
    try {
      const db = getCloudflareDb();
      await logError(db, {
        message: "GOOGLE_MAPS_API_KEY missing on static-map proxy",
        source: SOURCE,
      });
    } catch {
      // logger may not be wired in some test contexts; swallow.
    }
    return new Response("static map unavailable", { status: 404 });
  }

  // Build the Google Static Maps URL. Centered on lat/lng with a red
  // pin at the same point — the print sheet's audience is "where do
  // I go?" so the pin is the answer.
  //
  // Format choices:
  //   - `maptype=roadmap` is the default and the most legible at
  //     small print sizes (vs satellite which loses detail).
  //   - `format=png` (default) is fine for print; we don't need WebP/
  //     AVIF here since the print path doesn't go through cdnImage.
  const googleUrl = new URL("https://maps.googleapis.com/maps/api/staticmap");
  googleUrl.searchParams.set("center", `${lat},${lng}`);
  googleUrl.searchParams.set("zoom", String(zoom));
  googleUrl.searchParams.set("size", `${w}x${h}`);
  googleUrl.searchParams.set("scale", String(scale));
  googleUrl.searchParams.set("maptype", "roadmap");
  googleUrl.searchParams.set("markers", `color:red|${lat},${lng}`);
  googleUrl.searchParams.set("key", apiKey);

  try {
    const resp = await fetch(googleUrl.toString(), {
      // Cloudflare's cache layer is what makes this proxy cheap. The
      // `cf.cacheTtl` hint tells the CF fetch implementation to hold
      // the upstream response for a year — typical Pages edge cache.
      // (Same TTL we'll advertise to clients via Cache-Control below.)
      cf: { cacheTtl: 31536000, cacheEverything: true },
    } as RequestInit);
    if (!resp.ok) {
      // Log Google's error code (not body, which may contain key
      // hints) and 404 to client.
      try {
        const db = getCloudflareDb();
        await logError(db, {
          message: `Google Static Maps non-OK: ${resp.status}`,
          source: SOURCE,
        });
      } catch {}
      return new Response("upstream error", { status: 404 });
    }
    // Buffer the bytes so we can both store a copy in the edge cache and
    // return one. (A static-map PNG at scale=2 640×320 is tens of KB.)
    const contentType = resp.headers.get("content-type") ?? "image/png";
    const bytes = await resp.arrayBuffer();
    const baseHeaders = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    // Store a clean copy (no x-cache header) under the normalised key.
    // waitUntil so the write never blocks the response; best-effort — a
    // put failure just means this render is recomputed next time.
    if (edgeCache) {
      try {
        const store = new Response(bytes, { status: 200, headers: baseHeaders });
        getCloudflareContext().ctx.waitUntil(edgeCache.put(cacheKey, store));
      } catch {
        // no CF ctx (e.g. tests) or put unsupported; skip caching
      }
    }
    return new Response(bytes, {
      status: 200,
      headers: { ...baseHeaders, "x-cache": "MISS" },
    });
  } catch (e) {
    try {
      const db = getCloudflareDb();
      await logError(db, {
        message: "Static map fetch threw",
        error: e,
        source: SOURCE,
      });
    } catch {}
    return new Response("fetch failed", { status: 404 });
  }
}
