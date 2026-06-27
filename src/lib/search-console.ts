import {
  getGoogleAccessToken,
  GoogleAuthConfigError,
  GoogleAuthError,
  type GoogleAuthEnv,
} from "./google-auth";
import { resolveDateRange, type DateRangeInput, type ResolvedDateRange } from "./analytics-params";
import { parseDateLoose } from "@/lib/datetime";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";

// Normalize an external-API date passthrough field into a canonical ISO 8601
// string (or null if the value is missing/unparseable). Without this, GSC's
// internal date format leaked into our consumers and any change in their
// serialization could surprise downstream code.
function normalizeApiDate(raw: unknown): string | null {
  return parseDateLoose(raw)?.toISOString() ?? null;
}

const SC_API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const SC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const SC_TOKEN_CACHE_KEY = "sc:access_token";
// Write scope (full `webmasters`, not `.readonly`) is used only by the
// sitemap-submit path. Tokens cache separately from the read token because
// they're keyed by scope at the Google OAuth layer — sharing the cache key
// would produce the wrong scope on cache hit.
const SC_WRITE_SCOPE = "https://www.googleapis.com/auth/webmasters";
const SC_WRITE_TOKEN_CACHE_KEY = "sc:access_token_write";
// Google Indexing API — separate API surface, separate OAuth scope. Used by
// the request_indexing MCP tool to nudge Google's crawl queue for individual
// URLs (e.g. blog posts stuck in "Discovered – currently not indexed"). The
// Indexing API is officially scoped to JobPosting and BroadcastEvent schemas
// but empirically accepts other URL types as recrawl signals. Token cached
// separately for the same scope-keying reason as SC_WRITE.
const INDEXING_API_BASE = "https://indexing.googleapis.com/v3";
const INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing";
const INDEXING_TOKEN_CACHE_KEY = "sc:access_token_indexing";
const REPORT_CACHE_TTL = 900;
const REQUEST_TIMEOUT_MS = 10_000;

export type ScEnv = GoogleAuthEnv & {
  SC_SITE_URL?: string;
};

export class ScConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScConfigError";
  }
}

export class ScApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Search Console API error ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
    this.name = "ScApiError";
  }
}

export type SearchQueryRow = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/**
 * A8 (Dev-Email-2026-06-13 §C1) — write an `error_logs` row for a GSC API
 * failure so it's catchable by the nightly error-log sweep / REL1 §0 burst-watch
 * canary, not just surfaced inline in the /admin/analytics widget.
 *
 * Motivated by MIG7: the GSC "User does not have sufficient permission" 403 ran
 * live for >24h (site_ctr + brand_share KPIs INDETERMINATE) without ever
 * writing an error_logs row — only John eyeballing the dashboard caught it.
 *
 * Pure observability: best-effort, never throws, never changes the happy path
 * or the error that callers see (the ScApiError is still thrown by the caller).
 * Mirrors the static-map + cron logging pattern.
 */
async function recordScFailure(
  fn: string,
  env: ScEnv,
  status: number | null,
  detail: string,
  url?: string
): Promise<void> {
  // Refine the source label from the GSC endpoint when we have the response URL
  // so triage shows WHICH call failed (the spec's `:<fn>` suffix).
  let op = fn;
  if (url) {
    if (url.includes("searchAnalytics")) op = "searchAnalytics";
    else if (url.includes("/sitemaps")) op = "sitemaps";
    else if (url.includes("urlInspection")) op = "urlInspection";
    else if (url.includes("urlNotifications")) op = "indexing";
  }
  try {
    const db = getCloudflareDb();
    await logError(db, {
      source: `lib/search-console:${op}`,
      message: `GSC API failure (${op}, HTTP ${status ?? "?"}): ${detail.slice(0, 300)}`,
      statusCode: status ?? undefined,
      level: "error",
      context: { op, scSiteUrl: env.SC_SITE_URL ?? null, detail: detail.slice(0, 500), url },
    });
  } catch {
    /* observability only — never break the GSC call path on a logging hiccup */
  }
}

function resolveSiteUrl(env: ScEnv): string {
  const site = env.SC_SITE_URL?.trim();
  if (!site) {
    throw new ScConfigError(
      "Missing SC_SITE_URL. Set to the Search Console property, e.g. 'sc-domain:meetmeatthefair.com' or 'https://meetmeatthefair.com/'."
    );
  }
  return site;
}

