import { SignJWT, importPKCS8 } from "jose";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GA4_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

const TOKEN_CACHE_KEY = "ga4:access_token";
const TOKEN_CACHE_TTL = 3000;
const REPORT_CACHE_TTL = 600;
const REQUEST_TIMEOUT_MS = 10_000;

export type Ga4Env = {
  GA4_PROPERTY_ID?: string;
  GA4_SA_CLIENT_EMAIL?: string;
  GA4_SA_PRIVATE_KEY?: string;
  RATE_LIMIT_KV?: KVNamespace;
};

export class Ga4ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ga4ConfigError";
  }
}

export class Ga4ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`GA4 API error ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
    this.name = "Ga4ApiError";
  }
}

type ResolvedConfig = {
  propertyId: string;
  clientEmail: string;
  privateKey: string;
};

function resolveConfig(env: Ga4Env): ResolvedConfig {
  const propertyId = env.GA4_PROPERTY_ID?.trim();
  const clientEmail = env.GA4_SA_CLIENT_EMAIL?.trim();
  const rawKey = env.GA4_SA_PRIVATE_KEY;

  const missing: string[] = [];
  if (!propertyId) missing.push("GA4_PROPERTY_ID");
  if (!clientEmail) missing.push("GA4_SA_CLIENT_EMAIL");
  if (!rawKey) missing.push("GA4_SA_PRIVATE_KEY");
  if (missing.length) {
    throw new Ga4ConfigError(
      `Missing GA4 environment variables: ${missing.join(", ")}. See .env.example for setup.`
    );
  }

  const privateKey = rawKey!.replace(/\\n/g, "\n").trim();
  return { propertyId: propertyId!, clientEmail: clientEmail!, privateKey };
}

export async function getGa4AccessToken(
  env: Ga4Env,
  opts: { skipCache?: boolean } = {}
): Promise<string> {
  const kv = env.RATE_LIMIT_KV;
  if (!opts.skipCache && kv) {
    const cached = await kv.get(TOKEN_CACHE_KEY);
    if (cached) return cached;
  }

  const { clientEmail, privateKey } = resolveConfig(env);
  const key = await importPKCS8(privateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientEmail)
    .setAudience(OAUTH_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Ga4ApiError(res.status, `OAuth token exchange failed: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Ga4ApiError(500, "OAuth response missing access_token");
  }

  if (kv) {
    const ttl = Math.min(json.expires_in ?? 3600, TOKEN_CACHE_TTL);
    await kv.put(TOKEN_CACHE_KEY, json.access_token, { expirationTtl: ttl });
  }
  return json.access_token;
}

type OrderBy =
  | { metric: { metricName: string }; desc?: boolean }
  | { dimension: { dimensionName: string }; desc?: boolean };

