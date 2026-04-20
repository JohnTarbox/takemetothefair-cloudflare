import Link from "next/link";
import { ExternalLink, RefreshCw, Users, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  Ga4ApiError,
  Ga4ConfigError,
  getDashboardMetrics,
  type DashboardMetrics,
  type Ga4Env,
} from "@/lib/ga4";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ refresh?: string }>;
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
  const { refresh } = await searchParams;
  const result = await load(refresh === "1");

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Analytics (GA4)</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/analytics?refresh=1"
            className="inline-flex items-center gap-1.5 text-sm text-gray-700 hover:text-gray-900"
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

      {!result.ok ? (
        <ErrorPanel kind={result.kind} message={result.message} />
      ) : (
        <MetricsView data={result.data} />
      )}
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