async function getAccessToken(env: ScEnv, skipCache: boolean): Promise<string> {
  try {
    return await getGoogleAccessToken(env, SC_SCOPE, {
      skipCache,
      cacheKey: SC_TOKEN_CACHE_KEY,
    });
  } catch (error) {
    if (error instanceof GoogleAuthConfigError) throw new ScConfigError(error.message);
    if (error instanceof GoogleAuthError) {
      await recordScFailure("token-acquisition", env, error.status, error.detail);
      throw new ScApiError(error.status, error.detail);
    }
    throw error;
  }
}

async function getWriteAccessToken(env: ScEnv, skipCache: boolean): Promise<string> {
  try {
    return await getGoogleAccessToken(env, SC_WRITE_SCOPE, {
      skipCache,
      cacheKey: SC_WRITE_TOKEN_CACHE_KEY,
    });
  } catch (error) {
    if (error instanceof GoogleAuthConfigError) throw new ScConfigError(error.message);
    if (error instanceof GoogleAuthError) {
      await recordScFailure("token-acquisition", env, error.status, error.detail);
      throw new ScApiError(error.status, error.detail);
    }
    throw error;
  }
}

async function getIndexingAccessToken(env: ScEnv, skipCache: boolean): Promise<string> {
  try {
    return await getGoogleAccessToken(env, INDEXING_SCOPE, {
      skipCache,
      cacheKey: INDEXING_TOKEN_CACHE_KEY,
    });
  } catch (error) {
    if (error instanceof GoogleAuthConfigError) throw new ScConfigError(error.message);
    if (error instanceof GoogleAuthError) {
      await recordScFailure("token-acquisition", env, error.status, error.detail);
      throw new ScApiError(error.status, error.detail);
    }
    throw error;
  }
}

async function hashRequest(obj: unknown): Promise<string> {
  const buf = new TextEncoder().encode(JSON.stringify(obj));
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function pageUrlForFilter(siteUrl: string, path: string): string {
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length);
    return `https://${domain}${path}`;
  }
  const base = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl;
  return `${base}${path}`;
}

function resolveScRange(
  input: DateRangeInput | undefined,
  defaultPreset: "last_28d" | "last_30d" | "last_90d" = "last_30d"
): ResolvedDateRange {
  const usesCustomRange = !!(input?.startDate || input?.preset);
  if (usesCustomRange) return resolveDateRange(input, { defaultPreset });
  // Default: last 30 days ending 3 days ago (GSC has ~2-3 day reporting lag).
  const endDate = isoDaysAgo(3);
  const startDate = isoDaysAgo(30);
  return {
    startDate,
    endDate,
    previousStartDate: isoDaysAgo(60),
    previousEndDate: isoDaysAgo(31),
    days: 28,
    label: undefined,
  };
}

export async function getSearchQueriesForPage(
  env: ScEnv,
  path: string,
  opts: { skipCache?: boolean; dateRange?: DateRangeInput; rowLimit?: number } = {}
): Promise<SearchQueryRow[]> {
  const siteUrl = resolveSiteUrl(env);
  const kv = env.RATE_LIMIT_KV;
  const range = resolveScRange(opts.dateRange);
  const body = {
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: ["query"],
    dimensionFilterGroups: [
      {
        filters: [
          {
            dimension: "page",
            operator: "equals",
            expression: pageUrlForFilter(siteUrl, path),
          },
        ],
      },
    ],
    rowLimit: Math.min(opts.rowLimit ?? 15, 500),
  };
  const cacheKey = `sc:queries:${await hashRequest({ siteUrl, body })}`;

  if (!opts.skipCache && kv) {
    const cached = await kv.get<SearchQueryRow[]>(cacheKey, "json");
    if (cached) return cached;
  }

  const token = await getAccessToken(env, opts.skipCache ?? false);
  const url = `${SC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      if (parsed?.error?.message) {
        detail = `${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      }
    } catch {
      /* keep raw text as detail */
    }
    await recordScFailure("gsc-api", env, res.status, detail, res.url);
    throw new ScApiError(res.status, detail);
  }

  const data = (await res.json()) as {
    rows?: Array<{
      keys?: string[];
      clicks?: number;
      impressions?: number;
      ctr?: number;
      position?: number;
    }>;
  };

  const rows: SearchQueryRow[] = (data.rows ?? []).map((r) => ({
    query: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));

  if (kv) {
    await kv.put(cacheKey, JSON.stringify(rows), { expirationTtl: REPORT_CACHE_TTL });
  }
  return rows;
}