export type RunReportRequest = {
  dateRanges: Array<{ startDate: string; endDate: string; name?: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  orderBys?: OrderBy[];
  limit?: number;
};

export type RunReportResponse = {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  rowCount?: number;
};

async function hashRequest(obj: unknown): Promise<string> {
  const buf = new TextEncoder().encode(JSON.stringify(obj));
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function runReport(
  env: Ga4Env,
  request: RunReportRequest,
  opts: { skipCache?: boolean; accessToken?: string } = {}
): Promise<RunReportResponse> {
  const { propertyId } = resolveConfig(env);
  const kv = env.RATE_LIMIT_KV;
  const cacheKey = `ga4:report:${await hashRequest({ propertyId, request })}`;

  if (!opts.skipCache && kv) {
    const cached = await kv.get<RunReportResponse>(cacheKey, "json");
    if (cached) return cached;
  }

  const token = opts.accessToken ?? (await getGa4AccessToken(env, { skipCache: opts.skipCache }));
  const url = `${GA4_API_BASE}/properties/${propertyId}:runReport`;

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
      body: JSON.stringify(request),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as {
        error?: { status?: string; message?: string };
      };
      if (parsed?.error?.message) {
        detail = `${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      }
    } catch {
      /* keep raw text as detail */
    }
    throw new Ga4ApiError(res.status, detail);
  }

  const data = (await res.json()) as RunReportResponse;
  if (kv) {
    await kv.put(cacheKey, JSON.stringify(data), {
      expirationTtl: REPORT_CACHE_TTL,
    });
  }
  return data;
}

export type ActiveUsersDay = { date: string; users: number };
export type TopPageRow = {
  path: string;
  title: string;
  views: number;
  activeUsers: number;
};
export type TopEventRow = { eventName: string; count: number };
export type TrafficSourceRow = {
  source: string;
  medium: string;
  sessions: number;
  activeUsers: number;
};

export type DashboardMetrics = {
  activeUsers: {
    last7d: number;
    last28d: number;
    byDay: ActiveUsersDay[];
  };
  topPages: TopPageRow[];
  topEvents: TopEventRow[];
  trafficSources: TrafficSourceRow[];
  propertyId: string;
  generatedAt: string;
};

function toNumber(value?: string): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function getDashboardMetrics(
  env: Ga4Env,
  opts: { skipCache?: boolean } = {}
): Promise<DashboardMetrics> {
  const { propertyId } = resolveConfig(env);
  const accessToken = await getGa4AccessToken(env, {
    skipCache: opts.skipCache,
  });
  const passthrough = { skipCache: opts.skipCache, accessToken };

  const last28 = [{ startDate: "28daysAgo", endDate: "today" }];
  const last7 = [{ startDate: "7daysAgo", endDate: "today" }];

  const [
    activeByDayRes,
    activeUsers7dRes,
    activeUsers28dRes,
    topPagesRes,
    topEventsRes,
    trafficRes,
  ] = await Promise.all([
    runReport(
      env,
      {
        dateRanges: last28,
        dimensions: [{ name: "date" }],
        metrics: [{ name: "activeUsers" }],
        limit: 31,
      },
      passthrough
    ),
    runReport(env, { dateRanges: last7, metrics: [{ name: "activeUsers" }] }, passthrough),
    runReport(env, { dateRanges: last28, metrics: [{ name: "activeUsers" }] }, passthrough),
    runReport(
      env,
      {
        dateRanges: last28,
        dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 20,
      },
      passthrough
    ),
    runReport(
      env,
      {
        dateRanges: last28,
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
        limit: 15,
      },
      passthrough
    ),
    runReport(
      env,
      {
        dateRanges: last28,
        dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }, { name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 10,
      },
      passthrough
    ),
  ]);

  const byDay: ActiveUsersDay[] = (activeByDayRes.rows ?? [])
    .map((row) => ({
      date: row.dimensionValues?.[0]?.value ?? "",
      users: toNumber(row.metricValues?.[0]?.value),
    }))
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const last7d = toNumber(activeUsers7dRes.rows?.[0]?.metricValues?.[0]?.value);
  const last28d = toNumber(activeUsers28dRes.rows?.[0]?.metricValues?.[0]?.value);

  const topPages: TopPageRow[] = (topPagesRes.rows ?? []).map((row) => ({
    path: row.dimensionValues?.[0]?.value ?? "",
    title: row.dimensionValues?.[1]?.value ?? "",
    views: toNumber(row.metricValues?.[0]?.value),
    activeUsers: toNumber(row.metricValues?.[1]?.value),
  }));

  const topEvents: TopEventRow[] = (topEventsRes.rows ?? []).map((row) => ({
    eventName: row.dimensionValues?.[0]?.value ?? "",
    count: toNumber(row.metricValues?.[0]?.value),
  }));

  const trafficSources: TrafficSourceRow[] = (trafficRes.rows ?? []).map((row) => ({
    source: row.dimensionValues?.[0]?.value ?? "",
    medium: row.dimensionValues?.[1]?.value ?? "",
    sessions: toNumber(row.metricValues?.[0]?.value),
    activeUsers: toNumber(row.metricValues?.[1]?.value),
  }));

  return {
    activeUsers: { last7d, last28d, byDay },
    topPages,
    topEvents,
    trafficSources,
    propertyId,
    generatedAt: new Date().toISOString(),
  };
}
