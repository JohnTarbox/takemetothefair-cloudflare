import Link from "next/link";
import { ExternalLink, RefreshCw, Users, BarChart3 } from "lucide-react";
import { desc, gte, sql } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { analyticsEvents, indexnowSubmissions } from "@/lib/db/schema";
import {
  Ga4ApiError,
  Ga4ConfigError,
  getDashboardMetrics,
  type DashboardMetrics,
  type Ga4Env,
} from "@/lib/ga4";
import {
  BingApiError,
  BingConfigError,
  getQueryStats,
  getPageStats,
  getCrawlStats,
  getSiteScanIssues,
  getIndexNowQuota,
  type BingEnv,
  type BingQueryRow,
  type BingPageRow,
  type BingCrawlStatsRow,
  type BingSiteScanIssue,
  type BingIndexNowQuota,
} from "@/lib/bing-webmaster";
import {
  ScApiError,
  ScConfigError,
  getSiteSearchQueries,
  getSitemapStatus,
  type ScEnv,
  type SiteSearchQueriesResult,
  type SitemapStatus,
} from "@/lib/search-console";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "google", label: "Google" },
  { key: "bing", label: "Bing" },
  { key: "site-health", label: "Site Health" },
  { key: "first-party-events", label: "First-party events" },
  { key: "indexnow", label: "IndexNow" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTabKey(value: string | undefined): value is TabKey {
  return TABS.some((t) => t.key === value);
}

type PageProps = {
  searchParams: Promise<{ refresh?: string; tab?: string }>;
};

type LoadResult =
  | { ok: true; data: DashboardMetrics }
  | { ok: false; kind: "config" | "api" | "unknown"; message: string };

async function load(skipCache: boolean): Promise<LoadResult> {
  try {
    const env = getCloudflareEnv() as unknown as Ga4Env;
    const data = await getDashboardMetrics(env, { skipCache });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof Ga4ConfigError) {
      return { ok: false, kind: "config", message: error.message };
    }
    if (error instanceof Ga4ApiError) {
      return { ok: false, kind: "api", message: error.detail };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "unknown", message };
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export default async function AdminAnalyticsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const tab: TabKey = isTabKey(params.tab) ? params.tab : "overview";
  const refresh = params.refresh === "1";

  // Only fetch GA4 data when the Overview tab is active
  const overviewResult = tab === "overview" ? await load(refresh) : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        {tab === "overview" && (
          <div className="flex items-center gap-4">
            <Link
              href="/admin/analytics?refresh=1"
              className="inline-flex items-center gap-1.5 text-sm text-gray-700 hover:text-gray-900"
            >
              <RefreshCw className="w-4 h-4" /> Refresh data
            </Link>
            {overviewResult?.ok && (
              <a
                href={`https://analytics.google.com/analytics/web/#/p${overviewResult.data.propertyId}/reports`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
              >
                Open in GA4 <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        )}
      </div>

      <TabBar currentTab={tab} />

      {tab === "overview" &&
        overviewResult &&
        (overviewResult.ok ? (
          <MetricsView data={overviewResult.data} />
        ) : (
          <ErrorPanel kind={overviewResult.kind} message={overviewResult.message} />
        ))}
      {tab === "google" && <GoogleTab />}
      {tab === "bing" && <BingTab />}
      {tab === "site-health" && <SiteHealthTab />}
      {tab === "first-party-events" && <FirstPartyEventsTab />}
      {tab === "indexnow" && <IndexNowTab />}
    </div>
  );
}

async function IndexNowTab() {
  const db = getCloudflareDb();
  const recent = await db
    .select()
    .from(indexnowSubmissions)
    .orderBy(desc(indexnowSubmissions.timestamp))
    .limit(25);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      success: "bg-green-100 text-green-800",
      failure: "bg-red-100 text-red-800",
      no_key: "bg-gray-200 text-gray-700",
      no_eligible_urls: "bg-yellow-100 text-yellow-800",
    };
    const cls = map[status] ?? "bg-gray-100 text-gray-700";
    return (
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
        {status}
      </span>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent IndexNow submissions (last 25)</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-6 py-2 font-medium">Time</th>
              <th className="text-left px-6 py-2 font-medium">Source</th>
              <th className="text-right px-6 py-2 font-medium">URLs</th>
              <th className="text-left px-6 py-2 font-medium">Status</th>
              <th className="text-right px-6 py-2 font-medium">HTTP</th>
              <th className="text-left px-6 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {recent.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-6 text-gray-500">
                  No IndexNow submissions recorded yet. Trigger one by editing a published blog post
                  or transitioning an event to APPROVED.
                </td>
              </tr>
            ) : (
              recent.map((row) => {
                let urlsArr: string[] = [];
                try {
                  urlsArr = JSON.parse(row.urls) as string[];
                } catch {
                  // leave empty
                }
                const firstUrl = urlsArr[0] ?? "";
                const moreCount = Math.max(0, urlsArr.length - 1);
                return (
                  <tr key={row.id} className="align-top">
                    <td className="px-6 py-2 whitespace-nowrap text-gray-700 tabular-nums">
                      {new Date(row.timestamp * 1000).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-6 py-2 font-mono text-xs text-gray-900">{row.source}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.urlCount)}</td>
                    <td className="px-6 py-2">{statusBadge(row.status)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-gray-700">
                      {row.httpStatus ?? "—"}
                    </td>
                    <td className="px-6 py-2 text-xs text-gray-700 break-all max-w-md">
                      {row.errorMessage ? (
                        <span className="text-red-700">{row.errorMessage}</span>
                      ) : firstUrl ? (
                        <span>
                          <span className="font-mono">{firstUrl}</span>
                          {moreCount > 0 && (
                            <span className="text-gray-500"> +{moreCount} more</span>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

async function FirstPartyEventsTab() {
  const db = getCloudflareDb();
  const days = 30;
  const sinceTimestamp = Math.floor(Date.now() / 1000) - days * 86400;

  const [recent, summary] = await Promise.all([
    db
      .select()
      .from(analyticsEvents)
      .where(gte(analyticsEvents.timestamp, sinceTimestamp))
      .orderBy(desc(analyticsEvents.timestamp))
      .limit(100),
    db
      .select({
        eventName: analyticsEvents.eventName,
        count: sql<number>`COUNT(*)`,
      })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.timestamp, sinceTimestamp))
      .groupBy(analyticsEvents.eventName)
      .orderBy(sql`COUNT(*) DESC`),
  ]);

  return (
    <>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Event counts (last {days} days)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Event</th>
                <th className="text-right px-6 py-2 font-medium">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summary.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-6 py-6 text-gray-500">
                    No first-party events recorded yet.
                  </td>
                </tr>
              ) : (
                summary.map((row) => (
                  <tr key={row.eventName}>
                    <td className="px-6 py-2 font-mono text-xs text-gray-900">{row.eventName}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.count)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent events</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Time</th>
                <th className="text-left px-6 py-2 font-medium">Category</th>
                <th className="text-left px-6 py-2 font-medium">Event</th>
                <th className="text-left px-6 py-2 font-medium">User</th>
                <th className="text-left px-6 py-2 font-medium">Properties</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-6 text-gray-500">
                    No events in the last {days} days.
                  </td>
                </tr>
              ) : (
                recent.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="px-6 py-2 whitespace-nowrap text-gray-700 tabular-nums">
                      {new Date(row.timestamp * 1000).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-6 py-2 text-gray-700">{row.eventCategory}</td>
                    <td className="px-6 py-2 font-mono text-xs text-gray-900">{row.eventName}</td>
                    <td className="px-6 py-2 font-mono text-xs text-gray-600">
                      {row.userId ? row.userId.slice(0, 8) : "—"}
                    </td>
                    <td className="px-6 py-2 font-mono text-xs text-gray-700 break-all max-w-md">
                      {row.properties && row.properties !== "{}" ? row.properties : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}

function TabBar({ currentTab }: { currentTab: TabKey }) {
  return (
    <div
      role="tablist"
      aria-label="Analytics sections"
      className="mb-6 flex flex-wrap gap-2 border-b border-gray-200 pb-2"
    >
      {TABS.map((tab) => {
        const isActive = currentTab === tab.key;
        const href =
          tab.key === "overview" ? "/admin/analytics" : `/admin/analytics?tab=${tab.key}`;
        return (
          <Link
            key={tab.key}
            href={href}
            role="tab"
            aria-selected={isActive}
            className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              isActive ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900 hover:bg-gray-200"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function MetricsView({ data }: { data: DashboardMetrics }) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <StatCard label="Active users (last 7 days)" value={fmt(data.activeUsers.last7d)} />
        <StatCard label="Active users (last 28 days)" value={fmt(data.activeUsers.last28d)} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Top pages (last 28 days)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Path</th>
                <th className="text-left px-6 py-2 font-medium">Title</th>
                <th className="text-right px-6 py-2 font-medium">Views</th>
                <th className="text-right px-6 py-2 font-medium">Users</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.topPages.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-6 text-gray-500">
                    No data yet.
                  </td>
                </tr>
              ) : (
                data.topPages.map((row, i) => (
                  <tr key={`${row.path}-${i}`}>
                    <td className="px-6 py-2 font-mono text-xs truncate max-w-xs">
                      <Link
                        href={`/admin/analytics/page?path=${encodeURIComponent(row.path)}`}
                        className="text-blue-600 hover:text-blue-700 hover:underline"
                      >
                        {row.path}
                      </Link>
                    </td>
                    <td className="px-6 py-2 text-gray-700 truncate max-w-xs">{row.title}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.views)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                      {fmt(row.activeUsers)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Top events (last 28 days)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-6 py-2 font-medium">Event</th>
                  <th className="text-right px-6 py-2 font-medium">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.topEvents.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-6 py-6 text-gray-500">
                      No events tracked yet.
                    </td>
                  </tr>
                ) : (
                  data.topEvents.map((row, i) => (
                    <tr key={`${row.eventName}-${i}`}>
                      <td className="px-6 py-2 font-mono text-xs text-gray-900">{row.eventName}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(row.count)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Traffic sources (last 28 days)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-6 py-2 font-medium">Source</th>
                  <th className="text-left px-6 py-2 font-medium">Medium</th>
                  <th className="text-right px-6 py-2 font-medium">Sessions</th>
                  <th className="text-right px-6 py-2 font-medium">Users</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.trafficSources.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-6 text-gray-500">
                      No data yet.
                    </td>
                  </tr>
                ) : (
                  data.trafficSources.map((row, i) => (
                    <tr key={`${row.source}-${row.medium}-${i}`}>
                      <td className="px-6 py-2 text-gray-900">{row.source || "(direct)"}</td>
                      <td className="px-6 py-2 text-gray-700">{row.medium || "(none)"}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(row.sessions)}</td>
                      <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                        {fmt(row.activeUsers)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-gray-500 mt-6">
        Property {data.propertyId} · Generated{" "}
        {new Date(data.generatedAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })}{" "}
        · Cached up to 10 min
      </p>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-600">{label}</p>
            <p className="text-4xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
          </div>
          <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-blue-100">
            <Users className="w-6 h-6 text-blue-600" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

type GscLoad =
  | {
      ok: true;
      queries: SiteSearchQueriesResult | null;
      sitemaps: SitemapStatus | null;
    }
  | { ok: false; kind: "config" | "api" | "unknown"; message: string };

async function loadGscData(): Promise<GscLoad> {
  try {
    const env = getCloudflareEnv() as unknown as ScEnv;
    const settled = await Promise.allSettled([
      getSiteSearchQueries(env, { rowLimit: 25 }),
      getSitemapStatus(env),
    ]);
    const firstFailure = settled.find((r) => r.status === "rejected");
    if (firstFailure && firstFailure.status === "rejected") {
      const err = firstFailure.reason;
      // Surface config errors as a tab-level setup card; downgrade per-endpoint
      // failures to silent nulls so one outage doesn't blank the whole tab.
      if (err instanceof ScConfigError) {
        return { ok: false, kind: "config", message: err.message };
      }
    }
    const [queries, sitemaps] = settled.map((r) => (r.status === "fulfilled" ? r.value : null));
    return {
      ok: true,
      queries: (queries as SiteSearchQueriesResult | null) ?? null,
      sitemaps: (sitemaps as SitemapStatus | null) ?? null,
    };
  } catch (error) {
    if (error instanceof ScConfigError) {
      return { ok: false, kind: "config", message: error.message };
    }
    if (error instanceof ScApiError) {
      return { ok: false, kind: "api", message: error.detail };
    }
    return {
      ok: false,
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function GoogleTab() {
  const result = await loadGscData();
  if (!result.ok) {
    return <GscErrorPanel kind={result.kind} message={result.message} />;
  }
  const { queries, sitemaps } = result;
  const sitemapErrorCount = sitemaps?.sitemaps.reduce((acc, s) => acc + (s.errors ?? 0), 0) ?? 0;
  const sitemapWarningCount =
    sitemaps?.sitemaps.reduce((acc, s) => acc + (s.warnings ?? 0), 0) ?? 0;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Total clicks</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">
              {fmt(queries?.totals.clicks ?? 0)}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {queries ? `${queries.dateRange.startDate} → ${queries.dateRange.endDate}` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Unique queries</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">
              {fmt(queries?.totals.queries ?? 0)}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {fmt(queries?.totals.impressions ?? 0)} impressions
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Sitemap status</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">
              {fmt(sitemaps?.totals.indexed ?? 0)} /{" "}
              <span className="text-base font-normal text-gray-500">
                {fmt(sitemaps?.totals.submitted ?? 0)}
              </span>
            </p>
            <p className="text-xs text-gray-500 mt-1">
              indexed / submitted · {fmt(sitemapErrorCount)} errors · {fmt(sitemapWarningCount)}{" "}
              warnings
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Top GSC queries</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Query</th>
                <th className="text-right px-6 py-2 font-medium">Clicks</th>
                <th className="text-right px-6 py-2 font-medium">Impressions</th>
                <th className="text-right px-6 py-2 font-medium">CTR</th>
                <th className="text-right px-6 py-2 font-medium">Avg position</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {!queries || queries.queries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-6 text-gray-500">
                    No GSC query data for the current window.
                  </td>
                </tr>
              ) : (
                queries.queries.map((row, i) => (
                  <tr key={`${row.query}-${i}`}>
                    <td className="px-6 py-2 text-gray-900 truncate max-w-md">{row.query}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.clicks)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                      {fmt(row.impressions)}
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                      {(row.ctr * 100).toFixed(1)}%
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                      {row.position.toFixed(1)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Submitted sitemaps</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Path</th>
                <th className="text-right px-6 py-2 font-medium">Submitted</th>
                <th className="text-right px-6 py-2 font-medium">Indexed</th>
                <th className="text-right px-6 py-2 font-medium">Warnings</th>
                <th className="text-right px-6 py-2 font-medium">Errors</th>
                <th className="text-left px-6 py-2 font-medium">Last submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {!sitemaps || sitemaps.sitemaps.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-6 text-gray-500">
                    No sitemaps submitted to GSC.
                  </td>
                </tr>
              ) : (
                sitemaps.sitemaps.map((row) => {
                  const submittedTotal = row.contents.reduce((acc, c) => acc + c.submitted, 0);
                  const indexedTotal = row.contents.reduce((acc, c) => acc + c.indexed, 0);
                  return (
                    <tr key={row.path}>
                      <td className="px-6 py-2 font-mono text-xs truncate max-w-md">{row.path}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(submittedTotal)}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(indexedTotal)}</td>
                      <td className="px-6 py-2 text-right tabular-nums text-amber-700">
                        {fmt(row.warnings)}
                      </td>
                      <td className="px-6 py-2 text-right tabular-nums text-red-700">
                        {fmt(row.errors)}
                      </td>
                      <td className="px-6 py-2 text-gray-700">
                        {row.lastSubmitted
                          ? new Date(row.lastSubmitted).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}

function GscErrorPanel({ kind, message }: { kind: "config" | "api" | "unknown"; message: string }) {
  const isConfig = kind === "config";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-gray-500" />
          {isConfig ? "Search Console not configured" : "Could not load Search Console data"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-700 mb-4">{message}</p>
        {isConfig && (
          <div className="text-sm text-gray-700 space-y-2">
            <p className="font-medium">One-time setup:</p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                Confirm{" "}
                <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                  SC_SITE_URL
                </span>{" "}
                is set on the Pages deployment to either <code>sc-domain:meetmeatthefair.com</code>{" "}
                (Domain property) or <code>https://meetmeatthefair.com/</code> (URL-prefix
                property).
              </li>
              <li>
                Confirm the GA4 service account email has been granted access to the Search Console
                property under Settings → Users and permissions.
              </li>
              <li>Redeploy and reload this tab.</li>
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type BingLoad =
  | { ok: true; data: BingTabData }
  | { ok: false; kind: "config" | "api" | "unknown"; message: string };

interface BingTabData {
  queries: BingQueryRow[];
  pages: BingPageRow[];
  crawl: BingCrawlStatsRow[];
  scan: BingSiteScanIssue[];
  quota: BingIndexNowQuota | null;
}

async function loadBingData(): Promise<BingLoad> {
  try {
    const env = getCloudflareEnv() as unknown as BingEnv;
    // Run all Bing reports in parallel. Each result is independently catchable
    // so a transient failure on one (e.g. site-scan returning 404 before Bing
    // has completed a scan) doesn't blank the whole tab.
    const settled = await Promise.allSettled([
      getQueryStats(env),
      getPageStats(env),
      getCrawlStats(env),
      getSiteScanIssues(env),
      getIndexNowQuota(env),
    ]);
    // If the first call (queries) hit BingConfigError, surface that as the
    // tab-level error so the operator knows the API key isn't set.
    const firstFailure = settled.find((r) => r.status === "rejected");
    if (firstFailure && firstFailure.status === "rejected") {
      const err = firstFailure.reason;
      if (err instanceof BingConfigError) {
        return { ok: false, kind: "config", message: err.message };
      }
    }
    const [queries, pages, crawl, scan, quota] = settled.map((r) =>
      r.status === "fulfilled" ? r.value : null
    );
    return {
      ok: true,
      data: {
        queries: (queries as BingQueryRow[] | null) ?? [],
        pages: (pages as BingPageRow[] | null) ?? [],
        crawl: (crawl as BingCrawlStatsRow[] | null) ?? [],
        scan: (scan as BingSiteScanIssue[] | null) ?? [],
        quota: (quota as BingIndexNowQuota | null) ?? null,
      },
    };
  } catch (error) {
    if (error instanceof BingConfigError) {
      return { ok: false, kind: "config", message: error.message };
    }
    if (error instanceof BingApiError) {
      return { ok: false, kind: "api", message: error.detail };
    }
    return {
      ok: false,
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function BingTab() {
  const result = await loadBingData();
  if (!result.ok) {
    return <BingErrorPanel kind={result.kind} message={result.message} />;
  }
  const { queries, pages, crawl, scan, quota } = result.data;
  const errorCount = scan.filter((i) => i.severity === "Error").length;
  const warningCount = scan.filter((i) => i.severity === "Warning").length;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Bingbot crawl issues</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">
              {fmt(errorCount)} errors · {fmt(warningCount)} warnings
            </p>
            <p className="text-xs text-gray-500 mt-1">
              From Bingbot&apos;s crawl. The manual Site Scan tool isn&apos;t exposed via API —{" "}
              <a
                href="https://www.bing.com/webmasters/sitescan?siteUrl=https://meetmeatthefair.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700"
              >
                view in BWT
              </a>
              .
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Search clicks (recent)</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">
              {fmt(queries.reduce((acc, q) => acc + q.clicks, 0))}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {queries.length} unique {queries.length === 1 ? "query" : "queries"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">IndexNow quota</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">
              {quota ? fmt(quota.dailyRemaining) : "—"}
              {quota && (
                <span className="text-base font-normal text-gray-500">
                  {" "}
                  / {fmt(quota.dailyQuota)} daily
                </span>
              )}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {quota
                ? `${fmt(quota.monthlyRemaining)} of ${fmt(quota.monthlyQuota)} monthly`
                : "Unavailable"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Top Bing queries</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Query</th>
                <th className="text-right px-6 py-2 font-medium">Clicks</th>
                <th className="text-right px-6 py-2 font-medium">Impressions</th>
                <th className="text-right px-6 py-2 font-medium">Avg position</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {queries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-6 text-gray-500">
                    No Bing query data yet. Bing typically takes 7&ndash;14 days after site
                    verification to start reporting search-performance data.
                  </td>
                </tr>
              ) : (
                queries.slice(0, 25).map((row, i) => (
                  <tr key={`${row.query}-${i}`}>
                    <td className="px-6 py-2 text-gray-900 truncate max-w-md">{row.query}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.clicks)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                      {fmt(row.impressions)}
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                      {row.avgImpressionPosition.toFixed(1)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Top pages (Bing)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-6 py-2 font-medium">Page</th>
                  <th className="text-right px-6 py-2 font-medium">Clicks</th>
                  <th className="text-right px-6 py-2 font-medium">Impr.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pages.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-6 text-gray-500">
                      No data yet. Populates after Bing accumulates impression data (typically
                      7&ndash;14 days post-verification).
                    </td>
                  </tr>
                ) : (
                  pages.slice(0, 15).map((row, i) => (
                    <tr key={`${row.page}-${i}`}>
                      <td className="px-6 py-2 font-mono text-xs truncate max-w-xs">{row.page}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(row.clicks)}</td>
                      <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                        {fmt(row.impressions)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Crawl stats (recent)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-6 py-2 font-medium">Date</th>
                  <th className="text-right px-6 py-2 font-medium">Crawled</th>
                  <th className="text-right px-6 py-2 font-medium">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {crawl.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-6 text-gray-500">
                      No crawl data yet. Bingbot needs to visit the site at least once; can take a
                      few days after sitemap submission.
                    </td>
                  </tr>
                ) : (
                  crawl.slice(0, 14).map((row) => (
                    <tr key={row.date}>
                      <td className="px-6 py-2 tabular-nums text-gray-700">{row.date}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(row.crawledPages)}</td>
                      <td className="px-6 py-2 text-right tabular-nums text-gray-600">
                        {fmt(row.crawlErrors)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function BingErrorPanel({
  kind,
  message,
}: {
  kind: "config" | "api" | "unknown";
  message: string;
}) {
  const isConfig = kind === "config";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-gray-500" />
          {isConfig ? "Bing Webmaster Tools not configured" : "Could not load Bing data"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-700 mb-4">{message}</p>
        {isConfig && (
          <div className="text-sm text-gray-700 space-y-2">
            <p className="font-medium">One-time setup:</p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                Sign in at{" "}
                <a
                  href="https://www.bing.com/webmasters/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-700"
                >
                  Bing Webmaster Tools
                </a>{" "}
                and verify ownership of <code>meetmeatthefair.com</code>.
              </li>
              <li>
                In Settings → API Access, generate an account-wide API key. Treat this key like a
                password — it grants read access to all sites under the account.
              </li>
              <li>
                Set the secret on the Worker:
                <pre className="mt-2 bg-gray-100 p-2 rounded font-mono text-xs">
                  wrangler secret put BING_WEBMASTER_API_KEY
                </pre>
              </li>
              <li>Redeploy the main app, then reload this tab.</li>
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function SiteHealthTab() {
  const db = getCloudflareDb();
  const { getCurrentIssues } = await import("@/lib/site-health");
  const issues = await getCurrentIssues(db, { hideSnoozed: false });
  const now = Math.floor(Date.now() / 1000);
  const activeSnoozeCount = issues.filter((i) => i.snoozedUntil && i.snoozedUntil > now).length;
  const errorCount = issues.filter(
    (i) => i.severity === "ERROR" && (!i.snoozedUntil || i.snoozedUntil <= now)
  ).length;
  const warningCount = issues.filter(
    (i) => i.severity === "WARNING" && (!i.snoozedUntil || i.snoozedUntil <= now)
  ).length;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Open errors</p>
            <p className="text-3xl font-bold text-red-700 mt-1 tabular-nums">{fmt(errorCount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Open warnings</p>
            <p className="text-3xl font-bold text-amber-700 mt-1 tabular-nums">
              {fmt(warningCount)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600">Snoozed</p>
            <p className="text-3xl font-bold text-gray-500 mt-1 tabular-nums">
              {fmt(activeSnoozeCount)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current issues</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Source</th>
                <th className="text-left px-6 py-2 font-medium">Issue</th>
                <th className="text-left px-6 py-2 font-medium">Severity</th>
                <th className="text-left px-6 py-2 font-medium">URL</th>
                <th className="text-left px-6 py-2 font-medium">Last detected</th>
                <th className="text-left px-6 py-2 font-medium">Snoozed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {issues.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-6 text-gray-500">
                    No open issues. Run the daily sweep to refresh.
                  </td>
                </tr>
              ) : (
                issues.map((row) => {
                  const snoozed = row.snoozedUntil && row.snoozedUntil > now;
                  const sevColor =
                    row.severity === "ERROR"
                      ? "text-red-700"
                      : row.severity === "WARNING"
                        ? "text-amber-700"
                        : "text-gray-600";
                  return (
                    <tr key={row.fingerprint} className={snoozed ? "opacity-50" : ""}>
                      <td className="px-6 py-2 font-mono text-xs">{row.source}</td>
                      <td className="px-6 py-2 text-gray-900">
                        {row.issueType}
                        {row.message && <span className="text-gray-500"> · {row.message}</span>}
                      </td>
                      <td className={`px-6 py-2 font-medium ${sevColor}`}>{row.severity}</td>
                      <td className="px-6 py-2 font-mono text-xs truncate max-w-xs">
                        {row.url ? (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {row.url}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-6 py-2 tabular-nums text-gray-700">
                        {new Date(row.lastDetectedAt * 1000).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td className="px-6 py-2 text-gray-700">
                        {snoozed && row.snoozedUntil
                          ? `until ${new Date(row.snoozedUntil * 1000).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-gray-500 mt-4">
        Snooze and refresh actions are exposed via the API endpoints under{" "}
        <code>/api/admin/site-health/*</code> and the <code>get_site_health_issues</code> /{" "}
        <code>snooze_site_health_issue</code> MCP tools. A UI control row can layer on top in a
        follow-up.
      </p>
    </>
  );
}

function ErrorPanel({ kind, message }: { kind: "config" | "api" | "unknown"; message: string }) {
  const isConfig = kind === "config";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-gray-500" />
          {isConfig ? "GA4 analytics not configured" : "Could not load GA4 data"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-700 mb-4">{message}</p>

        {isConfig && (
          <div className="text-sm text-gray-700 space-y-3">
            <p className="font-medium">One-time setup:</p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                In{" "}
                <a
                  href="https://console.cloud.google.com/iam-admin/serviceaccounts"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-700"
                >
                  Google Cloud Console
                </a>
                , create a service account and download its JSON key.
              </li>
              <li>
                Enable the{" "}
                <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                  Google Analytics Data API
                </span>{" "}
                on the same GCP project.
              </li>
              <li>
                In GA4 → Admin → Property Access Management, add the service account email with the{" "}
                <strong>Viewer</strong> role on the property you want to read.
              </li>
              <li>
                In the Cloudflare Pages dashboard, set three environment variables on the production
                deployment:
                <ul className="list-disc pl-5 mt-2 space-y-1 font-mono text-xs">
                  <li>
                    <span className="bg-gray-100 px-1.5 py-0.5 rounded">GA4_PROPERTY_ID</span> —
                    numeric property ID
                  </li>
                  <li>
                    <span className="bg-gray-100 px-1.5 py-0.5 rounded">GA4_SA_CLIENT_EMAIL</span> —{" "}
                    <code>client_email</code> from the JSON key
                  </li>
                  <li>
                    <span className="bg-gray-100 px-1.5 py-0.5 rounded">GA4_SA_PRIVATE_KEY</span> —
                    the full <code>private_key</code> PEM (encrypt this one)
                  </li>
                </ul>
              </li>
              <li>Redeploy, then reload this page.</li>
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