export type SiteSearchQueryRow = SearchQueryRow & {
  topPages: Array<{ path: string; clicks: number; impressions: number; position: number }>;
};

export type SiteSearchQueriesResult = {
  dateRange: { startDate: string; endDate: string };
  queries: SiteSearchQueryRow[];
  totals: { clicks: number; impressions: number; queries: number };
};

type ScOrderBy = "impressions" | "clicks" | "position" | "ctr";

type GscApiRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

function pathFromGscPageKey(siteUrl: string, pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return u.pathname;
  } catch {
    // sc-domain properties sometimes return bare host-less URLs — strip siteUrl prefix if present
    if (siteUrl.startsWith("sc-domain:")) {
      const domain = siteUrl.slice("sc-domain:".length);
      const marker = `//${domain}`;
      const idx = pageUrl.indexOf(marker);
      if (idx >= 0) return pageUrl.slice(idx + marker.length) || "/";
    }
    return pageUrl;
  }
}

export async function getSiteSearchQueries(
  env: ScEnv,
  opts: {
    skipCache?: boolean;
    dateRange?: DateRangeInput;
    pathPrefix?: string;
    rowLimit?: number;
    minImpressions?: number;
    orderBy?: ScOrderBy;
  } = {}
): Promise<SiteSearchQueriesResult> {
  const siteUrl = resolveSiteUrl(env);
  const kv = env.RATE_LIMIT_KV;
  const range = resolveScRange(opts.dateRange, "last_28d");
  const rowLimit = Math.min(opts.rowLimit ?? 50, 500);
  const fetchLimit = Math.min(rowLimit * 10, 5000); // over-fetch so post-filtering still yields full rows
  const orderBy: ScOrderBy = opts.orderBy ?? "impressions";
  const minImpressions = Math.max(opts.minImpressions ?? 0, 0);

  const body: Record<string, unknown> = {
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: ["query", "page"],
    rowLimit: fetchLimit,
  };

  if (opts.pathPrefix) {
    const base = siteUrl.startsWith("sc-domain:")
      ? `https://${siteUrl.slice("sc-domain:".length)}`
      : siteUrl.endsWith("/")
        ? siteUrl.slice(0, -1)
        : siteUrl;
    body.dimensionFilterGroups = [
      {
        filters: [
          {
            dimension: "page",
            operator: "contains",
            expression: `${base}${opts.pathPrefix}`,
          },
        ],
      },
    ];
  }

  const cacheKey = `sc:site-queries:${await hashRequest({ siteUrl, body, rowLimit, orderBy, minImpressions })}`;

  if (!opts.skipCache && kv) {
    const cached = await kv.get<SiteSearchQueriesResult>(cacheKey, "json");
    if (cached) return cached;
  }

  const token = await getAccessToken(env, opts.skipCache ?? false);
  const url = `${SC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      if (parsed?.error?.message) {
        detail = `${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      }
    } catch {
      /* keep raw detail */
    }
    await recordScFailure("gsc-api", env, res.status, detail, res.url);
    throw new ScApiError(res.status, detail);
  }

  const data = (await res.json()) as { rows?: GscApiRow[] };

  // Aggregate by query, collecting per-page breakdown
  type Agg = {
    query: string;
    clicks: number;
    impressions: number;
    ctrNumerator: number; // clicks-weighted CTR
    positionNumerator: number; // impression-weighted position
    pages: Array<{ path: string; clicks: number; impressions: number; position: number }>;
  };
  const aggByQuery = new Map<string, Agg>();

  for (const row of data.rows ?? []) {
    const q = row.keys?.[0] ?? "";
    const pageKey = row.keys?.[1] ?? "";
    if (!q || !pageKey) continue;
    const clicks = row.clicks ?? 0;
    const impressions = row.impressions ?? 0;
    const position = row.position ?? 0;

    let agg = aggByQuery.get(q);
    if (!agg) {
      agg = {
        query: q,
        clicks: 0,
        impressions: 0,
        ctrNumerator: 0,
        positionNumerator: 0,
        pages: [],
      };
      aggByQuery.set(q, agg);
    }
    agg.clicks += clicks;
    agg.impressions += impressions;
    agg.ctrNumerator += clicks;
    agg.positionNumerator += position * impressions;
    agg.pages.push({
      path: pathFromGscPageKey(siteUrl, pageKey),
      clicks,
      impressions,
      position,
    });
  }

  const queries: SiteSearchQueryRow[] = Array.from(aggByQuery.values())
    .filter((a) => a.impressions >= minImpressions)
    .map((a) => ({
      query: a.query,
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: a.impressions > 0 ? a.ctrNumerator / a.impressions : 0,
      position: a.impressions > 0 ? a.positionNumerator / a.impressions : 0,
      topPages: a.pages.sort((p1, p2) => p2.impressions - p1.impressions).slice(0, 3),
    }));

  const sortFn = {
    impressions: (x: SiteSearchQueryRow, y: SiteSearchQueryRow) => y.impressions - x.impressions,
    clicks: (x: SiteSearchQueryRow, y: SiteSearchQueryRow) => y.clicks - x.clicks,
    ctr: (x: SiteSearchQueryRow, y: SiteSearchQueryRow) => y.ctr - x.ctr,
    position: (x: SiteSearchQueryRow, y: SiteSearchQueryRow) => x.position - y.position,
  }[orderBy];

  queries.sort(sortFn);
  const limited = queries.slice(0, rowLimit);

  const result: SiteSearchQueriesResult = {
    dateRange: { startDate: range.startDate, endDate: range.endDate },
    queries: limited,
    totals: {
      clicks: limited.reduce((s, q) => s + q.clicks, 0),
      impressions: limited.reduce((s, q) => s + q.impressions, 0),
      queries: limited.length,
    },
  };

  if (kv) {
    await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: REPORT_CACHE_TTL });
  }
  return result;
}

