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

const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
const SITE_URL = "https://meetmeatthefair.com/";
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

  // Diagnostic: log a snippet of the raw response so empty-but-200 responses
  // (which Bing returns while data is still accumulating for a fresh site)
  // are visible via `wrangler pages tail`.
  const raw = await res.text();
  console.log(`[Bing] ${endpoint} OK ${raw.length}B: ${raw.slice(0, 200)}`);
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
    const data = await bingFetch<{ d: RawQueryStats[] }>(env, "GetQueryStats");
    return (data.d ?? []).map((row) => {
      const r = row.d ?? (row as unknown as RawQueryStats["d"]);
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
  avgClickPosition: number;
  avgImpressionPosition: number;
};

export async function getPageStats(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingPageRow[]> {
  const cacheKey = `bing:pages:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, REPORT_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<{
      d: Array<{
        Page?: string;
        Clicks?: number;
        Impressions?: number;
        AvgClickPosition?: number;
        AvgImpressionPosition?: number;
      }>;
    }>(env, "GetPageStats");
    return (data.d ?? []).map((r) => ({
      page: r.Page ?? "",
      clicks: r.Clicks ?? 0,
      impressions: r.Impressions ?? 0,
      avgClickPosition: r.AvgClickPosition ?? 0,
      avgImpressionPosition: r.AvgImpressionPosition ?? 0,
    }));
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
    const data = await bingFetch<{
      d: Array<{
        Date?: string;
        CrawledPages?: number;
        CrawlErrors?: number;
        InLinks?: number;
        TotalPagesInIndex?: number;
      }>;
    }>(env, "GetCrawlStats");
    return (data.d ?? []).map((r) => ({
      date: r.Date
        ? new Date(parseInt(r.Date.replace(/\/Date\((\d+)\)\//, "$1"))).toISOString().slice(0, 10)
        : "",
      crawledPages: r.CrawledPages ?? 0,
      crawlErrors: r.CrawlErrors ?? 0,
      inLinks: r.InLinks ?? 0,
      totalPages: r.TotalPagesInIndex ?? 0,
    }));
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
      lastCrawled: r?.LastCrawledDate
        ? new Date(parseInt(r.LastCrawledDate.replace(/\/Date\((\d+)\)\//, "$1"))).toISOString()
        : null,
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

export async function getSitemaps(
  env: BingEnv,
  opts: { skipCache?: boolean } = {}
): Promise<BingSitemap[]> {
  const cacheKey = `bing:sitemaps:${await hashRequest({ site: SITE_URL })}`;
  return withCache(env, cacheKey, META_CACHE_TTL, opts.skipCache ?? false, async () => {
    const data = await bingFetch<{
      d: Array<{
        Url?: string;
        SubmittedDate?: string;
        LastCrawledDate?: string;
        UrlCount?: number;
        Status?: string;
      }>;
    }>(env, "GetFeeds");
    return (data.d ?? []).map((r) => {
      const parseMsDate = (raw: string | undefined) =>
        raw ? new Date(parseInt(raw.replace(/\/Date\((\d+)\)\//, "$1"))).toISOString() : null;
      return {
        url: r.Url ?? "",
        submitted: parseMsDate(r.SubmittedDate),
        lastCrawled: parseMsDate(r.LastCrawledDate),
        urlCount: r.UrlCount ?? 0,
        status: r.Status ?? "Unknown",
      };
    });
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
