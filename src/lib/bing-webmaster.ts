/**
 * Bing Webmaster Tools API client.
 *
 * Mirrors the shape of `src/lib/search-console.ts` so the admin UI and MCP
 * tools can layer on top of a familiar surface. Authentication is a single
 * site-wide API key (`BING_WEBMASTER_API_KEY`) appended to every request.
 *
 * API base: https://ssl.bing.com/webmaster/api.svc/json/
 * Docs:     https://learn.microsoft.com/en-us/bingwebmaster/
 *
 * Free tier rate limit is generous (~10k/day) but each report is cached in
 * `RATE_LIMIT_KV` to avoid hammering the API on every admin pageview.
 */

import { SITE_URL as CANONICAL_SITE_URL } from "@takemetothefair/constants";

const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
// Bing's API requires the property URL with a trailing slash; SITE_URL has none.
const SITE_URL = `${CANONICAL_SITE_URL}/`;
const REQUEST_TIMEOUT_MS = 15_000;

const REPORT_CACHE_TTL = 900; // 15 min — search/page/crawl stats
const SCAN_CACHE_TTL = 3600; // 60 min — site scan, slower-changing
const META_CACHE_TTL = 3600; // 60 min — sitemaps, indexnow quota

export type BingEnv = {
  BING_WEBMASTER_API_KEY?: string;
  RATE_LIMIT_KV?: KVNamespace;
};

export class BingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BingConfigError";
  }
}

export class BingApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Bing Webmaster API error ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
    this.name = "BingApiError";
  }
}

function requireApiKey(env: BingEnv): string {
  const key = env.BING_WEBMASTER_API_KEY?.trim();
  if (!key) {
    throw new BingConfigError(
      "Missing BING_WEBMASTER_API_KEY. Generate one at https://www.bing.com/webmasters/ → Settings → API Access, then `wrangler secret put BING_WEBMASTER_API_KEY`."
    );
  }
  return key;
}

async function hashRequest(obj: unknown): Promise<string> {
  const buf = new TextEncoder().encode(JSON.stringify(obj));
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Bing-specific date parser. Folded into the canonical `parseDateLoose`
 * helper in `src/lib/datetime.ts` (which handles the same WCF JSON variant
 * + timezone-offset suffix Bing emits, plus ISO 8601 fallback). Re-exported
 * here as an alias so existing callers / tests don't need updating.
 */
export { parseDateLoose as parseBingDate } from "@/lib/datetime";
import { parseDateLoose } from "@/lib/datetime";

/**
 * Bing's JSON envelope is `{ "d": [...] }` for collections, but the team has
 * been observed to wrap rows differently across API revisions (`{d:{results:[]}}`,
 * `{d:{GetXxxResult:[]}}`, etc.). Pull the row array out of any of the shapes
 * we have seen, falling back to `[]` rather than crashing on `.map()`.
 */
export function extractRows<T>(data: unknown): T[] {
  if (!data || typeof data !== "object") return [];
  const d = (data as { d?: unknown }).d;
  if (Array.isArray(d)) return d as T[];
  if (d && typeof d === "object") {
    const inner =
      (d as { results?: unknown }).results ??
      Object.values(d as Record<string, unknown>).find(Array.isArray);
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

interface BingFetchOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

async function bingFetch<T>(
  env: BingEnv,
  endpoint: string,
  opts: BingFetchOptions = {}
): Promise<T> {
  const apiKey = requireApiKey(env);
  const qs = new URLSearchParams();
  qs.set("siteUrl", SITE_URL);
  qs.set("apikey", apiKey);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) qs.set(k, String(v));
    }
  }

  const url = `${BING_API_BASE}/${endpoint}?${qs.toString()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      signal: controller.signal,
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { Message?: string; ErrorCode?: number };
      if (parsed?.Message) detail = `${parsed.ErrorCode ?? "ERROR"}: ${parsed.Message}`;
    } catch {
      /* keep raw */
    }
    console.error(`[Bing] ${endpoint} ${res.status}: ${detail}`);
    throw new BingApiError(res.status, detail);
  }

  // Diagnostic: log a shape hint + a longer snippet of the raw response so
  // envelope changes (Bing has migrated row shape at least once) are visible
  // via `wrangler pages tail` without needing a redeploy.
  const raw = await res.text();
  let shapeHint = "empty";
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as { d?: unknown };
      const d = parsed?.d;
      if (Array.isArray(d)) {
        shapeHint = `d=array[${d.length}]`;
      } else if (d && typeof d === "object") {
        shapeHint = `d=object{${Object.keys(d).slice(0, 6).join(",")}}`;
      } else {
        shapeHint = `d=${typeof d}`;
      }
    } catch {
      shapeHint = "unparseable";
    }
  }
  console.log(`[Bing] ${endpoint} OK ${raw.length}B ${shapeHint}: ${raw.slice(0, 800)}`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new BingApiError(res.status, `Invalid JSON: ${raw.slice(0, 200)}`);
  }
}

async function withCache<T>(
  env: BingEnv,
  key: string,
  ttl: number,
  skipCache: boolean,
  load: () => Promise<T>
): Promise<T> {
  const kv = env.RATE_LIMIT_KV;
  if (!skipCache && kv) {
    const cached = await kv.get<T>(key, "json");
    if (cached) return cached;
  }
  const fresh = await load();
  if (kv) {
    await kv.put(key, JSON.stringify(fresh), { expirationTtl: ttl });
  }
  return fresh;
}

// ── Search performance ──────────────────────────────────────────────

export type BingQueryRow = {
  query: string;
  clicks: number;
  impressions: number;
  avgClickPosition: number;
  avgImpressionPosition: number;
};

interface RawQueryStats {
  d: {
    Query: string;
    Clicks: number;
    Impressions: number;
    AvgClickPosition: number;
    AvgImpressionPosition: number;
  };
}

export async function getQueryStats(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingQueryRow[]> {
  const cacheKey = `bing:queries:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, REPORT_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<unknown>(env, "GetQueryStats");
    const rows = extractRows<RawQueryStats | RawQueryStats["d"]>(data);
    return rows.map((row) => {
      const r = (row as RawQueryStats).d ?? (row as RawQueryStats["d"]);
      return {
        query: r.Query ?? "",
        clicks: r.Clicks ?? 0,
        impressions: r.Impressions ?? 0,
        avgClickPosition: r.AvgClickPosition ?? 0,
        avgImpressionPosition: r.AvgImpressionPosition ?? 0,
      };
    });
  });
}