export type DailyClicksRow = {
  date: string; // YYYY-MM-DD
  clicks: number;
  impressions: number;
};

/**
 * §6.3 STALE-state freshness signal: most recent GSC date with non-zero
 * clicks or impressions. GSC has a ~3-day reporting lag baked in so the
 * "freshest" date is typically today-3. Returns YYYY-MM-DD, or null on
 * API error or empty 7-day window. Callers treat null as STALE since we
 * can't prove freshness.
 */
export async function getMaxGscDataDate(env: ScEnv): Promise<string | null> {
  try {
    const rows = await getDailyClicks(env, { days: 7 });
    let max: string | null = null;
    for (const r of rows) {
      if ((r.clicks > 0 || r.impressions > 0) && (max === null || r.date > max)) {
        max = r.date;
      }
    }
    return max;
  } catch (e) {
    if (e instanceof ScConfigError || e instanceof ScApiError) {
      return null;
    }
    throw e;
  }
}

/**
 * Per-day site-wide clicks/impressions aggregation. Uses dimensions: ['date']
 * with no query/page filter so each row is a daily total — the right shape for
 * a sparkline. Caches independently from the per-query report.
 */
export async function getDailyClicks(
  env: ScEnv,
  opts: { days?: number; skipCache?: boolean } = {}
): Promise<DailyClicksRow[]> {
  const siteUrl = resolveSiteUrl(env);
  const kv = env.RATE_LIMIT_KV;
  const days = Math.max(1, Math.min(opts.days ?? 30, 90));
  const endDate = isoDaysAgo(3); // GSC reporting lag
  const startDate = isoDaysAgo(3 + days);

  const body = {
    startDate,
    endDate,
    dimensions: ["date"],
    rowLimit: days + 5, // a touch more headroom; one row per day
  };

  const cacheKey = `sc:daily-clicks:${await hashRequest({ siteUrl, body })}`;
  if (!opts.skipCache && kv) {
    const cached = await kv.get<DailyClicksRow[]>(cacheKey, "json");
    if (cached) return cached;
  }

  const token = await getAccessToken(env, opts.skipCache ?? false);
  const url = `${SC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    await recordScFailure("gsc-api", env, res.status, text.slice(0, 500), res.url);
    throw new ScApiError(res.status, text.slice(0, 500));
  }

  const payload = (await res.json()) as { rows?: GscApiRow[] };
  const rows = (payload.rows ?? []).map((r) => ({
    date: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
  }));

  if (kv) {
    await kv.put(cacheKey, JSON.stringify(rows), { expirationTtl: REPORT_CACHE_TTL });
  }
  return rows;
}

export type SearchMetricRow = {
  date: string; // YYYY-MM-DD
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/**
 * A12 — date × query × page rows for a window, the persistence feed behind the
 * `gsc_search_metrics` D1 table (NOT the live widgets — those keep their own
 * cached aggregations). Always fetches fresh (no KV cache): the daily cron and
 * the first-run backfill both want ground truth, and a stale cache hit would
 * persist wrong history.
 *
 * GSC caps a single `searchAnalytics/query` response at 25 000 rows, so this
 * paginates via `startRow` until a short page (or `maxPages`) is hit. `maxPages`
 * is a Worker-CPU/quota backstop — at MMATF's volume one or two pages per day-
 * window is typical; the cap only matters for a wide backfill range.
 */
export async function getSearchMetricsByDateQueryPage(
  env: ScEnv,
  opts: { startDate: string; endDate: string; rowLimit?: number; maxPages?: number }
): Promise<SearchMetricRow[]> {
  const siteUrl = resolveSiteUrl(env);
  const rowLimit = Math.max(1, Math.min(opts.rowLimit ?? 25000, 25000));
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 20, 200));
  const token = await getAccessToken(env, false);
  const url = `${SC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const out: SearchMetricRow[] = [];
  for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
    const body = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: ["date", "query", "page"],
      rowLimit,
      startRow: pageIdx * rowLimit,
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) {
      const text = await res.text();
      await recordScFailure("gsc-api", env, res.status, text.slice(0, 500), res.url);
      throw new ScApiError(res.status, text.slice(0, 500));
    }
    const payload = (await res.json()) as { rows?: GscApiRow[] };
    const rows = payload.rows ?? [];
    for (const r of rows) {
      out.push({
        date: r.keys?.[0] ?? "",
        query: r.keys?.[1] ?? "",
        page: r.keys?.[2] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      });
    }
    if (rows.length < rowLimit) break; // last page
  }
  return out;
}

