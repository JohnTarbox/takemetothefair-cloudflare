import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  DollarSign,
  Search,
  TrendingUp,
} from "lucide-react";
import { desc, gte, sql } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { analyticsEvents, indexnowSubmissions } from "@/lib/db/schema";
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
import { formatDateOnly, formatTimestampForServer } from "@/lib/datetime";
import {
  isWindowKey,
  loadOverviewSnapshot,
  WINDOW_KEYS,
  type ActivityEntry,
  type OverviewSnapshot,
  type SparklinePoint,
  type Trend,
  type WindowKey,
} from "@/lib/analytics-overview";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "recommendations", label: "Recommendations" },
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
  searchParams: Promise<{ tab?: string; window?: string }>;
};

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

export default async function AdminAnalyticsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const tab: TabKey = isTabKey(params.tab) ? params.tab : "overview";
  const window: WindowKey = isWindowKey(params.window) ? params.window : "7d";

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        {tab === "overview" && (
          <div className="flex items-center gap-3">
            <WindowSelector currentWindow={window} />
            <Link
              href="/admin/analytics/ga4"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
            >
              GA4 dashboard <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}
      </div>

      <TabBar currentTab={tab} />

      {tab === "overview" && <OverviewTab window={window} />}
      {tab === "recommendations" && <RecommendationsTab />}
      {tab === "google" && <GoogleTab />}
      {tab === "bing" && <BingTab />}
      {tab === "site-health" && <SiteHealthTab />}
      {tab === "first-party-events" && <FirstPartyEventsTab />}
      {tab === "indexnow" && <IndexNowTab />}
    </div>
  );
}

// ─── Overview triage dashboard ──────────────────────────────────────

async function OverviewTab({ window }: { window: WindowKey }) {
  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as ScEnv & BingEnv;
  const snapshot = await loadOverviewSnapshot(db, env, window);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SearchVisibilityCard snapshot={snapshot} />
        <ConversionsCard snapshot={snapshot} />
        <CatalogGrowthCard snapshot={snapshot} />
        <RevenueCard snapshot={snapshot} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <SiteHealthCardView snapshot={snapshot} />
        <IndexNowCardView snapshot={snapshot} />
        <RecentErrorsCardView snapshot={snapshot} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <SparklineCard
          title="Conversions (last 30 days)"
          subtitle="Daily outbound ticket + application clicks"
          points={snapshot.conversionsSparkline}
          colorClass="stroke-blue-600"
          fillClass="fill-blue-100"
        />
        <SparklineCard
          title="Publishing activity (last 30 days)"
          subtitle="Successful IndexNow submissions per day"
          points={snapshot.publishingSparkline}
          colorClass="stroke-emerald-600"
          fillClass="fill-emerald-100"
        />
      </div>

      <ActivityFeedCard activity={snapshot.activity} />

      <p className="text-xs text-gray-500 mt-4">
        Window: {window} · Generated {formatTimestampForServer(snapshot.generatedAt)} · Page-level
        cache up to 10 min on each underlying source
      </p>
    </>
  );
}

