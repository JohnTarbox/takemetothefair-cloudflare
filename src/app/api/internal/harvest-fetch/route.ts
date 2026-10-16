export const dynamic = "force-dynamic";
/**
 * OPE-200 — POST /api/internal/harvest-fetch { url }
 *
 * Server-side fetch path for the daily NE event-discovery harvest. The harvest
 * skill's `web_fetch` is provenance-locked (allowlist ≈ meetmeatthefair.com), so
 * its Simpleview/DMO sitemap rules fail 100% unattended (OPE-199). This endpoint
 * fetches any public DMO/aggregator URL server-side (no allowlist), escalating to
 * Cloudflare Browser Rendering when the host WAF-blocks a plain Worker fetch —
 * the same escalation the import-url/fetch route + enrich_promoter already use.
 *
 * Returns BOTH shapes the harvest needs, auto-detected:
 *   - `sitemapUrls`  — `<loc>` URLs when the doc is a sitemap / sitemapindex
 *   - `jsonLdEvents` — per-event Schema.org JSON-LD when the doc is an HTML page
 *
 * Internal-key auth (withInternalKey) — same gate as the other /api/internal/*
 * routes; not exposed publicly. OPE-972 metered rate limit (per caller
 * entrypoint, fail-closed) guards Browser Rendering cost. SSRF-guarded (public
 * http/https hosts only).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { extractMetadata } from "@/lib/url-import/html-parser";
import { extractSitemapUrls, looksLikeSitemap } from "@/lib/harvest/parse";
import {
  fetchViaBrowserRendering,
  guardedFetch,
  isGuardedFetchError,
  isBlockedSsrfHost,
  type GuardedResponse,
  FETCH_TIMEOUT,
  FETCH_UA,
} from "@takemetothefair/site-fetch";
import { logError } from "@/lib/logger";
import { recordBrowserRenderingAttempt } from "@/lib/browser-rendering-attempt";
import { checkRateLimit, meteredCallerIdentifier, rateLimitResponse } from "@/lib/rate-limit";

const bodySchema = z.object({ url: z.string().url() });

type RawFetch =
  | { ok: true; body: string; contentType: string; finalUrl: string }
  | { ok: false; status: number | null; error: string };

/**
 * Standard fetch that (unlike site-fetch's `fetchStandard`) ACCEPTS XML — DMO
 * sitemaps are `application/xml`, which `fetchStandard` rejects as
 * "content-type". Caller escalates to Browser Rendering on a WAF-block status.
 *
 * OPE-1370 (SSRF5) — through `guardedFetch`: every redirect hop re-checked
 * against the SSRF guard (it used to follow 3xx unchecked after the route's
 * first-hop check) and the body capped. 10 MB because a sitemap index can be
 * legitimately large; a refused hop is `forbidden_host` and is not escalated.
 */
const HARVEST_FETCH_MAX_BYTES = 10 * 1024 * 1024;