export type QueryPageRow = {
  path: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type QueryPagesResult = {
  query: string;
  dateRange: { startDate: string; endDate: string };
  pages: QueryPageRow[];
  totals: { clicks: number; impressions: number; pages: number };
};

/**
 * Reverse lookup: given a search query, return every page that ranked for it
 * with per-page impressions/clicks/position. Useful for cannibalization
 * detection (multiple pages competing for the same query).
 */
export async function getQueryPages(
  env: ScEnv,
  query: string,
  opts: {
    skipCache?: boolean;
    dateRange?: DateRangeInput;
    rowLimit?: number;
  } = {}
): Promise<QueryPagesResult> {
  if (!query.trim()) throw new ScApiError(400, "query must be a non-empty string");
  const siteUrl = resolveSiteUrl(env);
  const kv = env.RATE_LIMIT_KV;
  const range = resolveScRange(opts.dateRange, "last_28d");
  const rowLimit = Math.min(opts.rowLimit ?? 50, 500);

  const body = {
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: ["page"],
    dimensionFilterGroups: [
      {
        filters: [{ dimension: "query", operator: "equals", expression: query }],
      },
    ],
    rowLimit,
  };
  const cacheKey = `sc:query-pages:${await hashRequest({ siteUrl, body })}`;

  if (!opts.skipCache && kv) {
    const cached = await kv.get<QueryPagesResult>(cacheKey, "json");
    if (cached) return cached;
  }

  const token = await getAccessToken(env, opts.skipCache ?? false);
  const url = `${SC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      if (parsed?.error?.message) {
        detail = `${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      }
    } catch {
      /* keep raw detail */
    }
    await recordScFailure("gsc-api", env, res.status, detail, res.url);
    throw new ScApiError(res.status, detail);
  }

  const data = (await res.json()) as { rows?: GscApiRow[] };
  const pages: QueryPageRow[] = (data.rows ?? []).map((r) => ({
    path: pathFromGscPageKey(siteUrl, r.keys?.[0] ?? ""),
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));

  const result: QueryPagesResult = {
    query,
    dateRange: { startDate: range.startDate, endDate: range.endDate },
    pages,
    totals: {
      clicks: pages.reduce((s, p) => s + p.clicks, 0),
      impressions: pages.reduce((s, p) => s + p.impressions, 0),
      pages: pages.length,
    },
  };

  if (kv) {
    await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: REPORT_CACHE_TTL });
  }
  return result;
}

// ── Sitemaps + URL Inspection APIs ─────────────────────────────

export type SitemapContentRow = {
  type: string;
  submitted: number;
  indexed: number;
};

export type SitemapRow = {
  path: string;
  type?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  warnings: number;
  errors: number;
  contents: SitemapContentRow[];
};

export type SitemapStatus = {
  sitemaps: SitemapRow[];
  totals: { submitted: number; indexed: number };
  generatedAt: string;
};