// ── Top pages ──────────────────────────────────────────────────────

export type BingPageRow = {
  page: string;
  clicks: number;
  impressions: number;
  // `null` when Bing reports the `-1` "no clicked position" sentinel (or the
  // field is absent) — surfaced as "—" in the UI rather than a bogus 0.
  avgClickPosition: number | null;
  avgImpressionPosition: number;
};

// GetPageStats rows arrive double-wrapped in a per-row `d` envelope, exactly
// like GetQueryStats (RawQueryStats). Mirror that shape so `getPageStats`
// unwraps the same way instead of reading `r.Page` off the wrapper (which is
// undefined → an empty page URL for every row — the OPE-71 FIX 1 bug).
interface RawPageStats {
  d: {
    Page: string;
    Clicks: number;
    Impressions: number;
    AvgClickPosition: number;
    AvgImpressionPosition: number;
  };
}

export async function getPageStats(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingPageRow[]> {
  const cacheKey = `bing:pages:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, REPORT_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<unknown>(env, "GetPageStats");
    const rows = extractRows<RawPageStats | RawPageStats["d"]>(data);
    return rows.map((row) => {
      const r = (row as RawPageStats).d ?? (row as RawPageStats["d"]);
      return {
        page: r.Page ?? "",
        clicks: r.Clicks ?? 0,
        impressions: r.Impressions ?? 0,
        // Bing uses -1 as the "no clicked position" sentinel — normalize to null.
        avgClickPosition: r.AvgClickPosition === -1 ? null : (r.AvgClickPosition ?? 0),
        avgImpressionPosition: r.AvgImpressionPosition ?? 0,
      };
    });
  });
}

// ── Crawl stats ────────────────────────────────────────────────────

export type BingCrawlStatsRow = {
  date: string;
  crawledPages: number;
  crawlErrors: number;
  inLinks: number;
  totalPages: number;
};

export async function getCrawlStats(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingCrawlStatsRow[]> {
  const cacheKey = `bing:crawl:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, REPORT_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<unknown>(env, "GetCrawlStats");
    const rows = extractRows<{
      Date?: unknown;
      CrawledPages?: number;
      CrawlErrors?: number;
      InLinks?: number;
      // Bing renamed `TotalPagesInIndex` → `InIndex` in the current API
      // revision. Accept either; the modern field wins as the fallback.
      TotalPagesInIndex?: number;
      InIndex?: number;
      // Modern Bing CrawlStats also includes per-status-code buckets
      // (Code2xx, Code4xx, Code5xx, BlockedByRobotsTxt, etc.). We only
      // surface the legacy summary fields in the UI today; sum from the
      // newer fields when the legacy ones are absent.
      Code2xx?: number;
      Code301?: number;
      Code302?: number;
      Code4xx?: number;
      Code5xx?: number;
      AllOtherCodes?: number;
      ConnectionTimeout?: number;
    }>(data);
    return rows.map((r) => {
      const parsed = parseDateLoose(r.Date);
      const code2xx = r.Code2xx ?? 0;
      const code301 = r.Code301 ?? 0;
      const code302 = r.Code302 ?? 0;
      const code4xx = r.Code4xx ?? 0;
      const code5xx = r.Code5xx ?? 0;
      const allOther = r.AllOtherCodes ?? 0;
      const timeout = r.ConnectionTimeout ?? 0;
      const summedCrawled = code2xx + code301 + code302 + code4xx + code5xx + allOther;
      const summedErrors = code4xx + code5xx + timeout;
      return {
        date: parsed ? parsed.toISOString().slice(0, 10) : "",
        crawledPages: r.CrawledPages ?? (summedCrawled > 0 ? summedCrawled : 0),
        crawlErrors: r.CrawlErrors ?? (summedErrors > 0 ? summedErrors : 0),
        inLinks: r.InLinks ?? 0,
        totalPages: r.TotalPagesInIndex ?? r.InIndex ?? 0,
      };
    });
  });
}

