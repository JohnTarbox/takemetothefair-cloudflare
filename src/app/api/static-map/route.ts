import type { NextRequest } from "next/server";
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
 * Cache strategy:
 *   Static maps for a given (lat, lng, zoom, size, scale) are
 *   deterministic — we can long-cache aggressively. The response
 *   sets `Cache-Control: public, max-age=31536000, immutable` so
 *   Cloudflare's edge holds the bytes for a year per unique URL.
 *   Per-event coords change rarely; cache hit rate should be ~100%
 *   after the first print of each event.
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
export const runtime = "edge";

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
    // Pass through the bytes + content-type, override the cache
    // header to our long-immutable policy. CF edge handles fan-out
    // from then on.
    const contentType = resp.headers.get("content-type") ?? "image/png";
    return new Response(resp.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
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