export async function getSitemapStatus(
  env: ScEnv,
  opts: { skipCache?: boolean } = {}
): Promise<SitemapStatus> {
  const siteUrl = resolveSiteUrl(env);
  const kv = env.RATE_LIMIT_KV;
  const cacheKey = `sc:sitemaps:${await hashRequest({ siteUrl })}`;

  if (!opts.skipCache && kv) {
    const cached = await kv.get<SitemapStatus>(cacheKey, "json");
    if (cached) return cached;
  }

  const token = await getAccessToken(env, opts.skipCache ?? false);
  const url = `${SC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      if (parsed?.error?.message) {
        detail = `${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      }
    } catch {
      /* keep raw detail */
    }
    await recordScFailure("gsc-api", env, res.status, detail, res.url);
    throw new ScApiError(res.status, detail);
  }

  const data = (await res.json()) as {
    sitemap?: Array<{
      path?: string;
      type?: string;
      lastSubmitted?: string;
      lastDownloaded?: string;
      isPending?: boolean;
      isSitemapsIndex?: boolean;
      warnings?: string | number;
      errors?: string | number;
      contents?: Array<{ type?: string; submitted?: string | number; indexed?: string | number }>;
    }>;
  };

  const toInt = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const sitemaps: SitemapRow[] = (data.sitemap ?? []).map((s) => ({
    path: s.path ?? "",
    type: s.type,
    lastSubmitted: normalizeApiDate(s.lastSubmitted) ?? undefined,
    lastDownloaded: normalizeApiDate(s.lastDownloaded) ?? undefined,
    isPending: s.isPending,
    isSitemapsIndex: s.isSitemapsIndex,
    warnings: toInt(s.warnings),
    errors: toInt(s.errors),
    contents: (s.contents ?? []).map((c) => ({
      type: c.type ?? "web",
      submitted: toInt(c.submitted),
      indexed: toInt(c.indexed),
    })),
  }));

  let submittedTotal = 0;
  let indexedTotal = 0;
  for (const s of sitemaps) {
    for (const c of s.contents) {
      submittedTotal += c.submitted;
      indexedTotal += c.indexed;
    }
  }

  const sitemapStatusResult: SitemapStatus = {
    sitemaps,
    totals: { submitted: submittedTotal, indexed: indexedTotal },
    generatedAt: new Date().toISOString(),
  };

  if (kv) {
    await kv.put(cacheKey, JSON.stringify(sitemapStatusResult), { expirationTtl: 24 * 60 * 60 });
  }
  return sitemapStatusResult;
}

export type UrlInspectionResult = {
  path: string;
  inspectionLink?: string;
  index: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    pageFetchState?: string;
    lastCrawlTime?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    referringUrls?: string[];
    sitemaps?: string[];
  };
  mobileUsability?: {
    verdict?: string;
    issues?: Array<{ issueType?: string; severity?: string; message?: string }>;
  };
  richResults?: {
    verdict?: string;
    // A10 (2026-06-26) — the per-item `issues[]` carry the actionable detail
    // (`issueMessage: "Missing field 'location'"`, `severity: ERROR|WARNING`)
    // that the GSC_RICH_RESULT_FAIL health issue persists. Previously parsed
    // out and discarded, which is why K46 sat unseen for 2 months.
    detectedItems?: Array<{
      richResultType?: string;
      items?: Array<{
        name?: string;
        issues?: Array<{ issueMessage?: string; severity?: string }>;
      }>;
    }>;
  };
  generatedAt: string;
};