// ── Crawl issues ──────────────────────────────────────────────────
//
// Bing's manual "Site Scan" tool (the BWT UI section under Site Scan)
// is NOT exposed via the Webmaster API — there is no GetSiteScanResults
// endpoint in IWebmasterApi. The closest API surface is GetCrawlIssues,
// which lists problems Bingbot discovered during normal crawling: 404s,
// blocked-by-robots, server errors, soft-404s, etc. Different data
// source from the manual Site Scan tool but similar diagnostic value.

export type BingSiteScanIssue = {
  issueType: string;
  severity: "Error" | "Warning" | "Notice" | string;
  affectedUrlCount: number;
  affectedUrls: string[];
  detectedAt?: string;
};

interface RawCrawlIssueRow {
  __type?: string;
  Url?: string;
  Issues?: number;
  HttpCode?: number;
}

// Bitmask values for the `Issues` field on a crawl-issue row, from the
// IWebmasterApi CrawlIssues enum. Mapping the most common bits to
// severities so the UI gets meaningful colors.
function decodeCrawlIssueBits(
  bits: number
): Array<{ type: string; severity: "Error" | "Warning" | "Notice" }> {
  const issues: Array<{ type: string; severity: "Error" | "Warning" | "Notice" }> = [];
  if (bits & 1) issues.push({ type: "DNS_FAILURE", severity: "Error" });
  if (bits & 2) issues.push({ type: "HTTP_4XX_5XX", severity: "Error" });
  if (bits & 4) issues.push({ type: "BLOCKED_BY_ROBOTS", severity: "Error" });
  if (bits & 8) issues.push({ type: "EXCLUDED_FROM_INDEX", severity: "Warning" });
  if (bits & 16) issues.push({ type: "MALFORMED_HEADERS", severity: "Warning" });
  if (bits & 32) issues.push({ type: "SERVER_ERROR_5XX", severity: "Error" });
  if (bits & 64) issues.push({ type: "SLOW_RESPONSE", severity: "Warning" });
  if (issues.length === 0) issues.push({ type: "UNKNOWN_ISSUE", severity: "Notice" });
  return issues;
}

export async function getSiteScanIssues(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingSiteScanIssue[]> {
  const cacheKey = `bing:crawl-issues:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, SCAN_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<{ d?: RawCrawlIssueRow[] }>(env, "GetCrawlIssues");
    const rows = data.d ?? [];
    // Group rows by issue type so the UI shows "Blocked by robots.txt — 2 URLs"
    // instead of one row per affected URL.
    const grouped = new Map<string, BingSiteScanIssue>();
    for (const row of rows) {
      if (!row.Url) continue;
      const decoded = decodeCrawlIssueBits(row.Issues ?? 0);
      for (const { type, severity } of decoded) {
        const key = `${type}|${severity}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.affectedUrlCount++;
          existing.affectedUrls.push(row.Url);
        } else {
          grouped.set(key, {
            issueType: type,
            severity,
            affectedUrlCount: 1,
            affectedUrls: [row.Url],
          });
        }
      }
    }
    return [...grouped.values()];
  });
}

// ── Daily traffic time-series (GetRankAndTrafficStats) ──────────────
//
// K50 — the per-day impressions/clicks series, the Bing counterpart to GSC's
// getDailyClicks. GetQueryStats/GetPageStats give the query/page breakdowns but
// not the daily site overview; this fills that gap. Cheap to persist alongside
// the A12 GSC trend store (the analyst's "do for Bing what A12 does for GSC").