async function standardFetchAllowingXml(url: string, signal: AbortSignal): Promise<RawFetch> {
  let res: GuardedResponse;
  try {
    res = await guardedFetch(url, {
      signal,
      timeoutMs: 0, // the caller's signal is the deadline
      maxBytes: HARVEST_FETCH_MAX_BYTES,
      headers: {
        "User-Agent": FETCH_UA,
        Accept: "application/xml,text/xml,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
  } catch (err) {
    return { ok: false, ...rawFailure(err) };
  }
  if (!res.ok) {
    res.cancel();
    return { ok: false, status: res.status, error: `http-${res.status}` };
  }
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return { ok: false, ...rawFailure(err) };
  }
  return {
    ok: true,
    body,
    contentType: res.headers.get("content-type") || "",
    finalUrl: res.url,
  };
}

function rawFailure(err: unknown): { status: number | null; error: string } {
  if (isGuardedFetchError(err)) {
    if (err.code === "blocked_host" || err.code === "blocked_protocol") {
      return { status: null, error: "forbidden_host" };
    }
    if (err.code === "too_large") return { status: err.status, error: "too_large" };
    if (err.code === "timeout") return { status: null, error: "timeout" };
    return { status: null, error: "network" };
  }
  return {
    status: null,
    error: err instanceof Error && err.name === "AbortError" ? "timeout" : "network",
  };
}

/** WAF-block statuses (+ timeout/network) that a real-browser render can clear. */
function shouldEscalate(standard: { status: number | null; error: string }): boolean {
  // A refused redirect hop or an oversize body is final — Browser Rendering
  // must not be asked to fetch it instead.
  if (standard.error === "forbidden_host" || standard.error === "too_large") return false;
  const { status } = standard;
  return status === null || status === 401 || status === 403 || status === 429;
}

export const POST = withInternalKey({ source: "harvest-fetch" }, async ({ request, db }) => {
  // OPE-972 — replaces a global 60/min KV cap that failed open (and allowed
  // 86,400 calls a day). Keyed on the MCP entrypoint stamp, not IP: every
  // internal call arrives from the same place.
  const rate = await checkRateLimit(request, "harvest-fetch", {
    metered: { identifier: meteredCallerIdentifier(request, null) },
  });
  if (!rate.allowed) return rateLimitResponse(rate);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "invalid_url" }, { status: 400 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(parsed.data.url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("bad protocol");
  } catch {
    return NextResponse.json({ success: false, error: "invalid_url" }, { status: 400 });
  }
  // SSRF: public hosts only (blocks localhost / private / link-local / encoded IPs).
  if (isBlockedSsrfHost(parsedUrl.hostname)) {
    return NextResponse.json({ success: false, error: "forbidden_host" }, { status: 400 });
  }

  const env = getCloudflareEnv();

  try {
    // 1) Cheap standard fetch (works for public sitemaps + non-WAF hosts).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const standard = await standardFetchAllowingXml(parsedUrl.href, controller.signal);
    clearTimeout(timeoutId);

    let doc: string;
    let finalUrl = parsedUrl.href;
    let fetchMethod: "standard" | "browser-rendering";

    if (standard.ok) {
      doc = standard.body;
      finalUrl = standard.finalUrl;
      fetchMethod = "standard";
    } else if (shouldEscalate(standard)) {
      // 2) WAF-blocked (Simpleview DMOs) → Cloudflare Browser Rendering.
      const escalated = await fetchViaBrowserRendering(parsedUrl.href, env);
      // OPE-694 — the THIRD Browser Rendering call site, which that ticket did
      // not name. Instrumenting only the two in import-url would have left the
      // harvest lane's attempts as invisible as the others were, and a
      // half-instrumented signal is worse than none: the count would read low
      // and nobody would know why.
      await recordBrowserRenderingAttempt(db, {
        url: parsedUrl.href,
        trigger: "status-escalation",
        ok: escalated.ok,
        status: escalated.ok ? 200 : escalated.status,
        error: escalated.ok ? null : escalated.error,
      });
      if (!escalated.ok) {
        await logError(db, {
          level: "warn",
          message: `harvest-fetch failed both paths: standard=${standard.error} br=${escalated.error}`,
          source: "api/internal/harvest-fetch",
          context: {
            url: parsedUrl.href,
            standardStatus: standard.status,
            brStatus: escalated.status,
          },
        });
        return NextResponse.json(
          { success: false, error: "fetch_failed", fetchMethod: "failed" },
          { status: 200 }
        );
      }
      doc = escalated.html;
      fetchMethod = "browser-rendering";
    } else {
      // 404 / other non-escalatable status.
      return NextResponse.json(
        { success: false, error: standard.error, fetchMethod: "failed" },
        { status: 200 }
      );
    }

    // 3) Auto-detect + extract. Sitemaps → <loc> URLs; HTML pages → JSON-LD.
    const isSitemap = looksLikeSitemap(doc);
    const sitemapUrls = isSitemap ? extractSitemapUrls(doc) : [];
    const metadata = isSitemap ? null : extractMetadata(doc);

    return NextResponse.json({
      success: true,
      url: finalUrl,
      fetchMethod,
      kind: sitemapUrls.length > 0 ? "sitemap" : "page",
      sitemapUrls,
      jsonLdEvents: metadata?.jsonLdEvents ?? [],
      title: metadata?.title ?? null,
      description: metadata?.description ?? null,
    });
  } catch (error) {
    await logError(db, {
      message: "harvest-fetch unexpected error",
      error,
      source: "api/internal/harvest-fetch",
      request,
    });
    return NextResponse.json(
      { success: false, error: "unexpected_error", fetchMethod: "failed" },
      { status: 200 }
    );
  }
});
