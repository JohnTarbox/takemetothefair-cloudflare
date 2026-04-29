import {
  getGoogleAccessToken,
  GoogleAuthConfigError,
  GoogleAuthError,
  type GoogleAuthEnv,
} from "./google-auth";
import { resolveDateRange, type DateRangeInput, type ResolvedDateRange } from "./analytics-params";

const GA4_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GA4_TOKEN_CACHE_KEY = "ga4:access_token";
const REPORT_CACHE_TTL = 600;
const REQUEST_TIMEOUT_MS = 10_000;

export type Ga4Env = GoogleAuthEnv & {
  GA4_PROPERTY_ID?: string;
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

function resolveConfig(env: Ga4Env): { propertyId: string } {
  const propertyId = env.GA4_PROPERTY_ID?.trim();
  if (!propertyId) {
    throw new Ga4ConfigError(
      "Missing GA4 environment variable: GA4_PROPERTY_ID. See .env.example for setup."
    );
  }
  return { propertyId };
}

export async function getGa4AccessToken(
  env: Ga4Env,
  opts: { skipCache?: boolean } = {}
): Promise<string> {
  try {
    return await getGoogleAccessToken(env, GA4_SCOPE, {
      skipCache: opts.skipCache,
      cacheKey: GA4_TOKEN_CACHE_KEY,
    });
  } catch (error) {
    if (error instanceof GoogleAuthConfigError) {
      throw new Ga4ConfigError(error.message);
    }
    if (error instanceof GoogleAuthError) {
      throw new Ga4ApiError(error.status, error.detail);
    }
    throw error;
  }
}

type OrderBy =
  | { metric: { metricName: string }; desc?: boolean }
  | { dimension: { dimensionName: string }; desc?: boolean };

type StringFilter = {
  matchType?: "EXACT" | "BEGINS_WITH" | "ENDS_WITH" | "CONTAINS" | "FULL_REGEXP";
  value: string;
  caseSensitive?: boolean;
};

type DimensionFilterExpression = {
  filter?: { fieldName: string; stringFilter?: StringFilter };
  andGroup?: { expressions: DimensionFilterExpression[] };
  orGroup?: { expressions: DimensionFilterExpression[] };
  notExpression?: DimensionFilterExpression;
};

export type RunReportRequest = {
  dateRanges: Array<{ startDate: string; endDate: string; name?: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  orderBys?: OrderBy[];
  limit?: number;
  dimensionFilter?: DimensionFilterExpression;
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
    let detail: string;
    try {
      const parsed = JSON.parse(text) as {
        error?: { status?: string; message?: string };
      };
      if (parsed?.error?.message) {
        detail = `HTTP ${res.status} ${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
      } else {
        detail = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      }
    } catch {
      // Non-JSON body (e.g. Google's HTML "Sorry / unusual traffic"
      // interstitial). Report the status and content-type so the failure mode
      // is identifiable without grepping the raw HTML.
      const looksHtml = /^\s*<(html|!doctype)/i.test(text);
      if (looksHtml) {
        detail = `HTTP ${res.status} from analyticsdata.googleapis.com (HTML interstitial — likely transient Google rate-limit or anti-abuse page; try Refresh data or wait a few minutes)`;
      } else {
        detail = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      }
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

export type DateRangeDescriptor = {
  startDate: string;
  endDate: string;
  days: number;
  label?: string;
};

export type DashboardMetrics = {
  activeUsers: {
    last7d: number;
    last28d: number;
    byDay: ActiveUsersDay[];
    current?: number;
    previous?: number;
    change?: number;
  };
  topPages: TopPageRow[];
  topEvents: TopEventRow[];
  trafficSources: TrafficSourceRow[];
  dateRange?: DateRangeDescriptor;
  previousDateRange?: DateRangeDescriptor;
  propertyId: string;
  generatedAt: string;
};

export type TopPagesOpts = {
  pathPrefix?: string;
  rowLimit?: number;
  orderBy?: "views" | "users" | "sessions" | "engagementRate";
  minViews?: number;
};

function pagePathPrefixFilter(prefix: string): DimensionFilterExpression {
  return {
    filter: {
      fieldName: "pagePath",
      stringFilter: { matchType: "BEGINS_WITH", value: prefix, caseSensitive: false },
    },
  };
}

function orderByMetricForTopPages(orderBy?: TopPagesOpts["orderBy"]): string {
  switch (orderBy) {
    case "users":
      return "activeUsers";
    case "sessions":
      return "sessions";
    case "engagementRate":
      return "engagementRate";
    case "views":
    default:
      return "screenPageViews";
  }
}

function toNumber(value?: string): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function getDashboardMetrics(
  env: Ga4Env,
  opts: {
    skipCache?: boolean;
    dateRange?: DateRangeInput;
    comparePreviousPeriod?: boolean;
    topPages?: TopPagesOpts;
  } = {}
): Promise<DashboardMetrics> {
  const { propertyId } = resolveConfig(env);
  const accessToken = await getGa4AccessToken(env, {
    skipCache: opts.skipCache,
  });
  const passthrough = { skipCache: opts.skipCache, accessToken };

  // Default: preserve legacy behavior when no dateRange provided (last 28d).
  const usesCustomRange = !!(opts.dateRange?.startDate || opts.dateRange?.preset);
  const resolvedRange: ResolvedDateRange | null = usesCustomRange
    ? resolveDateRange(opts.dateRange, { defaultPreset: "last_28d" })
    : null;

  const rangeForQuery = resolvedRange
    ? [{ startDate: resolvedRange.startDate, endDate: resolvedRange.endDate }]
    : [{ startDate: "28daysAgo", endDate: "today" }];
  const prevRangeForQuery = resolvedRange
    ? [{ startDate: resolvedRange.previousStartDate, endDate: resolvedRange.previousEndDate }]
    : [{ startDate: "56daysAgo", endDate: "29daysAgo" }];
  const last28 = [{ startDate: "28daysAgo", endDate: "today" }];
  const last7 = [{ startDate: "7daysAgo", endDate: "today" }];
  const byDayLimit = resolvedRange ? Math.min(resolvedRange.days + 1, 400) : 31;

  // Top-pages report controls
  const topPagesOpts = opts.topPages ?? {};
  const topPagesRowLimit = Math.min(topPagesOpts.rowLimit ?? 20, 200);
  const topPagesOrderMetric = orderByMetricForTopPages(topPagesOpts.orderBy);
  const topPagesFilter = topPagesOpts.pathPrefix
    ? pagePathPrefixFilter(topPagesOpts.pathPrefix)
    : undefined;

  const wantsCompare = !!opts.comparePreviousPeriod;

  const [
    activeByDayRes,
    activeUsers7dRes,
    activeUsers28dRes,
    activeUsersCurrentRes,
    activeUsersPreviousRes,
    topPagesRes,
    topEventsRes,
    trafficRes,
  ] = await Promise.all([
    runReport(
      env,
      {
        dateRanges: rangeForQuery,
        dimensions: [{ name: "date" }],
        metrics: [{ name: "activeUsers" }],
        limit: byDayLimit,
      },
      passthrough
    ),
    runReport(env, { dateRanges: last7, metrics: [{ name: "activeUsers" }] }, passthrough),
    runReport(env, { dateRanges: last28, metrics: [{ name: "activeUsers" }] }, passthrough),
    resolvedRange
      ? runReport(
          env,
          { dateRanges: rangeForQuery, metrics: [{ name: "activeUsers" }] },
          passthrough
        )
      : Promise.resolve({ rows: [] }),
    wantsCompare
      ? runReport(
          env,
          { dateRanges: prevRangeForQuery, metrics: [{ name: "activeUsers" }] },
          passthrough
        )
      : Promise.resolve({ rows: [] }),
    runReport(
      env,
      {
        dateRanges: rangeForQuery,
        dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
        metrics: [
          { name: "screenPageViews" },
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "engagementRate" },
        ],
        orderBys: [{ metric: { metricName: topPagesOrderMetric }, desc: true }],
        limit: topPagesRowLimit,
        dimensionFilter: topPagesFilter,
      },
      passthrough
    ),
    runReport(
      env,
      {
        dateRanges: rangeForQuery,
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
        dateRanges: rangeForQuery,
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

  const currentActiveUsers = resolvedRange
    ? toNumber(activeUsersCurrentRes.rows?.[0]?.metricValues?.[0]?.value)
    : undefined;
  const previousActiveUsers = wantsCompare
    ? toNumber(activeUsersPreviousRes.rows?.[0]?.metricValues?.[0]?.value)
    : undefined;
  const change =
    wantsCompare && previousActiveUsers !== undefined && previousActiveUsers > 0
      ? ((currentActiveUsers ?? 0) - previousActiveUsers) / previousActiveUsers
      : undefined;

  const minViewsFilter = topPagesOpts.minViews ?? 0;
  const topPages: TopPageRow[] = (topPagesRes.rows ?? [])
    .map((row) => ({
      path: row.dimensionValues?.[0]?.value ?? "",
      title: row.dimensionValues?.[1]?.value ?? "",
      views: toNumber(row.metricValues?.[0]?.value),
      activeUsers: toNumber(row.metricValues?.[1]?.value),
    }))
    .filter((row) => row.views >= minViewsFilter);

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

  const dateRangeDescriptor: DateRangeDescriptor | undefined = resolvedRange
    ? {
        startDate: resolvedRange.startDate,
        endDate: resolvedRange.endDate,
        days: resolvedRange.days,
        label: resolvedRange.label,
      }
    : undefined;
  const previousDateRangeDescriptor: DateRangeDescriptor | undefined =
    wantsCompare && resolvedRange
      ? {
          startDate: resolvedRange.previousStartDate,
          endDate: resolvedRange.previousEndDate,
          days: resolvedRange.days,
        }
      : wantsCompare
        ? { startDate: "56daysAgo", endDate: "29daysAgo", days: 28 }
        : undefined;

  return {
    activeUsers: {
      last7d,
      last28d,
      byDay,
      ...(currentActiveUsers !== undefined ? { current: currentActiveUsers } : {}),
      ...(previousActiveUsers !== undefined ? { previous: previousActiveUsers } : {}),
      ...(change !== undefined ? { change } : {}),
    },
    topPages,
    topEvents,
    trafficSources,
    ...(dateRangeDescriptor ? { dateRange: dateRangeDescriptor } : {}),
    ...(previousDateRangeDescriptor ? { previousDateRange: previousDateRangeDescriptor } : {}),
    propertyId,
    generatedAt: new Date().toISOString(),
  };
}

export type PageViewsDay = { date: string; views: number; users: number };
export type DeviceRow = { category: string; sessions: number; activeUsers: number };
export type PageEventRow = { eventName: string; count: number };
export type GeographyCountryRow = { country: string; sessions: number; activeUsers: number };
export type GeographyRegionRow = {
  region: string;
  country: string;
  sessions: number;
  activeUsers: number;
};
export type GeographyBreakdown = {
  byCountry: GeographyCountryRow[];
  byRegion: GeographyRegionRow[];
  newEnglandShare: number;
};

const NEW_ENGLAND_REGIONS = new Set([
  "Maine",
  "New Hampshire",
  "Vermont",
  "Massachusetts",
  "Connecticut",
  "Rhode Island",
]);

export type PageTotals = {
  views: number;
  activeUsers: number;
  sessions: number;
  engagementRate: number;
};

export type PageMetrics = {
  path: string;
  title: string;
  totals: PageTotals;
  previousTotals: PageTotals;
  byDay: PageViewsDay[];
  trafficSources: TrafficSourceRow[];
  devices: DeviceRow[];
  events: PageEventRow[];
  geography: GeographyBreakdown;
  dateRange?: DateRangeDescriptor;
  previousDateRange?: DateRangeDescriptor;
  propertyId: string;
  generatedAt: string;
};

function pagePathFilter(path: string): DimensionFilterExpression {
  return {
    filter: {
      fieldName: "pagePath",
      stringFilter: { matchType: "EXACT", value: path, caseSensitive: false },
    },
  };
}

export async function getPageMetrics(
  env: Ga4Env,
  path: string,
  opts: { skipCache?: boolean; dateRange?: DateRangeInput } = {}
): Promise<PageMetrics> {
  const { propertyId } = resolveConfig(env);
  const accessToken = await getGa4AccessToken(env, {
    skipCache: opts.skipCache,
  });
  const passthrough = { skipCache: opts.skipCache, accessToken };
  const dimensionFilter = pagePathFilter(path);

  const usesCustomRange = !!(opts.dateRange?.startDate || opts.dateRange?.preset);
  const resolvedRange: ResolvedDateRange | null = usesCustomRange
    ? resolveDateRange(opts.dateRange, { defaultPreset: "last_28d" })
    : null;
  const last28 = resolvedRange
    ? [{ startDate: resolvedRange.startDate, endDate: resolvedRange.endDate }]
    : [{ startDate: "28daysAgo", endDate: "today" }];
  const prev28 = resolvedRange
    ? [{ startDate: resolvedRange.previousStartDate, endDate: resolvedRange.previousEndDate }]
    : [{ startDate: "56daysAgo", endDate: "29daysAgo" }];
  const byDayLimit = resolvedRange ? Math.min(resolvedRange.days + 1, 400) : 31;

  const totalsMetrics = [
    { name: "screenPageViews" },
    { name: "activeUsers" },
    { name: "sessions" },
    { name: "engagementRate" },
  ];

  const [totalsRes, prevTotalsRes, titleRes, byDayRes, trafficRes, deviceRes, eventsRes, geoRes] =
    await Promise.all([
      runReport(env, { dateRanges: last28, metrics: totalsMetrics, dimensionFilter }, passthrough),
      runReport(env, { dateRanges: prev28, metrics: totalsMetrics, dimensionFilter }, passthrough),
      runReport(
        env,
        {
          dateRanges: last28,
          dimensions: [{ name: "pageTitle" }],
          metrics: [{ name: "screenPageViews" }],
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit: 1,
          dimensionFilter,
        },
        passthrough
      ),
      runReport(
        env,
        {
          dateRanges: last28,
          dimensions: [{ name: "date" }],
          metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
          limit: byDayLimit,
          dimensionFilter,
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
          dimensionFilter,
        },
        passthrough
      ),
      runReport(
        env,
        {
          dateRanges: last28,
          dimensions: [{ name: "deviceCategory" }],
          metrics: [{ name: "sessions" }, { name: "activeUsers" }],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          dimensionFilter,
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
          dimensionFilter,
        },
        passthrough
      ),
      runReport(
        env,
        {
          dateRanges: last28,
          dimensions: [{ name: "country" }, { name: "region" }],
          metrics: [{ name: "sessions" }, { name: "activeUsers" }],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 50,
          dimensionFilter,
        },
        passthrough
      ),
    ]);

  const parseTotals = (rows?: RunReportResponse["rows"]): PageTotals => {
    const mv = rows?.[0]?.metricValues;
    return {
      views: toNumber(mv?.[0]?.value),
      activeUsers: toNumber(mv?.[1]?.value),
      sessions: toNumber(mv?.[2]?.value),
      engagementRate: toNumber(mv?.[3]?.value),
    };
  };

  const totals = parseTotals(totalsRes.rows);
  const previousTotals = parseTotals(prevTotalsRes.rows);
  const title = titleRes.rows?.[0]?.dimensionValues?.[0]?.value ?? "";

  const byDay: PageViewsDay[] = (byDayRes.rows ?? [])
    .map((row) => ({
      date: row.dimensionValues?.[0]?.value ?? "",
      views: toNumber(row.metricValues?.[0]?.value),
      users: toNumber(row.metricValues?.[1]?.value),
    }))
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const trafficSources: TrafficSourceRow[] = (trafficRes.rows ?? []).map((row) => ({
    source: row.dimensionValues?.[0]?.value ?? "",
    medium: row.dimensionValues?.[1]?.value ?? "",
    sessions: toNumber(row.metricValues?.[0]?.value),
    activeUsers: toNumber(row.metricValues?.[1]?.value),
  }));

  const devices: DeviceRow[] = (deviceRes.rows ?? []).map((row) => ({
    category: row.dimensionValues?.[0]?.value ?? "",
    sessions: toNumber(row.metricValues?.[0]?.value),
    activeUsers: toNumber(row.metricValues?.[1]?.value),
  }));

  const events: PageEventRow[] = (eventsRes.rows ?? []).map((row) => ({
    eventName: row.dimensionValues?.[0]?.value ?? "",
    count: toNumber(row.metricValues?.[0]?.value),
  }));

  // Aggregate geography: rows come pre-split by (country, region). Fold up to
  // country totals and compute the New England share for MMATF's core region.
  const byRegion: GeographyRegionRow[] = (geoRes.rows ?? []).map((row) => ({
    country: row.dimensionValues?.[0]?.value ?? "",
    region: row.dimensionValues?.[1]?.value ?? "",
    sessions: toNumber(row.metricValues?.[0]?.value),
    activeUsers: toNumber(row.metricValues?.[1]?.value),
  }));

  const countryTotals = new Map<string, { sessions: number; activeUsers: number }>();
  let totalSessions = 0;
  let newEnglandSessions = 0;
  for (const r of byRegion) {
    totalSessions += r.sessions;
    if (r.country === "United States" && NEW_ENGLAND_REGIONS.has(r.region)) {
      newEnglandSessions += r.sessions;
    }
    const prev = countryTotals.get(r.country) ?? { sessions: 0, activeUsers: 0 };
    countryTotals.set(r.country, {
      sessions: prev.sessions + r.sessions,
      activeUsers: prev.activeUsers + r.activeUsers,
    });
  }
  const byCountry: GeographyCountryRow[] = Array.from(countryTotals.entries())
    .map(([country, v]) => ({ country, sessions: v.sessions, activeUsers: v.activeUsers }))
    .sort((a, b) => b.sessions - a.sessions);
  const newEnglandShare = totalSessions > 0 ? newEnglandSessions / totalSessions : 0;

  const geography: GeographyBreakdown = { byCountry, byRegion, newEnglandShare };

  const dateRangeDescriptor: DateRangeDescriptor | undefined = resolvedRange
    ? {
        startDate: resolvedRange.startDate,
        endDate: resolvedRange.endDate,
        days: resolvedRange.days,
        label: resolvedRange.label,
      }
    : undefined;
  const previousDateRangeDescriptor: DateRangeDescriptor | undefined = resolvedRange
    ? {
        startDate: resolvedRange.previousStartDate,
        endDate: resolvedRange.previousEndDate,
        days: resolvedRange.days,
      }
    : undefined;

  return {
    path,
    title,
    totals,
    previousTotals,
    byDay,
    trafficSources,
    devices,
    events,
    geography,
    ...(dateRangeDescriptor ? { dateRange: dateRangeDescriptor } : {}),
    ...(previousDateRangeDescriptor ? { previousDateRange: previousDateRangeDescriptor } : {}),
    propertyId,
    generatedAt: new Date().toISOString(),
  };
}

export type EventDetailValueRow = {
  parameters: Record<string, string>;
  count: number;
};

export type EventDetailResult = {
  eventName: string;
  totalCount: number;
  dateRange?: DateRangeDescriptor;
  topParameters: string[];
  topValues: EventDetailValueRow[];
  propertyId: string;
  generatedAt: string;
};

/**
 * Top parameter-value combinations for a specific GA4 event name.
 * Each parameter in `topParameters` must be registered as a custom
 * dimension in GA4 Admin -> Custom Definitions before it will be
 * queryable via the Data API. Unregistered parameters return empty rows.
 */
export async function getGa4EventDetail(
  env: Ga4Env,
  eventName: string,
  opts: {
    skipCache?: boolean;
    dateRange?: DateRangeInput;
    path?: string;
    topParameters?: string[];
    topN?: number;
  } = {}
): Promise<EventDetailResult> {
  const { propertyId } = resolveConfig(env);
  const accessToken = await getGa4AccessToken(env, { skipCache: opts.skipCache });
  const passthrough = { skipCache: opts.skipCache, accessToken };

  const usesCustomRange = !!(opts.dateRange?.startDate || opts.dateRange?.preset);
  const resolvedRange: ResolvedDateRange | null = usesCustomRange
    ? resolveDateRange(opts.dateRange, { defaultPreset: "last_28d" })
    : null;
  const rangeForQuery = resolvedRange
    ? [{ startDate: resolvedRange.startDate, endDate: resolvedRange.endDate }]
    : [{ startDate: "28daysAgo", endDate: "today" }];

  const topParameters = (opts.topParameters ?? []).filter((p) => p && p.length > 0);
  const topN = Math.min(Math.max(opts.topN ?? 20, 1), 100);

  // Build the dimension filter: always eventName matches; optionally add pagePath
  const eventNameFilter: DimensionFilterExpression = {
    filter: {
      fieldName: "eventName",
      stringFilter: { matchType: "EXACT", value: eventName, caseSensitive: false },
    },
  };
  const dimensionFilter: DimensionFilterExpression = opts.path
    ? {
        andGroup: {
          expressions: [eventNameFilter, pagePathFilter(opts.path)],
        },
      }
    : eventNameFilter;

  // GA4 Data API custom parameter dimension shape: `customEvent:<paramName>`.
  // Unregistered params will silently return empty — caller should verify in
  // GA4 Admin -> Custom Definitions if counts look surprisingly low.
  const paramDimensions = topParameters.map((name) => ({ name: `customEvent:${name}` }));

  const [totalsRes, valuesRes] = await Promise.all([
    runReport(
      env,
      {
        dateRanges: rangeForQuery,
        metrics: [{ name: "eventCount" }],
        dimensionFilter,
      },
      passthrough
    ),
    paramDimensions.length > 0
      ? runReport(
          env,
          {
            dateRanges: rangeForQuery,
            dimensions: paramDimensions,
            metrics: [{ name: "eventCount" }],
            orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
            limit: topN,
            dimensionFilter,
          },
          passthrough
        )
      : Promise.resolve({ rows: [] } as RunReportResponse),
  ]);

  const totalCount = toNumber(totalsRes.rows?.[0]?.metricValues?.[0]?.value);

  const topValues: EventDetailValueRow[] = (valuesRes.rows ?? []).map((row) => {
    const parameters: Record<string, string> = {};
    topParameters.forEach((paramName, i) => {
      parameters[paramName] = row.dimensionValues?.[i]?.value ?? "";
    });
    return { parameters, count: toNumber(row.metricValues?.[0]?.value) };
  });

  const dateRangeDescriptor: DateRangeDescriptor | undefined = resolvedRange
    ? {
        startDate: resolvedRange.startDate,
        endDate: resolvedRange.endDate,
        days: resolvedRange.days,
        label: resolvedRange.label,
      }
    : undefined;

  return {
    eventName,
    totalCount,
    ...(dateRangeDescriptor ? { dateRange: dateRangeDescriptor } : {}),
    topParameters,
    topValues,
    propertyId,
    generatedAt: new Date().toISOString(),
  };
}