export async function inspectUrl(
  env: ScEnv,
  path: string,
  opts: { skipCache?: boolean } = {}
): Promise<UrlInspectionResult> {
  if (!path.startsWith("/")) throw new ScApiError(400, "path must start with '/'");
  const siteUrl = resolveSiteUrl(env);
  const kv = env.RATE_LIMIT_KV;
  const inspectionUrl = pageUrlForFilter(siteUrl, path);
  const cacheKey = `sc:inspect:${await hashRequest({ siteUrl, inspectionUrl })}`;

  if (!opts.skipCache && kv) {
    const cached = await kv.get<UrlInspectionResult>(cacheKey, "json");
    if (cached) return cached;
  }

  const token = await getAccessToken(env, opts.skipCache ?? false);
  // URL Inspection lives at the v1 base, not webmasters/v3.
  const url = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      if (parsed?.error?.message) {
        detail = `${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      }
    } catch {
      /* keep raw detail */
    }
    await recordScFailure("gsc-api", env, res.status, detail, res.url);
    throw new ScApiError(res.status, detail);
  }

  const data = (await res.json()) as {
    inspectionResult?: {
      inspectionResultLink?: string;
      indexStatusResult?: {
        verdict?: string;
        coverageState?: string;
        robotsTxtState?: string;
        indexingState?: string;
        pageFetchState?: string;
        lastCrawlTime?: string;
        googleCanonical?: string;
        userCanonical?: string;
        crawledAs?: string;
        referringUrls?: string[];
        sitemap?: string[];
      };
      mobileUsabilityResult?: {
        verdict?: string;
        issues?: Array<{ issueType?: string; severity?: string; message?: string }>;
      };
      richResultsResult?: {
        verdict?: string;
        detectedItems?: Array<{
          richResultType?: string;
          items?: Array<{
            name?: string;
            issues?: Array<{ issueMessage?: string; severity?: string }>;
          }>;
        }>;
      };
    };
  };

  const ir = data.inspectionResult ?? {};
  const idx = ir.indexStatusResult ?? {};
  const inspectionOutcome: UrlInspectionResult = {
    path,
    inspectionLink: ir.inspectionResultLink,
    index: {
      verdict: idx.verdict,
      coverageState: idx.coverageState,
      robotsTxtState: idx.robotsTxtState,
      indexingState: idx.indexingState,
      pageFetchState: idx.pageFetchState,
      lastCrawlTime: normalizeApiDate(idx.lastCrawlTime) ?? undefined,
      googleCanonical: idx.googleCanonical,
      userCanonical: idx.userCanonical,
      crawledAs: idx.crawledAs,
      referringUrls: idx.referringUrls,
      sitemaps: idx.sitemap,
    },
    mobileUsability: ir.mobileUsabilityResult
      ? { verdict: ir.mobileUsabilityResult.verdict, issues: ir.mobileUsabilityResult.issues }
      : undefined,
    richResults: ir.richResultsResult
      ? { verdict: ir.richResultsResult.verdict, detectedItems: ir.richResultsResult.detectedItems }
      : undefined,
    generatedAt: new Date().toISOString(),
  };

  if (kv) {
    // URL Inspection is quota-limited — cache 6h.
    await kv.put(cacheKey, JSON.stringify(inspectionOutcome), { expirationTtl: 6 * 60 * 60 });
  }
  return inspectionOutcome;
}

export type SubmitSitemapResult = {
  siteUrl: string;
  feedpath: string;
  submittedAt: string;
};

/**
 * Validates that a sitemap URL belongs to the configured GSC property.
 * GSC's API will 403 if the host doesn't match, so checking client-side
 * surfaces a clearer, faster error and saves a round-trip plus token fetch.
 *
 * Allows exact host match for both URL-prefix and sc-domain: properties,
 * plus subdomain match for sc-domain: properties (which cover the whole
 * domain by definition).
 */
export function validateSitemapBelongsToProperty(siteUrl: string, sitemapUrl: string): void {
  let host: string;
  try {
    host = new URL(sitemapUrl).hostname.toLowerCase();
  } catch {
    throw new ScConfigError(`Invalid sitemap URL: ${sitemapUrl}`);
  }

  if (siteUrl.startsWith("sc-domain:")) {
    const expectedHost = siteUrl.slice("sc-domain:".length).toLowerCase();
    if (host !== expectedHost && !host.endsWith(`.${expectedHost}`)) {
      throw new ScConfigError(
        `Sitemap URL host '${host}' does not belong to property 'sc-domain:${expectedHost}'.`
      );
    }
    return;
  }

  let expectedHost: string;
  try {
    expectedHost = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    throw new ScConfigError(`Invalid SC_SITE_URL property: ${siteUrl}`);
  }
  if (host !== expectedHost) {
    throw new ScConfigError(
      `Sitemap URL host '${host}' does not belong to property '${expectedHost}'.`
    );
  }
}

/**
 * Submit (or resubmit) a sitemap URL to Google Search Console. Triggers a
 * recrawl signal — Google fetches the sitemap soon after, typically within
 * hours rather than the multi-day default recrawl cadence.
 *
 * Idempotent on the GSC side: if the sitemap is already known, this is a
 * recrawl ping; if it's new, it gets registered. Either way returns 200.
 *
 * Requires the `webmasters` (full) OAuth scope — `.readonly` will 403.
 * Service account must have Owner-level standing on the GSC property.
 */
export async function submitSitemap(env: ScEnv, sitemapUrl: string): Promise<SubmitSitemapResult> {
  const siteUrl = resolveSiteUrl(env);
  validateSitemapBelongsToProperty(siteUrl, sitemapUrl);

  const token = await getWriteAccessToken(env, false);
  const url = `${SC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail: string;
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      if (parsed?.error?.message) {
        detail = `HTTP ${res.status} ${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      } else {
        detail = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      }
    } catch {
      detail = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    }
    await recordScFailure("gsc-api", env, res.status, detail, res.url);
    throw new ScApiError(res.status, detail);
  }

  return {
    siteUrl,
    feedpath: sitemapUrl,
    submittedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Google Indexing API
// ---------------------------------------------------------------------------

export type RequestIndexingType = "URL_UPDATED" | "URL_DELETED";

export type RequestIndexingResult = {
  url: string;
  type: RequestIndexingType;
  notifyTime: string | null;
  submittedAt: string;
};

/**
 * Validates that a target URL belongs to the configured GSC property. Same
 * shape rules as `validateSitemapBelongsToProperty`, but reused here because
 * the Indexing API authorizes per-property: the service account can only
 * notify URLs on a property it owns. Surfacing the wrong-host case client-
 * side beats a 403 from upstream.
 */
function validateUrlBelongsToProperty(siteUrl: string, targetUrl: string): void {
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    throw new ScConfigError(`Invalid URL: ${targetUrl}`);
  }

  if (siteUrl.startsWith("sc-domain:")) {
    const expectedHost = siteUrl.slice("sc-domain:".length).toLowerCase();
    if (host !== expectedHost && !host.endsWith(`.${expectedHost}`)) {
      throw new ScConfigError(
        `URL host '${host}' does not belong to property 'sc-domain:${expectedHost}'.`
      );
    }
    return;
  }

  let expectedHost: string;
  try {
    expectedHost = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    throw new ScConfigError(`Invalid SC_SITE_URL property: ${siteUrl}`);
  }
  if (host !== expectedHost) {
    throw new ScConfigError(`URL host '${host}' does not belong to property '${expectedHost}'.`);
  }
}

/**
 * Notify Google's Indexing API that a URL has been updated (or deleted).
 * The API officially supports only `JobPosting` and `BroadcastEvent` schemas,
 * but empirically accepts other URL types and treats the notification as a
 * recrawl signal. Use sparingly on high-value pages (stuck blog posts,
 * newly-renamed slugs) rather than bulk-submitting — Google may rate-limit
 * or no-op such requests at any time.
 *
 * Requires the `https://www.googleapis.com/auth/indexing` OAuth scope (the
 * `webmasters` scope used by sitemap submit is orthogonal and won't work).
 * Service account must have Owner-level standing on the GSC property — the
 * same standing the URL-Inspection sweep already relies on.
 */
export async function requestIndexing(
  env: ScEnv,
  targetUrl: string,
  type: RequestIndexingType = "URL_UPDATED"
): Promise<RequestIndexingResult> {
  const siteUrl = resolveSiteUrl(env);
  validateUrlBelongsToProperty(siteUrl, targetUrl);

  const token = await getIndexingAccessToken(env, false);
  const url = `${INDEXING_API_BASE}/urlNotifications:publish`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: targetUrl, type }),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail: string;
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      if (parsed?.error?.message) {
        detail = `HTTP ${res.status} ${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      } else {
        detail = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      }
    } catch {
      detail = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    }
    await recordScFailure("gsc-api", env, res.status, detail, res.url);
    throw new ScApiError(res.status, detail);
  }

  // Response shape per Google docs:
  // { urlNotificationMetadata: { url, latestUpdate: { type, notifyTime } } }
  type IndexingResponse = {
    urlNotificationMetadata?: {
      url?: string;
      latestUpdate?: { type?: string; notifyTime?: string };
    };
  };
  let parsed: IndexingResponse = {};
  try {
    parsed = (await res.json()) as IndexingResponse;
  } catch {
    // Treat unparseable success body as no-op metadata; the 2xx status is
    // the real signal that Google accepted the notification.
  }

  return {
    url: parsed.urlNotificationMetadata?.url ?? targetUrl,
    type,
    notifyTime: parsed.urlNotificationMetadata?.latestUpdate?.notifyTime ?? null,
    submittedAt: new Date().toISOString(),
  };
}
