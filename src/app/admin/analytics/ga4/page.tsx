import Link from "next/link";
import { ArrowLeft, ExternalLink, RefreshCw, Users, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  AEO_BUCKET_LABELS,
  AEO_BUCKET_ORDER,
  aeoBadgeColor,
  aeoDeltaPercent,
  Ga4ApiError,
  Ga4ConfigError,
  getAeoReferrals,
  getDashboardMetrics,
  summarizeFacebookTraffic,
  type AeoReferralsResult,
  type DashboardMetrics,
  type Ga4Env,
} from "@/lib/ga4";
import { formatTimestampForServer } from "@/lib/datetime";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type LoadResult =
  | { ok: true; data: DashboardMetrics; aeo: AeoReferralsResult }
  | { ok: false; kind: "config" | "api" | "unknown"; message: string };

async function load(skipCache: boolean): Promise<LoadResult> {
  try {
    const env = getCloudflareEnv() as unknown as Ga4Env;
    const [data, aeo] = await Promise.all([
      getDashboardMetrics(env, { skipCache }),
      getAeoReferrals(env, { skipCache }),
    ]);
    return { ok: true, data, aeo };
  } catch (error) {
    if (error instanceof Ga4ConfigError)
      return { ok: false, kind: "config", message: error.message };
    if (error instanceof Ga4ApiError) return { ok: false, kind: "api", message: error.detail };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "unknown", message };
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

type PageProps = {
  searchParams: Promise<{ refresh?: string }>;
};

export default async function Ga4DashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const refresh = params.refresh === "1";
  const result = await load(refresh);

  return (
    <div>
      <div className="mb-4">
        <Link
          href="/admin/analytics"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Analytics overview
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-foreground">GA4 dashboard</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/analytics/ga4?refresh=1"
            className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-foreground"
          >
            <RefreshCw className="w-4 h-4" /> Refresh data
          </Link>
          {result.ok && (
            <a
              href={`https://analytics.google.com/analytics/web/#/p${result.data.propertyId}/reports`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
            >
              Open in GA4 <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {result.ok ? (
        <MetricsView data={result.data} aeo={result.aeo} />
      ) : (
        <ErrorPanel kind={result.kind} message={result.message} />
      )}
    </div>
  );
}

function MetricsView({ data, aeo }: { data: DashboardMetrics; aeo: AeoReferralsResult }) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <StatCard label="Active users (last 7 days)" value={fmt(data.activeUsers.last7d)} />
        <StatCard label="Active users (last 28 days)" value={fmt(data.activeUsers.last28d)} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>AEO Referrals (last 7 days)</span>
            <AeoTotalBadge total={aeo.total} />
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="text-left px-6 py-2 font-medium">AI engine</th>
                <th className="text-right px-6 py-2 font-medium">Sessions (7d)</th>
                <th className="text-right px-6 py-2 font-medium">Prev 7d</th>
                <th className="text-right px-6 py-2 font-medium">Δ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {AEO_BUCKET_ORDER.map((bucket) => (
                <tr key={bucket}>
                  <td className="px-6 py-2 text-foreground">{AEO_BUCKET_LABELS[bucket]}</td>
                  <td className="px-6 py-2 text-right tabular-nums">{fmt(aeo.totals[bucket])}</td>
                  <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
                    {fmt(aeo.previous[bucket])}
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    <AeoDeltaCell current={aeo.totals[bucket]} previous={aeo.previous[bucket]} />
                  </td>
                </tr>
              ))}
              <tr className="bg-muted font-semibold">
                <td className="px-6 py-2 text-foreground">Total</td>
                <td className="px-6 py-2 text-right tabular-nums">{fmt(aeo.total)}</td>
                <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
                  {fmt(aeo.previousTotal)}
                </td>
                <td className="px-6 py-2 text-right tabular-nums">
                  <AeoDeltaCell current={aeo.total} previous={aeo.previousTotal} />
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <FacebookTrafficCard data={data} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Top pages (last 28 days)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
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
                  <td colSpan={4} className="px-6 py-6 text-muted-foreground">
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
                    <td className="px-6 py-2 text-foreground truncate max-w-xs">{row.title}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.views)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
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
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left px-6 py-2 font-medium">Event</th>
                  <th className="text-right px-6 py-2 font-medium">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.topEvents.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-6 py-6 text-muted-foreground">
                      No events tracked yet.
                    </td>
                  </tr>
                ) : (
                  data.topEvents.map((row, i) => (
                    <tr key={`${row.eventName}-${i}`}>
                      <td className="px-6 py-2 font-mono text-xs text-foreground">
                        {row.eventName}
                      </td>
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
              <thead className="bg-muted text-muted-foreground">
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
                    <td colSpan={4} className="px-6 py-6 text-muted-foreground">
                      No data yet.
                    </td>
                  </tr>
                ) : (
                  data.trafficSources.map((row, i) => (
                    <tr key={`${row.source}-${row.medium}-${i}`}>
                      <td className="px-6 py-2 text-foreground">{row.source || "(direct)"}</td>
                      <td className="px-6 py-2 text-foreground">{row.medium || "(none)"}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(row.sessions)}</td>
                      <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
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

      <p className="text-xs text-muted-foreground mt-6">
        Property {data.propertyId} · Generated {formatTimestampForServer(data.generatedAt)} · Cached
        up to 10 min
      </p>
    </>
  );
}

function FacebookTrafficCard({ data }: { data: DashboardMetrics }) {
  const fb = summarizeFacebookTraffic(data.trafficSources);
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Facebook traffic (last 28 days)</span>
          <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
            {fmt(fb.sessions)} session{fb.sessions === 1 ? "" : "s"} · {fmt(fb.activeUsers)} user
            {fb.activeUsers === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="text-left px-6 py-2 font-medium">Source</th>
              <th className="text-left px-6 py-2 font-medium">Medium</th>
              <th className="text-right px-6 py-2 font-medium">Sessions</th>
              <th className="text-right px-6 py-2 font-medium">Users</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {fb.rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-6 text-muted-foreground">
                  No Facebook referrals in the last 28 days. Manual posts with
                  <code className="mx-1 px-1 bg-muted rounded text-xs">
                    ?utm_source=facebook&amp;utm_medium=social
                  </code>
                  on the link will start showing up here.
                </td>
              </tr>
            ) : (
              fb.rows.map((row, i) => (
                <tr key={`${row.source}-${row.medium}-${i}`}>
                  <td className="px-6 py-2 text-foreground">{row.source}</td>
                  <td className="px-6 py-2 text-foreground">{row.medium || "(none)"}</td>
                  <td className="px-6 py-2 text-right tabular-nums">{fmt(row.sessions)}</td>
                  <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
                    {fmt(row.activeUsers)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function AeoTotalBadge({ total }: { total: number }) {
  const color = aeoBadgeColor(total);
  const classes =
    color === "green"
      ? "bg-green-100 text-green-800"
      : color === "yellow"
        ? "bg-yellow-100 text-yellow-800"
        : "bg-red-100 text-red-800";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${classes}`}
    >
      {total} this week
    </span>
  );
}

function AeoDeltaCell({ current, previous }: { current: number; previous: number }) {
  const pct = aeoDeltaPercent(current, previous);
  if (pct === null) return <span className="text-muted-foreground">—</span>;
  const rounded = Math.round(pct);
  const sign = rounded > 0 ? "+" : "";
  const color =
    rounded > 0 ? "text-green-700" : rounded < 0 ? "text-red-700" : "text-muted-foreground";
  return (
    <span className={color}>
      {sign}
      {rounded}%
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-4xl font-bold text-foreground mt-1 tabular-nums">{value}</p>
          </div>
          <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-blue-100">
            <Users className="w-6 h-6 text-blue-600" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorPanel({ kind, message }: { kind: "config" | "api" | "unknown"; message: string }) {
  const isConfig = kind === "config";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-muted-foreground" />
          {isConfig ? "GA4 analytics not configured" : "Could not load GA4 data"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-foreground mb-4">{message}</p>

        {isConfig && (
          <div className="text-sm text-foreground space-y-3">
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
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
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
                    <span className="bg-muted px-1.5 py-0.5 rounded">GA4_PROPERTY_ID</span> —
                    numeric property ID
                  </li>
                  <li>
                    <span className="bg-muted px-1.5 py-0.5 rounded">GA4_SA_CLIENT_EMAIL</span> —{" "}
                    <code>client_email</code> from the JSON key
                  </li>
                  <li>
                    <span className="bg-muted px-1.5 py-0.5 rounded">GA4_SA_PRIVATE_KEY</span> — the
                    full <code>private_key</code> PEM (encrypt this one)
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