export type BingTrafficStatsRow = {
  date: string; // YYYY-MM-DD
  impressions: number;
  clicks: number;
};

export async function getTrafficStats(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingTrafficStatsRow[]> {
  const cacheKey = `bing:traffic:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, REPORT_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<unknown>(env, "GetRankAndTrafficStats");
    const rows = extractRows<{
      Date?: unknown;
      Impressions?: number;
      Clicks?: number;
    }>(data);
    return rows
      .map((r) => {
        const parsed = parseDateLoose(r.Date);
        return {
          date: parsed ? parsed.toISOString().slice(0, 10) : "",
          impressions: r.Impressions ?? 0,
          clicks: r.Clicks ?? 0,
        };
      })
      .filter((r) => r.date);
  });
}

// ── Backlinks / inbound links (GetLinkCounts) ───────────────────────
//
// K50 — site pages that have inbound links, with counts. Surfaces the
// "site has only N referring domains" finding that previously came from a hand
// export. `page` is Bing's pagination index (each page returns a fixed slice).

export type BingBacklinkRow = {
  url: string;
  inboundLinks: number;
};

export async function getBacklinks(
  env: BingEnv,
  opts: { page?: number; skipCache?: boolean } = {}
): Promise<BingBacklinkRow[]> {
  const page = opts.page ?? 0;
  const cacheKey = `bing:backlinks:${await hashRequest({ site: SITE_URL, page })}`;
  return withCache(env, cacheKey, SCAN_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<unknown>(env, "GetLinkCounts", { query: { page } });
    const rows = extractRows<{ Url?: string; Count?: number }>(data);
    return rows.map((r) => ({ url: r.Url ?? "", inboundLinks: r.Count ?? 0 }));
  });
}

// ── Bulk crawled / child-URL list (GetChildrenUrlInfo) ──────────────
//
// K50 — paginated index details for the URLs under a directory (default: site
// root). GetUrlInfo is single-URL; this is the bulk list SEO-CRAWL1 used to find
// the /register crawl-budget leak. `dir` is the directory to enumerate; `page`
// is Bing's pagination index.

export type BingCrawledUrlRow = {
  url: string;
  isPage: boolean | null;
  lastCrawled: string | null;
  discoveryDate: string | null;
  totalChildUrlCount: number;
};

export async function getCrawledUrls(
  env: BingEnv,
  opts: { dir?: string; page?: number; skipCache?: boolean } = {}
): Promise<BingCrawledUrlRow[]> {
  const dir = opts.dir?.trim() || SITE_URL;
  const page = opts.page ?? 0;
  const cacheKey = `bing:crawled-urls:${await hashRequest({ dir, page })}`;
  return withCache(env, cacheKey, SCAN_CACHE_TTL, opts.skipCache ?? false, async () => {
    // OPE-51 (live-verified 2026-07-02): GetChildrenUrlInfo is POST-only — a GET
    // returns 405 (surfaces as the reported 5xx). Bing also throws an internal
    // null-ref (ErrorCode 2 / HTTP 400 "Object reference not set…") when it has
    // no crawl-children dataset for the site; treat that as an empty result
    // rather than a hard error so the tool degrades cleanly.
    let data: unknown;
    try {
      data = await bingFetch<unknown>(env, "GetChildrenUrlInfo", {
        method: "POST",
        body: { siteUrl: SITE_URL, url: dir, page },
      });
    } catch (e) {
      if (e instanceof BingApiError && /object reference not set/i.test(e.detail)) {
        return [];
      }
      throw e;
    }
    const rows = extractRows<{
      Url?: string;
      IsPage?: boolean;
      LastCrawledDate?: unknown;
      DiscoveryDate?: unknown;
      TotalChildUrlCount?: number;
    }>(data);
    return rows.map((r) => ({
      url: r.Url ?? "",
      isPage: r.IsPage ?? null,
      lastCrawled: parseDateLoose(r.LastCrawledDate)?.toISOString() ?? null,
      discoveryDate: parseDateLoose(r.DiscoveryDate)?.toISOString() ?? null,
      totalChildUrlCount: r.TotalChildUrlCount ?? 0,
    }));
  });
}

// ── URL inspection ─────────────────────────────────────────────────

export type BingUrlInfo = {
  url: string;
  isIndexed: boolean | null;
  lastCrawled: string | null;
  crawlError: string | null;
  totalLinks: number;
};

export async function getUrlInfo(
  env: BingEnv,
  url: string,
  opts: { skipCache?: boolean } = {}
): Promise<BingUrlInfo> {
  const cacheKey = `bing:url:${await hashRequest({ url })}`;
  return withCache(env, cacheKey, REPORT_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<{
      d?: {
        Url?: string;
        IsPage?: boolean;
        LastCrawledDate?: string;
        CrawlError?: string;
        TotalChildUrlCount?: number;
        DiscoveryDate?: string;
      };
    }>(env, "GetUrlInfo", { query: { url } });
    const r = data.d;
    return {
      url: r?.Url ?? url,
      isIndexed: r?.IsPage ?? null,
      lastCrawled: parseDateLoose(r?.LastCrawledDate)?.toISOString() ?? null,
      crawlError: r?.CrawlError ?? null,
      totalLinks: r?.TotalChildUrlCount ?? 0,
    };
  });
}

// ── Sitemaps ───────────────────────────────────────────────────────

export type BingSitemap = {
  url: string;
  submitted: string | null;
  lastCrawled: string | null;
  urlCount: number;
  status: string;
};

/**
 * Return the first `parseDateLoose`-parseable value found among a candidate
 * list of field names on a row, else null. Defensive because Bing's GetFeeds
 * date field names could NOT be live-verified — the BING_WEBMASTER_API_KEY is a
 * wrangler secret, so we can't probe the real response shape from here. Trying a
 * small candidate list per logical field means a field-name drift (or a revision
 * that uses `SubmittedDateTime` instead of `SubmittedDate`) still maps through
 * instead of silently rendering "—".
 */
function firstDate(r: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const parsed = parseDateLoose(r[name]);
    if (parsed) return parsed.toISOString();
  }
  return null;
}

export async function getSitemaps(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingSitemap[]> {
  const cacheKey = `bing:sitemaps:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, META_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<unknown>(env, "GetFeeds");
    const rows = extractRows<Record<string, unknown>>(data);
    return rows.map((r) => ({
      url: typeof r.Url === "string" ? r.Url : "",
      // Candidate field-name lists: exact GetFeeds names are unverified (key is
      // a secret), so try the plausible spellings and keep the null fallback.
      submitted: firstDate(r, ["SubmittedDate", "SubmittedDateTime", "SubmittedTime"]),
      lastCrawled: firstDate(r, ["LastCrawledDate", "LastCrawled", "LastCrawlDate"]),
      urlCount: typeof r.UrlCount === "number" ? r.UrlCount : 0,
      status: typeof r.Status === "string" ? r.Status : "Unknown",
    }));
  });
}