function WindowSelector({ currentWindow }: { currentWindow: WindowKey }) {
  return (
    <div className="inline-flex items-center bg-gray-100 rounded-lg p-1 text-xs">
      {WINDOW_KEYS.map((w) => {
        const active = w === currentWindow;
        return (
          <Link
            key={w}
            href={`/admin/analytics?window=${w}`}
            className={`px-2.5 py-1 rounded-md font-medium ${
              active ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {w}
          </Link>
        );
      })}
    </div>
  );
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function TrendBadge({
  trend,
  current,
  previous,
}: {
  trend: Trend;
  current: number;
  previous: number;
}) {
  const pct = deltaPct(current, previous);
  const colorClass =
    trend === "up" ? "text-green-700" : trend === "down" ? "text-red-700" : "text-gray-500";
  const Icon = trend === "up" ? ArrowUp : trend === "down" ? ArrowDown : ArrowRight;
  const label = pct === null ? "vs prior" : `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs prior`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${colorClass}`}>
      <Icon className="w-3 h-3" /> {label}
    </span>
  );
}

function KpiCard({
  title,
  value,
  icon,
  iconColor,
  href,
  footer,
}: {
  title: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  iconColor: string;
  href?: string;
  footer?: React.ReactNode;
}) {
  const inner = (
    <Card className="h-full">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">{title}</p>
            <p className="text-3xl font-bold text-gray-900 mt-2 tabular-nums">{value}</p>
            {footer && <div className="mt-2">{footer}</div>}
          </div>
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center ${iconColor} shrink-0`}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
  if (href) {
    return (
      <Link href={href} className="block hover:opacity-90 transition-opacity">
        {inner}
      </Link>
    );
  }
  return inner;
}

function SearchVisibilityCard({ snapshot }: { snapshot: OverviewSnapshot }) {
  const card = snapshot.searchVisibility;
  if (!card.ok) {
    return (
      <KpiCard
        title="Search visibility"
        value="—"
        icon={<Search className="w-5 h-5 text-gray-500" />}
        iconColor="bg-gray-100"
        href="/admin/analytics?tab=google"
        footer={<span className="text-xs text-gray-500">{card.reason}</span>}
      />
    );
  }
  return (
    <KpiCard
      title={`Search clicks (last ${card.windowDays}d)`}
      value={fmt(card.current)}
      icon={<Search className="w-5 h-5 text-blue-600" />}
      iconColor="bg-blue-100"
      href="/admin/analytics?tab=google"
      footer={<TrendBadge trend={card.trend} current={card.current} previous={card.previous} />}
    />
  );
}

function ConversionsCard({ snapshot }: { snapshot: OverviewSnapshot }) {
  const card = snapshot.conversions;
  return (
    <KpiCard
      title={`Conversions (last ${card.windowDays}d)`}
      value={fmt(card.current)}
      icon={<TrendingUp className="w-5 h-5 text-emerald-600" />}
      iconColor="bg-emerald-100"
      href="/admin/analytics?tab=first-party-events"
      footer={<TrendBadge trend={card.trend} current={card.current} previous={card.previous} />}
    />
  );
}

function CatalogGrowthCard({ snapshot }: { snapshot: OverviewSnapshot }) {
  const card = snapshot.catalogGrowth;
  return (
    <KpiCard
      title={`Catalog growth (last ${card.windowDays}d)`}
      value={`+${fmt(card.newInWindow)}`}
      icon={<BarChart3 className="w-5 h-5 text-violet-600" />}
      iconColor="bg-violet-100"
      footer={
        <div className="flex flex-col gap-1">
          <TrendBadge
            trend={card.trend}
            current={card.newInWindow}
            previous={card.newInPriorWindow}
          />
          <span className="text-xs text-gray-500">
            {fmt(card.totals.events)} events · {fmt(card.totals.venues)} venues ·{" "}
            {fmt(card.totals.vendors)} vendors
          </span>
        </div>
      }
    />
  );
}

function RevenueCard({ snapshot }: { snapshot: OverviewSnapshot }) {
  const card = snapshot.enhancedProfileRevenue;
  return (
    <KpiCard
      title="Enhanced Profile (annualized)"
      value={fmtUsd(card.annualizedUsd)}
      icon={<DollarSign className="w-5 h-5 text-amber-600" />}
      iconColor="bg-amber-100"
      footer={
        <div className="flex flex-col gap-1">
          <TrendBadge
            trend={card.trend}
            current={card.newInWindow}
            previous={card.newInPriorWindow}
          />
          <span className="text-xs text-gray-500">
            {fmt(card.payingVendors)} paying · {fmt(card.newInWindow)} new in {card.windowDays}d
          </span>
        </div>
      }
    />
  );
}

function SiteHealthCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.siteHealth;
  const hasErrors = c.errors > 0;
  return (
    <Link href="/admin/analytics?tab=site-health" className="block hover:opacity-90">
      <Card
        className={`h-full ${hasErrors ? "border-red-300" : c.warnings > 0 ? "border-amber-300" : ""}`}
      >
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">
                Site health
              </p>
              <p className="text-3xl font-bold text-gray-900 mt-2 tabular-nums">{fmt(c.total)}</p>
              <div className="mt-2 text-xs flex gap-2">
                <span className={c.errors > 0 ? "text-red-700 font-semibold" : "text-gray-500"}>
                  {fmt(c.errors)} err
                </span>
                <span className={c.warnings > 0 ? "text-amber-700" : "text-gray-500"}>
                  {fmt(c.warnings)} warn
                </span>
                <span className="text-gray-500">{fmt(c.notices)} notice</span>
              </div>
            </div>
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                hasErrors ? "bg-red-100" : c.warnings > 0 ? "bg-amber-100" : "bg-gray-100"
              }`}
            >
              <AlertTriangle
                className={`w-5 h-5 ${
                  hasErrors ? "text-red-600" : c.warnings > 0 ? "text-amber-600" : "text-gray-500"
                }`}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function IndexNowCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.indexnow;
  const hasFailures = c.todayFailures > 0;
  const successPct = Math.round(c.todaySuccessRate * 100);
  return (
    <Link href="/admin/analytics?tab=indexnow" className="block hover:opacity-90">
      <Card className={`h-full ${hasFailures ? "border-red-300" : ""}`}>
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">
                IndexNow today
              </p>
              <p className="text-3xl font-bold text-gray-900 mt-2 tabular-nums">
                {fmt(c.todaySubmissions)}
              </p>
              <div className="mt-2 text-xs">
                <span className={hasFailures ? "text-red-700 font-semibold" : "text-gray-500"}>
                  {successPct}% success
                </span>
                {c.quota && (
                  <span className="text-gray-500 ml-2">
                    · {fmt(c.quota.dailyRemaining)} BWT quota
                  </span>
                )}
                {c.quotaError && (
                  <span className="text-gray-400 ml-2 italic">· quota unavailable</span>
                )}
              </div>
            </div>
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                hasFailures ? "bg-red-100" : "bg-emerald-100"
              }`}
            >
              <CheckCircle2
                className={`w-5 h-5 ${hasFailures ? "text-red-600" : "text-emerald-600"}`}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function RecentErrorsCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.recentErrors;
  const high = c.last24hCount > 10;
  return (
    <Card className={`h-full ${high ? "border-red-300" : ""}`}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">
              Errors (last 24h)
            </p>
            <p className="text-3xl font-bold text-gray-900 mt-2 tabular-nums">
              {fmt(c.last24hCount)}
            </p>
            <div className="mt-2 text-xs text-gray-500 truncate">
              {c.topSources.length === 0
                ? "No errors logged."
                : c.topSources.map((s) => `${s.source} (${fmt(s.count)})`).join(" · ")}
            </div>
          </div>
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              high ? "bg-red-100" : "bg-gray-100"
            }`}
          >
            <AlertTriangle className={`w-5 h-5 ${high ? "text-red-600" : "text-gray-500"}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SparklineCard({
  title,
  subtitle,
  points,
  colorClass,
  fillClass,
}: {
  title: string;
  subtitle: string;
  points: SparklinePoint[];
  colorClass: string;
  fillClass: string;
}) {
  const total = points.reduce((acc, p) => acc + p.value, 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-gray-500">{subtitle}</p>
      </CardHeader>
      <CardContent>
        <div className="flex items-end justify-between mb-2">
          <p className="text-2xl font-bold text-gray-900 tabular-nums">{fmt(total)}</p>
          <p className="text-xs text-gray-500">{points.length}-day total</p>
        </div>
        <Sparkline points={points} colorClass={colorClass} fillClass={fillClass} />
      </CardContent>
    </Card>
  );
}

function Sparkline({
  points,
  colorClass,
  fillClass,
}: {
  points: SparklinePoint[];
  colorClass: string;
  fillClass: string;
}) {
  const width = 600;
  const height = 80;
  const padding = 4;
  const max = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padding + i * stepX;
    const y = padding + (height - padding * 2) * (1 - p.value / max);
    return { x, y, value: p.value, date: p.date };
  });

  if (coords.length === 0) {
    return <div className="text-xs text-gray-400 italic">No data yet.</div>;
  }

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${height - padding} L ${coords[0].x} ${
    height - padding
  } Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-20"
      aria-label="30-day sparkline"
    >
      <path d={areaPath} className={fillClass} opacity={0.4} />
      <path d={linePath} className={`${colorClass} fill-none`} strokeWidth={2} />
    </svg>
  );
}

function ActivityFeedCard({ activity }: { activity: ActivityEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-4 h-4 text-gray-500" /> Recent activity
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {activity.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-500">No recent activity in this window.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {activity.map((entry, i) => (
              <li key={i} className="px-6 py-3 flex items-start gap-3">
                <ActivityIcon kind={entry.kind} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 break-words">
                    {entry.href ? (
                      <a
                        href={entry.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {entry.description}
                      </a>
                    ) : (
                      entry.description
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {formatTimestampForServer(new Date(entry.ts))}
                    {entry.actor && <span className="ml-2">· actor {entry.actor}</span>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityIcon({ kind }: { kind: ActivityEntry["kind"] }) {
  const map: Record<ActivityEntry["kind"], { Icon: typeof Activity; color: string; bg: string }> = {
    admin: { Icon: BarChart3, color: "text-violet-600", bg: "bg-violet-100" },
    indexnow: { Icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-100" },
    conversion: { Icon: TrendingUp, color: "text-blue-600", bg: "bg-blue-100" },
  };
  const { Icon, color, bg } = map[kind];
  return (
    <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${bg}`}>
      <Icon className={`w-3.5 h-3.5 ${color}`} />
    </span>
  );
}

// ─── Recommendations tab ────────────────────────────────────────────

async function RecommendationsTab() {
  const { getActiveItems } = await import("@/lib/recommendations/engine");
  const { RecommendationActions } = await import("@/components/admin/recommendation-actions");
  const { RecommendationScanButton } =
    await import("@/components/admin/recommendation-scan-button");

  const db = getCloudflareDb();
  const items = await getActiveItems(db);

  type Sev = "red" | "yellow" | "blue";
  type Item = (typeof items)[number];

  // Group by rule first (one card per rule); keep the rule's own severity for
  // bucketing into red / yellow / blue sections.
  type RuleGroup = {
    ruleId: string;
    ruleKey: string;
    title: string;
    rationaleTemplate: string;
    severity: Sev;
    items: Item[];
  };
  const ruleGroups = new Map<string, RuleGroup>();
  for (const it of items) {
    let g = ruleGroups.get(it.ruleId);
    if (!g) {
      g = {
        ruleId: it.ruleId,
        ruleKey: it.ruleKey,
        title: it.title,
        rationaleTemplate: it.rationaleTemplate,
        severity: it.severity as Sev,
        items: [],
      };
      ruleGroups.set(it.ruleId, g);
    }
    g.items.push(it);
  }

  const bySeverity: Record<Sev, RuleGroup[]> = { red: [], yellow: [], blue: [] };
  for (const g of ruleGroups.values()) bySeverity[g.severity].push(g);
  // Within each severity bucket, larger rules surface first.
  for (const sev of ["red", "yellow", "blue"] as Sev[]) {
    bySeverity[sev].sort((a, b) => b.items.length - a.items.length);
  }

  const severityMeta: Record<
    Sev,
    { label: string; cardBorder: string; badge: string; chip: string }
  > = {
    red: {
      label: "Action required",
      cardBorder: "border-red-300",
      badge: "bg-red-100 text-red-800 border-red-200",
      chip: "bg-red-50 text-red-800 border-red-200",
    },
    yellow: {
      label: "High-impact opportunities",
      cardBorder: "border-amber-300",
      badge: "bg-amber-100 text-amber-800 border-amber-200",
      chip: "bg-amber-50 text-amber-800 border-amber-200",
    },
    blue: {
      label: "Nice to have",
      cardBorder: "border-blue-300",
      badge: "bg-blue-100 text-blue-800 border-blue-200",
      chip: "bg-blue-50 text-blue-800 border-blue-200",
    },
  };

  function rationaleFor(group: RuleGroup): string {
    return group.rationaleTemplate.replace(/\{n\}/g, String(group.items.length));
  }

  function targetLink(item: Item): string | null {
    if (item.targetType === "vendor" && item.payload && typeof item.payload.slug === "string") {
      return `/admin/vendors/${item.payload.slug}`;
    }
    if (item.targetType === "event" && item.payload && typeof item.payload.slug === "string") {
      return `/events/${item.payload.slug}`;
    }
    if (item.targetType === "venue" && item.payload && typeof item.payload.slug === "string") {
      return `/venues/${item.payload.slug}`;
    }
    return null;
  }

  function targetLabel(item: Item): string {
    if (item.payload && typeof item.payload.businessName === "string") {
      return item.payload.businessName;
    }
    if (item.payload && typeof item.payload.name === "string") {
      return item.payload.name;
    }
    if (item.payload && typeof item.payload.query === "string") {
      return item.payload.query;
    }
    return item.targetId ?? "(global)";
  }

  function targetMeta(item: Item): string | null {
    // Compact second-line metadata per target type.
    const p = item.payload ?? {};
    const descLen = typeof p.descriptionLength === "number" ? `${p.descriptionLength} chars` : null;
    if (item.targetType === "vendor") {
      const loc = typeof p.location === "string" ? p.location : null;
      const exp = typeof p.daysUntil === "number" ? `${p.daysUntil}d to expiry` : null;
      return [loc, exp, descLen].filter(Boolean).join(" · ") || null;
    }
    if (item.targetType === "event") {
      const views = typeof p.views30d === "number" ? `${p.views30d} views/30d` : null;
      return [views, descLen].filter(Boolean).join(" · ") || null;
    }
    if (item.targetType === "venue") {
      return descLen;
    }
    if (item.targetType === "gsc_query") {
      const pos = typeof p.position === "number" ? `pos ${p.position}` : null;
      const impr = typeof p.impressions === "number" ? `${p.impressions} impr` : null;
      return [pos, impr].filter(Boolean).join(" · ") || null;
    }
    return null;
  }

  const totalRules = ruleGroups.size;

  return (
    <>
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-gray-600">
          {items.length === 0
            ? "No active recommendations. Run a scan to surface new ones."
            : `${items.length} active item${items.length === 1 ? "" : "s"} across ${totalRules} rule${
                totalRules === 1 ? "" : "s"
              }. Click any rule to expand affected targets.`}
        </p>
        <RecommendationScanButton />
      </div>

      {(["red", "yellow", "blue"] as Sev[]).map((sev) => {
        const groups = bySeverity[sev];
        if (groups.length === 0) return null;
        const meta = severityMeta[sev];
        return (
          <div key={sev} className="mb-8">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-3 flex items-center gap-2">
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${meta.badge}`}
              >
                {meta.label}
              </span>
              <span className="text-gray-500 font-normal">{groups.length}</span>
            </h2>
            <div className="space-y-3">
              {groups.map((group) => {
                const count = group.items.length;
                // Auto-expand single-item rules; keep multi-item rules collapsed by default.
                const defaultOpen = count === 1;
                return (
                  <Card key={group.ruleId} className={meta.cardBorder}>
                    <details open={defaultOpen} className="group">
                      <summary className="cursor-pointer p-5 list-none [&::-webkit-details-marker]:hidden">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-gray-400 group-open:rotate-90 transition-transform inline-block">
                                ▶
                              </span>
                              <p className="text-sm font-semibold text-gray-900">{group.title}</p>
                              <span
                                className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${meta.chip}`}
                              >
                                {count} affected
                              </span>
                            </div>
                            <p className="text-sm text-gray-700 mt-1.5 ml-6">
                              {rationaleFor(group)}
                            </p>
                            <p className="text-xs text-gray-400 mt-1 ml-6">rule {group.ruleKey}</p>
                          </div>
                        </div>
                      </summary>
                      <div className="border-t border-gray-100 divide-y divide-gray-100">
                        {group.items.map((item) => {
                          const link = targetLink(item);
                          const meta2 = targetMeta(item);
                          return (
                            <div
                              key={item.itemId}
                              className="px-5 py-3 flex items-start justify-between gap-4 flex-wrap hover:bg-gray-50"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-gray-900">
                                  {link ? (
                                    <Link href={link} className="text-blue-600 hover:underline">
                                      {targetLabel(item)}
                                    </Link>
                                  ) : (
                                    <span className="font-mono">{targetLabel(item)}</span>
                                  )}
                                </p>
                                {meta2 && <p className="text-xs text-gray-500 mt-0.5">{meta2}</p>}
                              </div>
                              <RecommendationActions itemId={item.itemId} />
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  </Card>
                );
              })}
            </div>
          </div>
        );
      })}

      <p className="text-xs text-gray-500 mt-6">
        Active items refresh on scan or when an item&apos;s match expires the 7-day window.
        Per-target Snooze hides an item temporarily; Mark done resolves it permanently. All actions
        are logged to <code>admin_actions</code>.
      </p>
    </>
  );
}

// ─── Existing tabs (unchanged below this line) ──────────────────────

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
                return (
                  <tr key={row.id} className="align-top">
                    <td className="px-6 py-2 whitespace-nowrap text-gray-700 tabular-nums">
                      {formatTimestampForServer(new Date(row.timestamp * 1000))}
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
                      ) : urlsArr.length === 0 ? (
                        "—"
                      ) : urlsArr.length === 1 ? (
                        <a
                          href={urlsArr[0]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-blue-700 hover:underline"
                        >
                          {urlsArr[0]}
                        </a>
                      ) : (
                        <details className="cursor-pointer">
                          <summary className="select-none">
                            <span className="font-mono">{urlsArr[0]}</span>
                            <span className="text-gray-500">
                              {" "}
                              +{urlsArr.length - 1} more (click to expand)
                            </span>
                          </summary>
                          <ul className="mt-2 space-y-1 pl-4 border-l-2 border-gray-200">
                            {urlsArr.map((url, i) => (
                              <li key={i} className="font-mono break-all">
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-700 hover:underline"
                                >
                                  {url}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </details>
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
                      {formatTimestampForServer(new Date(row.timestamp * 1000))}
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
                        {row.lastSubmitted ? formatDateOnly(row.lastSubmitted) || "—" : "—"}
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
            <p className="text-sm text-gray-600">Bing direct submit quota</p>
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
            <p className="text-xs text-gray-400 mt-2">
              Bing Webmaster Tools URL submission API. Separate from indexnow.org pings — see the
              IndexNow tab for our submission log.
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
  const { getUnclassifiedOutboundDestinations } =
    await import("@/lib/url-classification-discovery");
  const { ClassifyDomainButtons } = await import("@/components/admin/classify-domain-buttons");
  const [issues, unclassifiedDestinations] = await Promise.all([
    getCurrentIssues(db, { hideSnoozed: false }),
    getUnclassifiedOutboundDestinations(db, { days: 7, minClicks: 5 }),
  ]);
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
                        {formatDateOnly(new Date(row.lastDetectedAt * 1000))}
                      </td>
                      <td className="px-6 py-2 text-gray-700">
                        {snoozed && row.snoozedUntil
                          ? `until ${formatDateOnly(new Date(row.snoozedUntil * 1000))}`
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

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Unclassified outbound destinations</CardTitle>
          <p className="text-sm text-gray-600 mt-1">
            Domains that received outbound ticket clicks in the last 7 days but aren&apos;t in{" "}
            <code>url_domain_classifications</code> yet. Classify each one so the ingestion gate
            (see <code>src/lib/url-classification.ts</code>) knows whether it&apos;s a legitimate
            ticket destination, a promoter, an aggregator to block, etc.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Domain</th>
                <th className="text-right px-6 py-2 font-medium">7d clicks</th>
                <th className="text-left px-6 py-2 font-medium">Sample event</th>
                <th className="text-left px-6 py-2 font-medium">Classify as</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {unclassifiedDestinations.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-6 text-gray-500">
                    No unclassified destinations with 5+ clicks in the last 7 days. The gate is
                    holding.
                  </td>
                </tr>
              ) : (
                unclassifiedDestinations.map((row) => (
                  <tr key={row.domain} className="align-top">
                    <td className="px-6 py-3 font-mono text-xs text-gray-900 break-all">
                      {row.domain}
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums font-medium">
                      {fmt(row.clicks)}
                    </td>
                    <td className="px-6 py-3 text-gray-700 break-all max-w-xs">
                      {row.sampleEventSlug ? (
                        <Link
                          href={`/events/${row.sampleEventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline font-mono text-xs"
                        >
                          {row.sampleEventSlug}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <ClassifyDomainButtons domain={row.domain} />
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
