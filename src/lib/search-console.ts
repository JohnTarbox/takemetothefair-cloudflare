import {
  getGoogleAccessToken,
  GoogleAuthConfigError,
  GoogleAuthError,
  type GoogleAuthEnv,
} from "./google-auth";

const SC_API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const SC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const SC_TOKEN_CACHE_KEY = "sc:access_token";
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
    if (error instanceof GoogleAuthError) throw new ScApiError(error.status, error.detail);
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

export async function getSearchQueriesForPage(
  env: ScEnv,
  path: string,
  opts: { skipCache?: boolean } = {}
): Promise<SearchQueryRow[]> {
  const siteUrl = resolveSiteUrl(env);
  const kv = env.RATE_LIMIT_KV;
  const body = {
    startDate: isoDaysAgo(30),
    endDate: isoDaysAgo(3),
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
    rowLimit: 15,
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