// ── IndexNow / URL submission quota ────────────────────────────────

export type BingIndexNowQuota = {
  dailyQuota: number;
  monthlyQuota: number;
  dailyRemaining: number;
  monthlyRemaining: number;
};

export async function getIndexNowQuota(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingIndexNowQuota> {
  const cacheKey = `bing:quota:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, META_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<{
      d?: {
        DailyQuota?: number;
        MonthlyQuota?: number;
        DailyUsed?: number;
        MonthlyUsed?: number;
      };
    }>(env, "GetUrlSubmissionQuota");
    const r = data.d ?? {};
    const dailyQuota = r.DailyQuota ?? 0;
    const monthlyQuota = r.MonthlyQuota ?? 0;
    return {
      dailyQuota,
      monthlyQuota,
      dailyRemaining: Math.max(0, dailyQuota - (r.DailyUsed ?? 0)),
      monthlyRemaining: Math.max(0, monthlyQuota - (r.MonthlyUsed ?? 0)),
    };
  });
}

// ── Sitemap submission ──────────────────────────────────────────────

/**
 * Re-submit a sitemap to Bing Webmaster via the SubmitFeed endpoint.
 * Distinct from IndexNow (which is for individual content URLs) — this is
 * the explicit "go re-fetch my sitemap" signal that mirrors GSC's
 * `submitSitemap`. Useful after segmented-sitemap-index changes where
 * Bing's `get_bing_sitemaps` shows null submission timestamps.
 *
 * The API returns 200 OK with an empty body on success; errors bubble up
 * through bingFetch's BingApiError.
 */
export async function submitFeed(env: BingEnv, feedUrl: string): Promise<{ feedUrl: string }> {
  if (!feedUrl || !/^https?:\/\//i.test(feedUrl)) {
    throw new BingConfigError(`Invalid feedUrl: ${feedUrl}`);
  }
  await bingFetch<unknown>(env, "SubmitFeed", {
    method: "POST",
    body: { siteUrl: SITE_URL, feedUrl },
  });
  return { feedUrl };
}
