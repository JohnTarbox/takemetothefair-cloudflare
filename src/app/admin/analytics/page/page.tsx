import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  Download,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  Ga4ApiError,
  Ga4ConfigError,
  getPageMetrics,
  type Ga4Env,
  type PageMetrics,
  type PageViewsDay,
} from "@/lib/ga4";
import {
  getSearchQueriesForPage,
  ScApiError,
  ScConfigError,
  type ScEnv,
  type SearchQueryRow,
} from "@/lib/search-console";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ path?: string; refresh?: string }>;
};

type Ga4Result =
  | { ok: true; data: PageMetrics }
  | { ok: false; kind: "config" | "api" | "unknown"; message: string };

type ScResult =
  | { ok: true; data: SearchQueryRow[] }
  | { ok: false; kind: "config" | "api" | "unknown"; message: string };

async function loadGa4(path: string, skipCache: boolean): Promise<Ga4Result> {
  try {
    const env = getCloudflareEnv() as unknown as Ga4Env;
    const data = await getPageMetrics(env, path, { skipCache });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof Ga4ConfigError)
      return { ok: false, kind: "config", message: error.message };
    if (error instanceof Ga4ApiError) return { ok: false, kind: "api", message: error.detail };
    return {
      ok: false,
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadSc(path: string, skipCache: boolean): Promise<ScResult> {
  try {
    const env = getCloudflareEnv() as unknown as ScEnv;
    const data = await getSearchQueriesForPage(env, path, { skipCache });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ScConfigError)
      return { ok: false, kind: "config", message: error.message };
    if (error instanceof ScApiError) return { ok: false, kind: "api", message: error.detail };
    return {
      ok: false,
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtPosition(n: number): string {
  return n.toFixed(1);
}

function fmtDate(ga4Date: string): string {
  if (ga4Date.length !== 8) return ga4Date;
  return `${ga4Date.slice(0, 4)}-${ga4Date.slice(4, 6)}-${ga4Date.slice(6, 8)}`;
}

function buildCsv(rows: PageViewsDay[]): string {
  const header = "date,views,users";
  const body = rows.map((r) => `${fmtDate(r.date)},${r.views},${r.users}`).join("\n");
  return `${header}\n${body}\n`;
}

export default async function AdminAnalyticsPageDetail({ searchParams }: PageProps) {
  const { path, refresh } = await searchParams;
  if (!path || !path.startsWith("/")) notFound();
  const skipCache = refresh === "1";

  const [ga4Result, scResult] = await Promise.all([
    loadGa4(path, skipCache),
    loadSc(path, skipCache),
  ]);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/analytics"
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4" /> Back to analytics overview
        </Link>
      </div>

      <div className="flex items-center justify-between mb-8 gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Page analytics</h1>
          <p className="font-mono text-sm text-gray-600 mt-1 break-all">{path}</p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <Link
            href={`/admin/analytics/page?path=${encodeURIComponent(path)}&refresh=1`}
            className="inline-flex items-center gap-1.5 text-sm text-gray-700 hover:text-gray-900"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </Link>
          <a
            href={path}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
          >
            Open live page <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {!ga4Result.ok ? (
        <ErrorPanel
          kind={ga4Result.kind}
          message={ga4Result.message}
          title="Could not load GA4 data"
        />
      ) : (
        <DetailView data={ga4Result.data} scResult={scResult} path={path} />
      )}
    </div>
  );
}

function DetailView({
  data,
  scResult,
  path,
}: {
  data: PageMetrics;
  scResult: ScResult;
  path: string;
}) {
  const hasData = data.totals.views > 0;
  const csv = buildCsv(data.byDay);
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  const csvFilename = `analytics${path.replace(/\//g, "_") || "_root"}.csv`;

  return (
    <>
      {data.title && (
        <p className="text-gray-700 mb-6">
          <span className="text-gray-500">Title:</span> {data.title}
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Page views"
          value={fmt(data.totals.views)}
          current={data.totals.views}
          previous={data.previousTotals.views}
          fmtDelta={fmt}
        />
        <StatCard
          label="Unique users"
          value={fmt(data.totals.activeUsers)}
          current={data.totals.activeUsers}
          previous={data.previousTotals.activeUsers}
          fmtDelta={fmt}
        />
        <StatCard
          label="Sessions"
          value={fmt(data.totals.sessions)}
          current={data.totals.sessions}
          previous={data.previousTotals.sessions}
          fmtDelta={fmt}
        />
        <StatCard
          label="Engagement rate"
          value={fmtPct(data.totals.engagementRate)}
          current={data.totals.engagementRate}
          previous={data.previousTotals.engagementRate}
          isPercentage
        />
      </div>

      <Card className="mb-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Daily views (last 28 days)</CardTitle>
          {hasData && (
            <a
              href={csvHref}
              download={csvFilename}
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
            >
              <Download className="w-4 h-4" /> CSV
            </a>
          )}
        </CardHeader>
        <CardContent>{hasData ? <DailyChart data={data.byDay} /> : <EmptyState />}</CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Traffic sources to this page</CardTitle>
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

        <Card>
          <CardHeader>
            <CardTitle>Device breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {data.devices.length === 0 ? (
              <EmptyState />
            ) : (
              <DeviceBars
                rows={data.devices.map((d) => ({
                  label: d.category || "unknown",
                  value: d.sessions,
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Events on this page (last 28 days)</CardTitle>
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
                {data.events.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-6 py-6 text-gray-500">
                      No events tracked on this page.
                    </td>
                  </tr>
                ) : (
                  data.events.map((row, i) => (
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
            <CardTitle>Top search queries (Search Console)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <SearchQueriesPanel result={scResult} />
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-gray-500 mt-6">
        Property {data.propertyId} · Generated{" "}
        {new Date(data.generatedAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })}{" "}
        · Cached up to 10 min (Search Console up to 15 min)
      </p>
    </>
  );
}

function SearchQueriesPanel({ result }: { result: ScResult }) {
  if (!result.ok) {
    if (result.kind === "config") {
      return (
        <div className="p-6 text-sm text-gray-600 space-y-2">
          <p>Search Console is not configured.</p>
          <p className="text-xs text-gray-500">{result.message}</p>
        </div>
      );
    }
    return (
      <div className="p-6 text-sm text-gray-700">
        <p className="font-medium mb-1">Could not load Search Console data</p>
        <p className="text-xs text-gray-500 break-words">{result.message}</p>
      </div>
    );
  }

  if (result.data.length === 0) {
    return (
      <div className="p-6 text-sm text-gray-500">
        No search queries returned for this page in the last 30 days.
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 text-gray-600">
        <tr>
          <th className="text-left px-6 py-2 font-medium">Query</th>
          <th className="text-right px-6 py-2 font-medium">Clicks</th>
          <th className="text-right px-6 py-2 font-medium">Impressions</th>
          <th className="text-right px-6 py-2 font-medium">CTR</th>
          <th className="text-right px-6 py-2 font-medium">Pos.</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {result.data.map((row, i) => (
          <tr key={`${row.query}-${i}`}>
            <td className="px-6 py-2 text-gray-900 truncate max-w-xs">{row.query}</td>
            <td className="px-6 py-2 text-right tabular-nums">{fmt(row.clicks)}</td>
            <td className="px-6 py-2 text-right tabular-nums text-gray-600">
              {fmt(row.impressions)}
            </td>
            <td className="px-6 py-2 text-right tabular-nums text-gray-600">{fmtPct(row.ctr)}</td>
            <td className="px-6 py-2 text-right tabular-nums text-gray-600">
              {fmtPosition(row.position)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatCard({
  label,
  value,
  current,
  previous,
  isPercentage,
  fmtDelta,
}: {
  label: string;
  value: string;
  current: number;
  previous: number;
  isPercentage?: boolean;
  fmtDelta?: (n: number) => string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-gray-600">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
        <Delta current={current} previous={previous} isPercentage={isPercentage} fmt={fmtDelta} />
      </CardContent>
    </Card>
  );
}

function Delta({
  current,
  previous,
  isPercentage,
  fmt: formatValue,
}: {
  current: number;
  previous: number;
  isPercentage?: boolean;
  fmt?: (n: number) => string;
}) {
  let label: string;
  let color: string;
  let Icon: typeof TrendingUp;

  if (previous === 0 && current === 0) {
    label = "no prior data";
    color = "text-gray-400";
    Icon = Minus;
  } else if (previous === 0) {
    label = "new";
    color = "text-emerald-600";
    Icon = TrendingUp;
  } else if (isPercentage) {
    const diff = (current - previous) * 100;
    const sign = diff > 0 ? "+" : "";
    label = `${sign}${diff.toFixed(1)} pts vs prev`;
    color = diff > 0 ? "text-emerald-600" : diff < 0 ? "text-rose-600" : "text-gray-500";
    Icon = diff > 0 ? TrendingUp : diff < 0 ? TrendingDown : Minus;
  } else {
    const diff = current - previous;
    const pct = (diff / previous) * 100;
    const sign = pct > 0 ? "+" : "";
    const deltaFmt = formatValue ?? ((n: number) => n.toString());
    label = `${sign}${pct.toFixed(0)}% (${sign}${deltaFmt(diff)}) vs prev`;
    color = diff > 0 ? "text-emerald-600" : diff < 0 ? "text-rose-600" : "text-gray-500";
    Icon = diff > 0 ? TrendingUp : diff < 0 ? TrendingDown : Minus;
  }

  return (
    <div className={`flex items-center gap-1 mt-2 text-xs ${color}`}>
      <Icon className="w-3 h-3" />
      <span>{label}</span>
    </div>
  );
}

function DailyChart({ data }: { data: PageViewsDay[] }) {
  const width = 800;
  const height = 200;
  const padX = 40;
  const padY = 20;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const max = Math.max(...data.map((d) => d.views), 1);
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const points = data.map((d, i) => {
    const x = padX + i * stepX;
    const y = padY + innerH - (d.views / max) * innerH;
    return { x, y, d };
  });

  const linePath = points
    .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
    .join(" ");
  const areaPath = `${linePath} L ${padX + (data.length - 1) * stepX} ${padY + innerH} L ${padX} ${padY + innerH} Z`;

  const firstDate = data[0]?.date ?? "";
  const lastDate = data[data.length - 1]?.date ?? "";

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48" preserveAspectRatio="none">
        <line
          x1={padX}
          y1={padY + innerH}
          x2={padX + innerW}
          y2={padY + innerH}
          stroke="rgb(229 231 235)"
          strokeWidth="1"
        />
        <line
          x1={padX}
          y1={padY + innerH / 2}
          x2={padX + innerW}
          y2={padY + innerH / 2}
          stroke="rgb(243 244 246)"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
        <path d={areaPath} fill="rgb(219 234 254)" opacity="0.6" />
        <path d={linePath} fill="none" stroke="rgb(37 99 235)" strokeWidth="2" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="rgb(37 99 235)">
            <title>
              {fmtDate(p.d.date)}: {p.d.views} views, {p.d.users} users
            </title>
          </circle>
        ))}
        <text x={padX - 8} y={padY + 4} textAnchor="end" fontSize="11" fill="rgb(107 114 128)">
          {fmt(max)}
        </text>
        <text
          x={padX - 8}
          y={padY + innerH + 4}
          textAnchor="end"
          fontSize="11"
          fill="rgb(107 114 128)"
        >
          0
        </text>
      </svg>
      <div className="flex justify-between text-xs text-gray-500 px-10 mt-1">
        <span>{fmtDate(firstDate)}</span>
        <span>{fmtDate(lastDate)}</span>
      </div>
    </div>
  );
}

function DeviceBars({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const colors = ["bg-blue-500", "bg-emerald-500", "bg-amber-500", "bg-violet-500"];
  return (
    <div className="space-y-3">
      <div className="flex w-full h-3 rounded overflow-hidden bg-gray-100">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={colors[i % colors.length]}
            style={{ width: `${(r.value / total) * 100}%` }}
            title={`${r.label}: ${r.value}`}
          />
        ))}
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={r.label} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-sm ${colors[i % colors.length]}`} />
              <span className="text-gray-700 capitalize">{r.label}</span>
            </div>
            <div className="text-gray-600 tabular-nums">
              {fmt(r.value)} · {((r.value / total) * 100).toFixed(1)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-10 text-center text-sm text-gray-500">
      No data for this page in the last 28 days.
    </div>
  );
}

function ErrorPanel({
  kind,
  message,
  title,
}: {
  kind: "config" | "api" | "unknown";
  message: string;
  title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{kind === "config" ? "GA4 analytics not configured" : title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-700">{message}</p>
      </CardContent>
    </Card>
  );
}
