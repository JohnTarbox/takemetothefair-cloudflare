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
 * routes; not exposed publicly. Best-effort global rate limit guards Browser
 * Rendering cost. SSRF-guarded (public http/https hosts only).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { extractMetadata } from "@/lib/url-import/html-parser";
import { extractSitemapUrls, looksLikeSitemap } from "@/lib/harvest/parse";
import {
  fetchViaBrowserRendering,
  isBlockedSsrfHost,
  FETCH_TIMEOUT,
  FETCH_UA,
} from "@takemetothefair/site-fetch";
import { logError } from "@/lib/logger";

const bodySchema = z.object({ url: z.string().url() });

// Best-effort global cap on Browser-Rendering-backed fetches per minute. Keyed
// globally (not per-IP): every caller is the internal harvest, so a shared
// fixed window is the meaningful guard on managed-Chrome cost.
const RATE_LIMIT_PER_MIN = 60;

type RawFetch =
  | { ok: true; body: string; contentType: string; finalUrl: string }
  | { ok: false; status: number | null; error: string };

/**
 * Standard fetch that (unlike site-fetch's `fetchStandard`) ACCEPTS XML — DMO
 * sitemaps are `application/xml`, which `fetchStandard` rejects as
 * "content-type". Caller escalates to Browser Rendering on a WAF-block status.
 */
async function standardFetchAllowingXml(url: string, signal: AbortSignal): Promise<RawFetch> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: {
        "User-Agent": FETCH_UA,
        Accept: "application/xml,text/xml,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error && err.name === "AbortError" ? "timeout" : "network",
    };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `http-${res.status}` };
  return {
    ok: true,
    body: await res.text(),
    contentType: res.headers.get("content-type") || "",
    finalUrl: res.url || url,
  };
}

/** WAF-block statuses (+ timeout/network) that a real-browser render can clear. */
function shouldEscalate(status: number | null): boolean {
  return status === null || status === 401 || status === 403 || status === 429;
}

export const POST = withInternalKey({ source: "harvest-fetch" }, async ({ request, db }) => {
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

  const env = getCloudflareEnv() as unknown as {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
    RATE_LIMIT_KV?: KVNamespace;
  };

  // Best-effort global rate limit (fail-open if KV is unbound).
  if (env.RATE_LIMIT_KV) {
    try {
      const windowKey = `harvest-fetch:${Math.floor(Date.now() / 60000)}`;
      const current = parseInt((await env.RATE_LIMIT_KV.get(windowKey)) || "0", 10);
      if (current >= RATE_LIMIT_PER_MIN) {
        return NextResponse.json(
          { success: false, error: "rate_limited" },
          { status: 429, headers: { "Retry-After": "60" } }
        );
      }
      await env.RATE_LIMIT_KV.put(windowKey, String(current + 1), { expirationTtl: 120 });
    } catch {
      // KV hiccup — don't block the fetch on the soft cost-guard.
    }
  }

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
    } else if (shouldEscalate(standard.status)) {
      // 2) WAF-blocked (Simpleview DMOs) → Cloudflare Browser Rendering.
      const escalated = await fetchViaBrowserRendering(parsedUrl.href, env);
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
