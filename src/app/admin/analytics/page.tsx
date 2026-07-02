import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  DollarSign,
  Facebook,
  FileText,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { desc, eq, gte, sql } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IndexNowKillSwitchToggle } from "@/components/admin/indexnow-kill-switch-toggle";
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
  type ActionQueueEntry,
  type ActivityEntry,
  type OverviewSnapshot,
  type SparklinePoint,
  type Trend,
  type WindowKey,
} from "@/lib/analytics-overview";
import { KPI_THRESHOLDS, formatStaleAge, type KpiName, type KpiState } from "@/lib/kpi-thresholds";
import { isExpectedNonIndexing } from "@/lib/site-health-classify";
import {
  AEO_BUCKET_LABELS,
  aeoBadgeColor,
  Ga4ApiError,
  Ga4ConfigError,
  getAeoReferrals,
  getFacebookTrafficSafe,
  type AeoReferralsResult,
  type FacebookTrafficSummary,
  type Ga4Env,
} from "@/lib/ga4";

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
  searchParams: Promise<{
    tab?: string;
    window?: string;
    // IndexNow tab filters — only consumed by IndexNowTab. Other tabs ignore.
    indexnow_limit?: string;
    indexnow_source?: string;
  }>;
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
        <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
        {tab === "overview" && (
          <div className="flex items-center gap-3">
            <WindowSelector currentWindow={window} />
            <Link
              href="/admin/diagnostics"
              className="inline-flex items-center gap-1.5 text-sm text-royal hover:text-navy"
            >
              Diagnostics <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <Link
              href="/admin/analytics/ga4"
              className="inline-flex items-center gap-1.5 text-sm text-royal hover:text-navy"
            >
              GA4 dashboard <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <Link
              href="/admin/analytics/automation"
              className="inline-flex items-center gap-1.5 text-sm text-royal hover:text-navy"
            >
              Automation candidates <ArrowRight className="w-3.5 h-3.5" />
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
      {tab === "indexnow" && (
        <IndexNowTab limit={params.indexnow_limit} source={params.indexnow_source} />
      )}
    </div>
  );
}

// ─── Overview triage dashboard ──────────────────────────────────────

async function loadAeoReferralsSafe(env: Ga4Env): Promise<AeoReferralsResult | null> {
  // AEO data is informational; surface as a soft empty state rather than
  // breaking the whole overview if GA4 is misconfigured or rate-limited.
  try {
    return await getAeoReferrals(env);
  } catch (e) {
    if (e instanceof Ga4ConfigError || e instanceof Ga4ApiError) return null;
    return null;
  }
}

async function OverviewTab({ window }: { window: WindowKey }) {
  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as ScEnv & BingEnv & Ga4Env;
  const [snapshot, aeo, fb] = await Promise.all([
    loadOverviewSnapshot(db, env, window),
    loadAeoReferralsSafe(env),
    getFacebookTrafficSafe(env),
  ]);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SearchVisibilityCard snapshot={snapshot} />
        <ConversionsCard snapshot={snapshot} />
        <CatalogGrowthCard snapshot={snapshot} />
        <RevenueCard snapshot={snapshot} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <RecommendationsSummaryCardView snapshot={snapshot} />
        <SiteHealthCardView snapshot={snapshot} />
        <IndexNowCardView snapshot={snapshot} />
        <RecentErrorsCardView snapshot={snapshot} />
      </div>

      {/* §10.3 KPI quartet — site CTR, conversion rate, brand split, sitemap quality.
          State coloring (GREEN/YELLOW/RED) added in §6.3 — see kpiCardState helper. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SiteCtrCardView snapshot={snapshot} />
        <ConversionRateCardView snapshot={snapshot} />
        <BrandVsNonBrandCardView snapshot={snapshot} />
        <SitemapQualityCardView snapshot={snapshot} />
      </div>

      {/* §6.3: account engagement (renamed from old multi-numerator
          "conversion rate") — preserved as Enhanced-Profile funnel signal.
          AEO referrals card sits alongside as the leading-indicator for
          AI-engine citation pickup. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <AccountEngagementCardView snapshot={snapshot} />
        <AeoReferralsCardView aeo={aeo} />
        <FacebookReferralsCardView summary={fb} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <TimeToIndexCardView snapshot={snapshot} />
        <ActionQueueCardView snapshot={snapshot} />
      </div>

      <div className="mb-6">
        <RecentActivityCardView snapshot={snapshot} />
      </div>

      <BlogCoverageCardView snapshot={snapshot} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <SparklineCard
          title="Search visibility (last 30 days)"
          subtitle="Daily Google search clicks · source: GSC"
          points={snapshot.searchVisibilitySparkline}
          colorClass="stroke-violet-600"
          fillClass="fill-violet-100"
        />
        <SparklineCard
          title="Conversions (last 30 days)"
          subtitle="Daily outbound ticket + application clicks · source: D1 analytics_events"
          points={snapshot.conversionsSparkline}
          colorClass="stroke-blue-600"
          fillClass="fill-blue-100"
        />
        <SparklineCard
          title="Publishing activity (last 30 days)"
          subtitle="Successful IndexNow submissions per day · source: D1 indexnow_submissions"
          points={snapshot.publishingSparkline}
          colorClass="stroke-emerald-600"
          fillClass="fill-emerald-100"
        />
      </div>

      {/* §10.3 90-day KPI strip. If 30d total equals 90d total, the older
          60 days of the source table are empty (data is younger than 90d),
          not a window-handling bug — query is parameterized on days=90. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <SparklineCard
          title="Search visibility (last 90 days)"
          subtitle="Daily Google search clicks · source: GSC"
          points={snapshot.kpiStrip90d.searchVisibility}
          colorClass="stroke-violet-600"
          fillClass="fill-violet-100"
        />
        <SparklineCard
          title="Conversions (last 90 days)"
          subtitle="Daily outbound ticket + application clicks · source: D1 analytics_events"
          points={snapshot.kpiStrip90d.conversions}
          colorClass="stroke-blue-600"
          fillClass="fill-blue-100"
        />
        <SparklineCard
          title="Publishing activity (last 90 days)"
          subtitle="Successful IndexNow submissions per day · source: D1 indexnow_submissions"
          points={snapshot.kpiStrip90d.publishing}
          colorClass="stroke-emerald-600"
          fillClass="fill-emerald-100"
        />
      </div>

      {/* Analyst cross-cutting fix (2026-05-29): split activity feed into
          two cards. Two audiences, two decision types:
          - User-side: conversion events (outbound_ticket_click,
            outbound_application_click) tell us "is the catalog actually
            driving clicks?" — relevant to content + outreach decisions.
          - Operator-side: admin actions + IndexNow pings show what the
            ops team is doing or what auto-pipelines are firing —
            relevant to triage + workflow decisions.
          Mixing them masked low-volume signals on either side. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ActivityFeedCard
          title="User activity"
          subtitle="Visitor clicks on ticket / application URLs"
          activity={snapshot.activity.filter((a) => a.kind === "conversion")}
        />
        <ActivityFeedCard
          title="Operator activity"
          subtitle="Admin actions + high-priority IndexNow"
          activity={snapshot.activity.filter((a) => a.kind === "admin" || a.kind === "indexnow")}
        />
      </div>

      <KpiStatusLegend />

      <p className="text-xs text-muted-foreground mt-4">
        Window: {window} · Generated {formatTimestampForServer(snapshot.generatedAt)} · Page-level
        cache up to 10 min on each underlying source
      </p>
    </>
  );
}

function KpiStatusLegend() {
  // Legend for the badge glyphs used on KPI cards (KPI_STATE_STYLES).
  // Surfaces meanings of ◯ / ⚠ / ⛔ / 🕒 so the dashboard isn't a puzzle
  // for first-time viewers.
  return (
    <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">KPI status:</span>
      <span aria-label="On target">◯ on target</span>
      <span aria-label="Below target">⚠ below target</span>
      <span aria-label="Action required">⛔ action required</span>
      <span aria-label="Data feed stale">🕒 data feed stale</span>
    </div>
  );
}

function WindowSelector({ currentWindow }: { currentWindow: WindowKey }) {
  return (
    <div className="inline-flex items-center bg-muted rounded-lg p-1 text-xs">
      {WINDOW_KEYS.map((w) => {
        const active = w === currentWindow;
        return (
          <Link
            key={w}
            href={`/admin/analytics?window=${w}`}
            className={`px-2.5 py-1 rounded-md font-medium ${
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
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
    trend === "up" ? "text-green-700" : trend === "down" ? "text-red-700" : "text-muted-foreground";
  const Icon = trend === "up" ? ArrowUp : trend === "down" ? ArrowDown : ArrowRight;
  const label = pct === null ? "vs prior" : `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs prior`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${colorClass}`}>
      <Icon className="w-3 h-3" /> {label}
    </span>
  );
}

// §6.3 KPI state → border / badge / aria-label mapping. INDETERMINATE
// produces no border or badge so the card looks visually identical to the
// pre-§6.3 version (graceful degradation when data isn't flowing).
const KPI_STATE_STYLES: Record<
  KpiState,
  { border: string; badge: string | null; ariaLabel: string }
> = {
  GREEN: { border: "border-l-4 border-l-emerald-500", badge: "◯", ariaLabel: "On target" },
  YELLOW: { border: "border-l-4 border-l-amber-400", badge: "⚠", ariaLabel: "Below target" },
  RED: { border: "border-l-4 border-l-red-500", badge: "⛔", ariaLabel: "Action required" },
  // STALE = data feed is broken (older than the per-KPI SLA). Distinct from
  // RED (a real value below threshold) — STALE means the value can't be
  // trusted at all. Orange chosen so it reads as urgent without colliding
  // with RED's "value-too-low" semantics.
  STALE: { border: "border-l-4 border-l-orange-500", badge: "🕒", ariaLabel: "Data feed stale" },
  INDETERMINATE: { border: "", badge: null, ariaLabel: "No data yet" },
};

function KpiCard({
  title,
  value,
  icon,
  iconColor,
  href,
  footer,
  state,
  actionPrompt,
}: {
  title: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  iconColor: string;
  href?: string;
  footer?: React.ReactNode;
  state?: KpiState;
  /** Surfaced under the value when state === RED. Effort string from kpi-thresholds. */
  actionPrompt?: string;
}) {
  const stateStyle = state ? KPI_STATE_STYLES[state] : null;
  const cardClass = `h-full ${stateStyle?.border ?? ""}`.trim();
  const inner = (
    <Card className={cardClass}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              {title}
            </p>
            <p className="text-3xl font-bold text-foreground mt-2 tabular-nums">{value}</p>
            {(state === "RED" || state === "STALE") && actionPrompt && (
              <p
                className={`text-xs mt-1 font-medium ${state === "STALE" ? "text-orange-600" : "text-red-600"}`}
              >
                {actionPrompt}
              </p>
            )}
            {footer && <div className="mt-2">{footer}</div>}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {stateStyle?.badge && (
              <span
                aria-label={stateStyle.ariaLabel}
                className="text-base leading-none"
                title={stateStyle.ariaLabel}
              >
                {stateStyle.badge}
              </span>
            )}
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${iconColor}`}>
              {icon}
            </div>
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
        title="Google clicks"
        value="—"
        icon={<Search className="w-5 h-5 text-muted-foreground" />}
        iconColor="bg-muted"
        href="/admin/analytics?tab=google"
        footer={<span className="text-xs text-muted-foreground">{card.reason}</span>}
      />
    );
  }
  // Two-line footer: trend (windowed, GSC) + Bing total (rolling, no window).
  // Bing's API doesn't expose day-windowed click counts, so we don't combine
  // them — surfacing both honestly avoids the "-100%" reading the analyst
  // flagged when Bing was delivering clicks fine but only Google was shown.
  const footer = (
    <div className="flex flex-col gap-0.5">
      <TrendBadge trend={card.trend} current={card.current} previous={card.previous} />
      {card.bingTotal !== null && (
        <span className="text-xs text-muted-foreground">
          + {fmt(card.bingTotal)} from Bing (rolling)
        </span>
      )}
    </div>
  );
  return (
    <KpiCard
      title={`Google clicks (last ${card.windowDays}d)`}
      value={fmt(card.current)}
      icon={<Search className="w-5 h-5 text-royal" />}
      iconColor="bg-info-soft"
      href="/admin/analytics?tab=google"
      footer={footer}
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
          <span className="text-xs text-muted-foreground">
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
          <span className="text-xs text-muted-foreground">
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
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Site health
              </p>
              <p className="text-3xl font-bold text-foreground mt-2 tabular-nums">{fmt(c.total)}</p>
              <div className="mt-2 text-xs flex gap-2">
                <span
                  className={c.errors > 0 ? "text-red-700 font-semibold" : "text-muted-foreground"}
                >
                  {fmt(c.errors)} err
                </span>
                <span className={c.warnings > 0 ? "text-amber-700" : "text-muted-foreground"}>
                  {fmt(c.warnings)} warn
                </span>
                <span className="text-muted-foreground">{fmt(c.notices)} notice</span>
              </div>
            </div>
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                hasErrors ? "bg-red-100" : c.warnings > 0 ? "bg-amber-100" : "bg-muted"
              }`}
            >
              <AlertTriangle
                className={`w-5 h-5 ${
                  hasErrors
                    ? "text-red-600"
                    : c.warnings > 0
                      ? "text-amber-600"
                      : "text-muted-foreground"
                }`}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// §10.3 cards ─────────────────────────────────────────────────

function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtSeconds(s: number | null): string {
  if (s === null || !isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// §6.3 helper: read the latest state + action prompt for a KPI.
// RED → "fix the value" prompt. STALE → "fix the data feed" prompt.
// Returns INDETERMINATE when the recompute hasn't fired yet (cold-start).
function kpiCardState(
  snapshot: OverviewSnapshot,
  name: KpiName
): { state: KpiState; actionPrompt?: string } {
  const row = snapshot.kpiStates.get(name);
  const state: KpiState = row?.state ?? "INDETERMINATE";
  if (state === "RED") {
    const cfg = KPI_THRESHOLDS[name];
    return { state, actionPrompt: `${cfg.actionDescription} — ${cfg.effort}` };
  }
  if (state === "STALE") {
    const meta = row?.meta as { dataAgeSeconds?: number } | null;
    const ageSec = meta?.dataAgeSeconds;
    const ageLabel = typeof ageSec === "number" ? formatStaleAge(ageSec) : "unknown duration";
    return { state, actionPrompt: `Data feed stale ${ageLabel} — investigate source` };
  }
  return { state };
}

function SiteCtrCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.siteCtr;
  const { state, actionPrompt } = kpiCardState(snapshot, "site_ctr");
  if (!c.ok) {
    return (
      <KpiCard
        title="Site CTR"
        value="—"
        icon={<Search className="w-5 h-5 text-muted-foreground" />}
        iconColor="bg-muted"
        href="/admin/analytics?tab=google"
        footer={<span className="text-xs text-muted-foreground">{c.reason}</span>}
      />
    );
  }
  const trend = c.trend;
  const TrendIcon = trend === "up" ? ArrowUp : trend === "down" ? ArrowDown : ArrowRight;
  const trendColor =
    trend === "up"
      ? "text-emerald-600"
      : trend === "down"
        ? "text-red-600"
        : "text-muted-foreground";
  return (
    <KpiCard
      title="Site CTR (Google, last window)"
      value={fmtPct(c.ctr, 2)}
      icon={<Search className="w-5 h-5 text-violet-600" />}
      iconColor="bg-violet-100"
      href="/admin/analytics?tab=google"
      state={state}
      actionPrompt={actionPrompt}
      footer={
        <div className="flex flex-col gap-0.5">
          <span className={`inline-flex items-center gap-1 text-xs font-medium ${trendColor}`}>
            <TrendIcon className="w-3 h-3" /> prev {fmtPct(c.previousCtr, 2)}
          </span>
          <span className="text-xs text-muted-foreground">
            {fmt(c.clicks)} clicks / {fmt(c.impressions)} impr
          </span>
        </div>
      }
    />
  );
}

function ConversionRateCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.conversionRate;
  const { state, actionPrompt } = kpiCardState(snapshot, "conversion_rate");
  return (
    <KpiCard
      title={`Conversion rate (${c.windowDays}d)`}
      value={c.rate != null ? fmtPct(c.rate, 2) : "—"}
      icon={<TrendingUp className="w-5 h-5 text-emerald-600" />}
      iconColor="bg-emerald-100"
      state={state}
      actionPrompt={actionPrompt}
      footer={
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>
            {fmt(c.conversions)} ticket clicks / {c.sessions != null ? fmt(c.sessions) : "—"}{" "}
            organic sessions
          </span>
          <span title={`Window ends ${c.windowEndDate} (48h GA4 finalization lag)`}>
            window ends {c.windowEndDate}
          </span>
        </div>
      }
    />
  );
}

function AccountEngagementCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.accountEngagement;
  return (
    <KpiCard
      title={`Account engagement (${c.windowDays}d)`}
      value={fmtPct(c.rate, 2)}
      icon={<Activity className="w-5 h-5 text-emerald-600" />}
      iconColor="bg-emerald-100"
      footer={
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>
            {fmt(c.signals)} signals / {fmt(c.sessions)} events
          </span>
          <span>
            claims {fmt(c.breakdown.vendor_claims)} · favs {fmt(c.breakdown.event_favorites)} ·
            contacts {fmt(c.breakdown.contact_clicks)}
          </span>
        </div>
      }
    />
  );
}

// AEO threshold (≥10/wk green, 5–9 yellow, <5 red) maps onto the KpiCard
// state styling so the card matches the §6.3 KPI strip visually. The state
// values here are display-only — AEO referrals aren't part of the §6.3 KPI
// state machine in `kpi-thresholds.ts`.
function aeoStateFromTotal(total: number): KpiState {
  const color = aeoBadgeColor(total);
  if (color === "green") return "GREEN";
  if (color === "yellow") return "YELLOW";
  return "RED";
}

function AeoReferralsCardView({ aeo }: { aeo: AeoReferralsResult | null }) {
  if (!aeo) {
    return (
      <KpiCard
        title="AEO referrals (last 7d)"
        value="—"
        icon={<Sparkles className="w-5 h-5 text-muted-foreground" />}
        iconColor="bg-muted"
        href="/admin/analytics/ga4"
        footer={<span className="text-xs text-muted-foreground">GA4 unavailable</span>}
      />
    );
  }
  return (
    <KpiCard
      title="AEO referrals (last 7d)"
      value={fmt(aeo.total)}
      icon={<Sparkles className="w-5 h-5 text-purple-600" />}
      iconColor="bg-purple-100"
      href="/admin/analytics/ga4"
      state={aeoStateFromTotal(aeo.total)}
      footer={
        <span className="text-xs text-muted-foreground">
          {AEO_BUCKET_LABELS.chatgpt} · {AEO_BUCKET_LABELS.perplexity} · {AEO_BUCKET_LABELS.copilot}{" "}
          · {AEO_BUCKET_LABELS.claude} · {AEO_BUCKET_LABELS.gemini}
        </span>
      }
    />
  );
}

// Facebook traffic KPI tile. No state coloring — FB volume is highly
// posting-dependent and "0 sessions" likely means "we haven't posted",
// not "something is broken" — so a RED dot would mislead. Clicks through
// to the detailed FB tile on /admin/analytics/ga4. 28d window matches
// that detail view so the number doesn't change when you click through.
function FacebookReferralsCardView({ summary }: { summary: FacebookTrafficSummary | null }) {
  if (!summary) {
    return (
      <KpiCard
        title="Facebook traffic (last 28d)"
        value="—"
        icon={<Facebook className="w-5 h-5 text-muted-foreground" />}
        iconColor="bg-muted"
        href="/admin/analytics/ga4"
        footer={<span className="text-xs text-muted-foreground">GA4 unavailable</span>}
      />
    );
  }
  return (
    <KpiCard
      title="Facebook traffic (last 28d)"
      value={fmt(summary.sessions)}
      icon={<Facebook className="w-5 h-5 text-royal" />}
      iconColor="bg-info-soft"
      href="/admin/analytics/ga4"
      footer={
        <span className="text-xs text-muted-foreground">
          {summary.sessions === 1 ? "1 session" : `${fmt(summary.sessions)} sessions`} ·{" "}
          {summary.activeUsers === 1 ? "1 user" : `${fmt(summary.activeUsers)} users`}
        </span>
      }
    />
  );
}

function BrandVsNonBrandCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.brandVsNonBrand;
  const { state, actionPrompt } = kpiCardState(snapshot, "brand_share");
  if (!c.ok) {
    return (
      <KpiCard
        title="Brand share"
        value="—"
        icon={<Search className="w-5 h-5 text-muted-foreground" />}
        iconColor="bg-muted"
        href="/admin/analytics?tab=google"
        footer={<span className="text-xs text-muted-foreground">{c.reason}</span>}
      />
    );
  }
  return (
    <KpiCard
      title={`Brand vs non-brand (last ${c.windowDays}d, Google)`}
      value={fmtPct(c.brand_share, 0)}
      icon={<TrendingUp className="w-5 h-5 text-royal" />}
      iconColor="bg-info-soft"
      href="/admin/analytics?tab=google"
      state={state}
      actionPrompt={actionPrompt}
      footer={
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>
            brand {fmt(c.brand_clicks)} clicks · non-brand {fmt(c.non_brand_clicks)} clicks
          </span>
          <span>
            impr {fmt(c.brand_impressions)} / {fmt(c.non_brand_impressions)}
          </span>
        </div>
      }
    />
  );
}

function SitemapQualityCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.sitemapQuality;
  const { state, actionPrompt } = kpiCardState(snapshot, "sitemap_quality");
  return (
    <KpiCard
      title={`Sitemap quality (≥ ${c.threshold})`}
      value={fmtPct(c.overall_pass_rate, 0)}
      icon={<CheckCircle2 className="w-5 h-5 text-emerald-600" />}
      iconColor="bg-emerald-100"
      state={state}
      actionPrompt={actionPrompt}
      footer={
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>
            vendors {fmt(c.vendors.pass)}/{fmt(c.vendors.total)}
          </span>
          <span>
            events {fmt(c.events.pass)}/{fmt(c.events.total)}
          </span>
        </div>
      }
    />
  );
}

function TimeToIndexCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.timeToIndex;
  const { state, actionPrompt } = kpiCardState(snapshot, "time_to_index_h");
  // Until the gsc-sweep + sweep-time-to-index cron has been running for ~7
  // days, samples are sparse — the kpi state machine returns INDETERMINATE
  // and we render "—" with a "data collection in progress" hint.
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Time-to-index (median lag)</span>
          {state !== "INDETERMINATE" && (
            <span aria-label={KPI_STATE_STYLES[state].ariaLabel} className="text-base">
              {KPI_STATE_STYLES[state].badge}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Median
            </p>
            <p className="text-3xl font-bold text-foreground mt-1 tabular-nums">
              {fmtSeconds(c.median_seconds)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">P90</p>
            <p className="text-3xl font-bold text-foreground mt-1 tabular-nums">
              {fmtSeconds(c.p90_seconds)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Avg</p>
            <p className="text-3xl font-bold text-foreground mt-1 tabular-nums">
              {fmtSeconds(c.avg_seconds)}
            </p>
          </div>
        </div>
        {(state === "RED" || state === "STALE") && actionPrompt && (
          <p
            className={`text-xs mt-3 font-medium ${state === "STALE" ? "text-orange-600" : "text-red-600"}`}
          >
            {actionPrompt}
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-4">
          {state === "INDETERMINATE"
            ? "Data collection in progress — first results expected ~7 days post-deploy."
            : `${fmt(c.resolved)} resolved · ${fmt(c.unresolved)} unresolved`}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * §6.3 prioritized action queue. Shows P0 entries (RED KPI breaches) first,
 * then P1 entries (YELLOW KPIs that haven't been RED in the last 7d, plus
 * Tier-1 recommendation rules with affected_count >= 50). Each entry has a
 * one-line "what to do" + effort label, plus a "first detected" stamp for
 * KPI entries so long-running RED states surface their staleness.
 *
 * When the queue is empty (everything GREEN), renders an "All clear" message
 * — that's the green-light read the analyst memo wants execs to walk in to.
 */
function ActionQueueCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const entries = snapshot.actionQueue;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Action queue
          {entries.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({entries.filter((e) => e.priority === "P0").length} P0,{" "}
              {entries.filter((e) => e.priority === "P1").length} P1)
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-emerald-700">
            All clear — no KPIs in RED/YELLOW state, no T1 rules above threshold.
          </p>
        ) : (
          <ul className="space-y-3">
            {entries.map((e) => (
              <ActionQueueRow key={`${e.source}:${e.refKey}`} entry={e} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActionQueueRow({ entry }: { entry: ActionQueueEntry }) {
  const badgeClass =
    entry.priority === "P0" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800";
  const detectedDate = entry.firstDetectedAt ? new Date(entry.firstDetectedAt) : null;
  return (
    <li className="flex items-start justify-between gap-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${badgeClass}`}>
            {entry.priority}
          </span>
          <Link href={entry.href} className="font-medium text-foreground hover:underline truncate">
            {entry.title}
          </Link>
        </div>
        {detectedDate && (
          <p className="text-xs text-muted-foreground mt-0.5">
            First detected {formatTimestampForServer(detectedDate)}
          </p>
        )}
      </div>
      <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{entry.effort}</span>
    </li>
  );
}

/**
 * Recent admin activity (the chronological log that used to live in the
 * "This week's actions" panel). Demoted to a small panel below the action
 * queue; still useful as an audit trail but no longer the primary surface.
 */
function RecentActivityCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.thisWeeksActions;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Admin actions ({fmt(c.count)} last 7 days · source: admin_actions)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {c.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No admin actions in the last 7 days.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {c.actions.slice(0, 8).map((a, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span className="font-mono text-xs text-foreground truncate">{a.action}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {a.targetType}/{a.targetId.slice(0, 8)} ·{" "}
                  {formatTimestampForServer(new Date(a.createdAt))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function BlogCoverageCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.blogCoverage;
  // Three-row mini-table inside one full-width card. Click anywhere → coverage page.
  // Background color reflects the worst gap (red if any group is 100% uncovered).
  const groups = [
    { label: "Events with 0 posts", uncovered: c.events.uncovered, total: c.events.total },
    { label: "Vendors with 0 posts", uncovered: c.vendors.uncovered, total: c.vendors.total },
    { label: "Venues with 0 posts", uncovered: c.venues.uncovered, total: c.venues.total },
  ];
  const worstRatio = Math.max(...groups.map((g) => (g.total > 0 ? g.uncovered / g.total : 0)));
  const border = worstRatio >= 0.9 ? "border-red-300" : worstRatio >= 0.5 ? "border-amber-300" : "";
  return (
    <Link href="/admin/coverage" className="block hover:opacity-90 mb-6">
      <Card className={border}>
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Blog coverage gaps
              </p>
              <p className="text-3xl font-bold text-foreground mt-2 tabular-nums">
                {fmt(c.totalUncovered)}
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  / {fmt(c.totalEntities)} uncovered
                </span>
              </p>
            </div>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-violet-100 shrink-0">
              <FileText className="w-5 h-5 text-violet-600" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {groups.map((g) => {
              const pct = g.total > 0 ? Math.round((g.uncovered / g.total) * 100) : 0;
              const tone =
                pct >= 90 ? "text-red-700" : pct >= 50 ? "text-amber-700" : "text-foreground";
              return (
                <div key={g.label} className="rounded-md border border-border bg-muted p-3">
                  <p className="text-xs text-muted-foreground">{g.label}</p>
                  <p className={`text-lg font-bold mt-1 tabular-nums ${tone}`}>
                    {fmt(g.uncovered)}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      / {fmt(g.total)} ({pct}%)
                    </span>
                  </p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function RecommendationsSummaryCardView({ snapshot }: { snapshot: OverviewSnapshot }) {
  const c = snapshot.recommendations;
  const sevStyle: Record<"red" | "yellow" | "blue", { border: string; bg: string; icon: string }> =
    {
      red: { border: "border-red-300", bg: "bg-red-100", icon: "text-red-600" },
      yellow: { border: "border-amber-300", bg: "bg-amber-100", icon: "text-amber-600" },
      blue: { border: "border-info-soft", bg: "bg-info-soft", icon: "text-royal" },
    };
  const style = c.maxSeverity
    ? sevStyle[c.maxSeverity]
    : { border: "", bg: "bg-muted", icon: "text-muted-foreground" };
  return (
    <Link href="/admin/analytics?tab=recommendations" className="block hover:opacity-90">
      <Card className={`h-full ${style.border}`}>
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Recommendations (actionable)
              </p>
              <p className="text-3xl font-bold text-foreground mt-2 tabular-nums">
                {fmt(c.actionableCount)}
              </p>
              <div className="mt-2 text-xs">
                {c.totalItems === 0 ? (
                  <span className="text-muted-foreground">All clear</span>
                ) : (
                  <>
                    <span className="text-muted-foreground">
                      red + T1/T2 yellow · {fmt(c.totalItems)} total across {fmt(c.totalRules)} rule
                      {c.totalRules === 1 ? "" : "s"}
                    </span>
                    <div className="mt-1 flex gap-2">
                      {c.redCount > 0 && (
                        <span className="text-red-700 font-semibold">{fmt(c.redCount)} red</span>
                      )}
                      {c.yellowCount > 0 && (
                        <span className="text-amber-700">{fmt(c.yellowCount)} yellow</span>
                      )}
                      {c.blueCount > 0 && (
                        <span className="text-navy">{fmt(c.blueCount)} blue</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${style.bg}`}>
              <ClipboardList className={`w-5 h-5 ${style.icon}`} />
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
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                IndexNow today
              </p>
              <p className="text-3xl font-bold text-foreground mt-2 tabular-nums">
                {fmt(c.todaySubmissions)}
              </p>
              <div className="mt-2 text-xs">
                <span
                  className={hasFailures ? "text-red-700 font-semibold" : "text-muted-foreground"}
                >
                  {successPct}% success
                </span>
                {c.quota && (
                  <span className="text-muted-foreground ml-2">
                    · {fmt(c.quota.dailyRemaining)} BWT quota
                  </span>
                )}
                {c.quotaError && (
                  <span className="text-muted-foreground ml-2 italic">· quota unavailable</span>
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
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Errors (last 24h)
            </p>
            <p className="text-3xl font-bold text-foreground mt-2 tabular-nums">
              {fmt(c.last24hCount)}
            </p>
            <div className="mt-2 text-xs text-muted-foreground truncate">
              {c.topSources.length === 0
                ? "No errors logged."
                : c.topSources.map((s) => `${s.source} (${fmt(s.count)})`).join(" · ")}
            </div>
          </div>
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              high ? "bg-red-100" : "bg-muted"
            }`}
          >
            <AlertTriangle
              className={`w-5 h-5 ${high ? "text-red-600" : "text-muted-foreground"}`}
            />
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
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent>
        <div className="flex items-end justify-between mb-2">
          <p className="text-2xl font-bold text-foreground tabular-nums">{fmt(total)}</p>
          <p className="text-xs text-muted-foreground">{points.length}-day total</p>
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
    return <div className="text-xs text-muted-foreground italic">No data yet.</div>;
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

// K11 (analyst 2026-06-01 EVE) — "Search clicks milestone" growth-chart card.
// Renders the milestone line chart with on-point value labels plus a 4-stat
// row above (latest / earliest / count / May ramp). Sibling to SparklineCard
// above — same hand-rolled SVG approach the rest of the page uses (no chart
// lib in the codebase). Differs from SparklineCard in three ways: (1) value
// label on each point (8 points, not 30 — labels fit), (2) x-axis date
// labels at start/middle/end, (3) dots at each milestone so the
// non-monotonic Mar 1 → Mar 5 dip reads as an honest data point.
// K12 (2026-06-16): the chart defaults to the post-launch growth arc. The 3
// pre-May points (Mar 1 / Mar 5 / Apr 29 — including the Mar 1→5 send-order
// dip artifact) are flat pre-launch noise; starting at May 1 shows the real
// ramp. Stats above the chart still compute over the full series (e.g. the
// "May ramp vs April end" stat needs the April point).
const MILESTONE_CHART_DEFAULT_START = "2026-05-01";

function GscMilestoneChartCard({ points }: { points: GscMilestonePoint[] }) {
  if (points.length === 0) {
    return (
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Search clicks milestones</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Milestones as reported by Google Search Console emails
          </p>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground italic">No milestones yet.</p>
        </CardContent>
      </Card>
    );
  }

  const sorted = [...points]; // already sorted by emailDate in loader
  const latest = sorted[sorted.length - 1];
  const earliest = sorted[0];
  // "May ramp" = total threshold growth across May 2026 — the cited story
  // from the email. Defined as (last May threshold) - (last April threshold,
  // or earliest if no April rows). Falls back to 0 if either side is missing.
  const maySorted = sorted.filter((p) => p.emailDate.startsWith("2026-05"));
  const aprilOrEarlier = sorted.filter((p) => p.emailDate < "2026-05-01");
  const mayRamp =
    maySorted.length > 0 && aprilOrEarlier.length > 0
      ? maySorted[maySorted.length - 1].threshold -
        aprilOrEarlier[aprilOrEarlier.length - 1].threshold
      : 0;

  // Default the plotted series to the post-launch arc (May 1 onward). Fall
  // back to the full series if that leaves nothing to draw (e.g. a property
  // with only pre-May milestones) so the chart never renders blank.
  const inRange = sorted.filter((p) => p.emailDate >= MILESTONE_CHART_DEFAULT_START);
  const chartPoints = inRange.length > 0 ? inRange : sorted;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Search clicks milestones</CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Milestones from Google Search Console emails · 28-day click window · log scale · from May
          2026
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div>
            <p className="text-xs text-muted-foreground">Latest</p>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {fmt(latest.threshold)}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateOnly(latest.emailDate) || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Earliest</p>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {fmt(earliest.threshold)}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateOnly(earliest.emailDate) || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Milestones</p>
            <p className="text-2xl font-bold text-foreground tabular-nums">{fmt(sorted.length)}</p>
            <p className="text-xs text-muted-foreground">Across span</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">May ramp</p>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {mayRamp > 0 ? `+${fmt(mayRamp)}` : fmt(mayRamp)}
            </p>
            <p className="text-xs text-muted-foreground">vs. April end</p>
          </div>
        </div>
        <MilestoneChart points={chartPoints} />
      </CardContent>
    </Card>
  );
}

function MilestoneChart({ points }: { points: GscMilestonePoint[] }) {
  // Hand-rolled SVG (matches the existing Sparkline pattern). Wider viewBox
  // than the sparkline because we draw value labels above each point.
  const width = 800;
  const height = 220;
  const padTop = 28; // room for value labels above the highest point
  const padBottom = 36; // room for date labels below the x-axis
  const padLeft = 12;
  const padRight = 12;
  const stepX = points.length > 1 ? (width - padLeft - padRight) / (points.length - 1) : 0;
  const plotHeight = height - padTop - padBottom;

  // K12 (2026-06-16): log-linear y-axis. A linear axis crushes the early
  // milestones — with a 1000-click max, the 20–40 starting points sit at
  // <4% of the plot height, so the post-launch growth *shape* is unreadable.
  // Map thresholds through a natural-log scale spanning the in-view
  // [min, max], with a small low-end pad so the lowest point clears the
  // baseline. Thresholds are floored at 1 to keep log() finite.
  const logVals = points.map((p) => Math.log(Math.max(1, p.threshold)));
  const logMax = Math.max(...logVals);
  const logMinRaw = Math.min(...logVals);
  const logSpan = logMax - logMinRaw || 1; // avoid /0 when every point is equal
  const logMin = logMinRaw - logSpan * 0.08;
  const yFor = (threshold: number) =>
    padTop + plotHeight * (1 - (Math.log(Math.max(1, threshold)) - logMin) / (logMax - logMin));

  const coords = points.map((p, i) => {
    const x = padLeft + i * stepX;
    const y = yFor(p.threshold);
    return { x, y, threshold: p.threshold, emailDate: p.emailDate };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${height - padBottom} L ${coords[0].x} ${height - padBottom} Z`;

  // x-axis date labels: render at start, middle, and end so the chart
  // stays readable even when point count grows beyond 8.
  const dateLabelIndices =
    coords.length <= 1 ? [0] : [0, Math.floor((coords.length - 1) / 2), coords.length - 1];
  // De-dup so a 2-point series doesn't render the middle/end label twice.
  const uniqueDateLabelIndices = Array.from(new Set(dateLabelIndices));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-56"
      aria-label="Search clicks milestone growth chart"
      role="img"
    >
      {/* baseline at the bottom of the plot area */}
      <line
        x1={padLeft}
        y1={height - padBottom}
        x2={width - padRight}
        y2={height - padBottom}
        className="stroke-gray-200"
        strokeWidth={1}
      />
      <path d={areaPath} className="fill-blue-100" opacity={0.5} />
      <path d={linePath} className="stroke-blue-600 fill-none" strokeWidth={2} />
      {coords.map((c, i) => (
        <g key={`${c.emailDate}-${i}`}>
          {/* dot */}
          <circle cx={c.x} cy={c.y} r={4} className="fill-blue-600" />
          {/* value label above the dot */}
          <text
            x={c.x}
            y={c.y - 10}
            textAnchor="middle"
            className="fill-gray-900 text-xs font-semibold"
            style={{ fontSize: "11px" }}
          >
            {fmt(c.threshold)}
          </text>
        </g>
      ))}
      {uniqueDateLabelIndices.map((idx) => {
        const c = coords[idx];
        const anchor: "start" | "middle" | "end" =
          idx === 0 ? "start" : idx === coords.length - 1 ? "end" : "middle";
        return (
          <text
            key={`date-${idx}`}
            x={c.x}
            y={height - padBottom + 16}
            textAnchor={anchor}
            className="fill-gray-600"
            style={{ fontSize: "11px" }}
          >
            {formatDateOnly(c.emailDate) || c.emailDate}
          </text>
        );
      })}
    </svg>
  );
}

function ActivityFeedCard({
  activity,
  title = "Activity feed",
  subtitle,
}: {
  activity: ActivityEntry[];
  title?: string;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-4 h-4 text-muted-foreground" /> {title}
        </CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </CardHeader>
      <CardContent className="p-0">
        {activity.length === 0 ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">
            No recent activity in this window.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {activity.map((entry, i) => (
              <li key={i} className="px-6 py-3 flex items-start gap-3">
                <ActivityIcon kind={entry.kind} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground break-words">
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
                  <p className="text-xs text-muted-foreground mt-0.5">
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
    conversion: { Icon: TrendingUp, color: "text-royal", bg: "bg-info-soft" },
  };
  const { Icon, color, bg } = map[kind];
  return (
    <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${bg}`}>
      <Icon className={`w-3.5 h-3.5 ${color}`} />
    </span>
  );
}

// ─── Recommendations tab ────────────────────────────────────────────

/** Threshold above which a rule's last-scanned timestamp is flagged red.
 *  Pre-5/19 the scan-all loop chronically timed out and 12 of 26 rules
 *  hadn't scanned for days. Crons run hourly; >24h means something is
 *  silently broken. Analyst A1 (2026-05-29). */
const SCAN_STALE_THRESHOLD_HOURS = 24;

function ScanFreshnessBadge({ lastScannedAt }: { lastScannedAt: Date | null }) {
  if (!lastScannedAt) {
    return (
      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border bg-red-50 text-red-800 border-red-300">
        never scanned
      </span>
    );
  }
  const hoursAgo = (Date.now() - lastScannedAt.getTime()) / 3_600_000;
  const isStale = hoursAgo > SCAN_STALE_THRESHOLD_HOURS;
  const label =
    hoursAgo < 1
      ? `scanned ${Math.max(1, Math.round(hoursAgo * 60))}m ago`
      : hoursAgo < 24
        ? `scanned ${Math.round(hoursAgo)}h ago`
        : `scanned ${Math.round(hoursAgo / 24)}d ago`;
  const cls = isStale
    ? "bg-red-50 text-red-800 border-red-300"
    : "bg-muted text-muted-foreground border-border";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}

async function RecommendationsTab() {
  const { getActiveItems, getScanState, getCycleState, getOpenMatchCountsAsOf } =
    await import("@/lib/recommendations/engine");
  const { RecommendationActions } = await import("@/components/admin/recommendation-actions");
  const { RecommendationBulkActions } =
    await import("@/components/admin/recommendation-bulk-actions");
  const { RecommendationScanButton } =
    await import("@/components/admin/recommendation-scan-button");
  const tiersMod = await import("@/lib/recommendations/tiers");
  const { tierFor, TIER_META, opportunityScore } = tiersMod;
  type Tier = import("@/lib/recommendations/tiers").Tier;

  const db = getCloudflareDb();
  // Analyst Item 10 (split, 2026-05-30): per-rule WoW trend column. The
  // 7d-ago snapshot is computed at query time from recommendation_items —
  // no schema change needed. Single COUNT(*) GROUP BY plus filter on
  // firstSeenAt + actedAt; cheap enough to run on every render.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
  const [rawItems, scanState, cycleState, weekAgoCounts] = await Promise.all([
    getActiveItems(db),
    getScanState(db),
    getCycleState(db),
    getOpenMatchCountsAsOf(db, sevenDaysAgo),
  ]);

  // Resolve gsc_query items' topPagePath through slug-history at render
  // time so renamed-but-live slugs surface their CURRENT path instead of
  // the pre-rename one captured in the stored payload (analyst 2026-05-29
  // cross-cutting fix). The helper is a no-op for non-gsc items.
  const { resolveActiveItemPaths } = await import("@/lib/recommendations/resolve-active-items");
  const items = await resolveActiveItemPaths(db, rawItems);

  type Sev = "red" | "yellow" | "blue";
  type Item = (typeof items)[number];

  // Group by rule first (one card per rule). Keep the rule's own severity for
  // sort within tier; tier (from rule key) drives the top-level bucket.
  type RuleGroup = {
    ruleId: string;
    ruleKey: string;
    title: string;
    rationaleTemplate: string;
    severity: Sev;
    tier: Tier;
    totalMatchCount: number;
    /** Most-recent successful scan for this rule. Drives the per-card
     *  staleness badge (>24h → red). Denormalized via getActiveItems so
     *  no extra query is needed here. Null when the rule has never
     *  scanned (in practice covered by the failedRules banner since
     *  never-scanned rules don't produce items, but kept defensively). */
    lastScannedAt: Date | null;
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
        tier: tierFor(it.ruleKey),
        totalMatchCount: it.ruleTotalMatchCount,
        lastScannedAt: it.ruleLastScannedAt,
        items: [],
      };
      ruleGroups.set(it.ruleId, g);
    }
    g.items.push(it);
  }

  // §10.3: bucket by TIER first; severity drives sort order within each tier.
  const byTier: Record<Tier, RuleGroup[]> = { T1: [], T2: [], T3: [] };
  for (const g of ruleGroups.values()) byTier[g.tier].push(g);
  const sevRank = (s: Sev) => (s === "red" ? 0 : s === "yellow" ? 1 : 2);
  for (const t of ["T1", "T2", "T3"] as Tier[]) {
    byTier[t].sort((a, b) => {
      if (a.severity !== b.severity) return sevRank(a.severity) - sevRank(b.severity);
      return b.items.length - a.items.length;
    });
  }

  // §10.3 opportunities feed: top 10 highest-scoring items across all tiers.
  // Score combines severity weight + match count so high-severity-low-count
  // beats low-severity-high-count, but match count breaks ties.
  const opportunities = Array.from(ruleGroups.values())
    .map((g) => ({ group: g, score: opportunityScore(g.severity, g.items.length) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Analyst Item 2 (2026-05-30): per-ITEM opportunities feed showing the
  // 10 highest-leverage individual targets across all rules — different
  // from the per-rule rollup above. Operator clicks a row and goes
  // straight to "rewrite this title and meta description for THIS event"
  // rather than "look at the low_ctr_pages bucket and pick one yourself."
  //
  // Limited to gsc_query items because they have the single-line format
  // the spec calls for (query · impressions · clicks · position · action).
  // Other item types have varied payloads that don't render cleanly in
  // a uniform list — they remain visible via the per-rule grouping below.
  // Sort key: impressions descending (impact proxy that works for both
  // page_1_zero_click_queries and low_ctr_pages — clicks foregone is
  // proportional to impressions × baseline-CTR-at-position).
  interface PerItemOpportunity {
    itemId: string;
    ruleId: string;
    ruleKey: string;
    severity: Sev;
    query: string;
    impressions: number;
    clicks: number;
    position: number;
    suggestedAction: string;
    targetUrl: string | null;
  }
  const perItemOpportunities: PerItemOpportunity[] = items
    .filter((it) => it.targetType === "gsc_query" && it.payload != null)
    .map((it): PerItemOpportunity | null => {
      const p = it.payload as Record<string, unknown>;
      const query = typeof p.query === "string" ? p.query : null;
      const impressions = typeof p.impressions === "number" ? p.impressions : null;
      if (!query || impressions == null) return null;
      const clicks = typeof p.clicks === "number" ? p.clicks : 0;
      const position = typeof p.position === "number" ? p.position : 0;
      const action =
        typeof p.suggestedAction === "string"
          ? p.suggestedAction
          : it.ruleKey === "low_ctr_pages"
            ? "Rewrite title and meta description"
            : it.ruleKey === "seo_position_11_20"
              ? "Boost internal links and refresh content"
              : "Review opportunity";
      const url =
        "resolvedTopPagePath" in it && typeof it.resolvedTopPagePath === "string"
          ? it.resolvedTopPagePath
          : typeof p.topPagePath === "string"
            ? p.topPagePath
            : null;
      return {
        itemId: it.itemId,
        ruleId: it.ruleId,
        ruleKey: it.ruleKey,
        severity: it.severity as Sev,
        query,
        impressions,
        clicks,
        position,
        suggestedAction: action,
        targetUrl: url,
      };
    })
    .filter((x): x is PerItemOpportunity => x != null)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);

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
      cardBorder: "border-info-soft",
      badge: "bg-info-soft text-navy-dark border-info-soft",
      chip: "bg-info-soft text-navy-dark border-info-soft",
    },
  };

  function rationaleFor(group: RuleGroup): string {
    return group.rationaleTemplate.replace(/\{n\}/g, String(group.items.length));
  }

  function targetLink(item: Item): string | null {
    // Admin vendor edit page is keyed by id (route is /admin/vendors/[id]/edit
    // — there is no slug-based admin vendor route). targetId is the vendor.id
    // for every vendor-targeting rule; previous code used payload.slug which
    // always 404'd.
    if (item.targetType === "vendor" && item.targetId) {
      return `/admin/vendors/${item.targetId}/edit`;
    }
    if (item.targetType === "event" && item.payload && typeof item.payload.slug === "string") {
      return `/events/${item.payload.slug}`;
    }
    if (item.targetType === "venue" && item.payload && typeof item.payload.slug === "string") {
      return `/venues/${item.payload.slug}`;
    }
    if (
      item.targetType === "static_page" &&
      item.payload &&
      typeof item.payload.path === "string"
    ) {
      return item.payload.path;
    }
    // gsc_query items don't have a public detail page — surface a deep
    // link to the page the query is hitting instead. Prefer the
    // render-time resolved path (slug-history-aware) over the stored
    // payload.topPagePath; "stale" status falls through to no-link.
    if (item.targetType === "gsc_query") {
      const resolved =
        "resolvedTopPagePath" in item && typeof item.resolvedTopPagePath === "string"
          ? item.resolvedTopPagePath
          : null;
      const resolvedStatus = "resolvedTopPageStatus" in item ? item.resolvedTopPageStatus : null;
      if (resolved && resolvedStatus !== "stale") return resolved;
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
    if (item.payload && typeof item.payload.label === "string") {
      return item.payload.label;
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
    if (item.targetType === "static_page") {
      const status = typeof p.status === "string" ? p.status : null;
      if (status === "missing") return "no meta description";
      const path = typeof p.path === "string" ? p.path : null;
      return [path, descLen].filter(Boolean).join(" · ") || null;
    }
    if (item.targetType === "gsc_query") {
      const pos = typeof p.position === "number" ? `pos ${p.position}` : null;
      const impr = typeof p.impressions === "number" ? `${p.impressions} impr` : null;
      // Show the path Google's reporting on. Prefer the render-time
      // resolved (slug-history-aware) value; if it differs from the
      // stored payload value, mark it "(renamed)" so the operator
      // knows the suggestion still points at a live page even though
      // the original GSC report didn't.
      const resolved =
        "resolvedTopPagePath" in item && typeof item.resolvedTopPagePath === "string"
          ? item.resolvedTopPagePath
          : null;
      const stored = typeof p.topPagePath === "string" ? p.topPagePath : null;
      let pathStr: string | null = null;
      if (resolved) {
        const status = "resolvedTopPageStatus" in item ? item.resolvedTopPageStatus : null;
        if (status === "renamed" && stored && stored !== resolved) {
          pathStr = `${resolved} (renamed from ${stored})`;
        } else if (status === "stale") {
          pathStr = `${resolved} (stale)`;
        } else {
          pathStr = resolved;
        }
      } else if (stored) {
        pathStr = stored;
      }
      return [pathStr, pos, impr].filter(Boolean).join(" · ") || null;
    }
    return null;
  }

  const totalRules = ruleGroups.size;

  return (
    <>
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">
          {items.length === 0
            ? "No active recommendations. Run a scan to surface new ones."
            : `${items.length} active item${items.length === 1 ? "" : "s"} across ${totalRules} rule${
                totalRules === 1 ? "" : "s"
              }. Click any rule to expand affected targets.`}
        </p>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {scanState.lastSuccessfulScanAt
              ? `Last successful scan: ${formatTimestampForServer(scanState.lastSuccessfulScanAt)}`
              : "Never scanned"}
          </span>
          <RecommendationScanButton />
        </div>
      </div>

      {/* REL3 (2026-06-08) — cycle-progress surface. The daily scan now
          runs N chunks per fire and persists a cursor across runs; the
          full sweep wraps around every ~2 days. This banner shows where
          the cursor sits so operators can correlate "tail-stale items"
          with "we're 2 chunks into the next cycle." */}
      {cycleState && (
        <div className="mb-6 rounded-md border border-border bg-muted/40 p-4 text-xs space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-medium text-foreground">Scan cycle progress</span>
            <span className="text-muted-foreground">
              cursor {cycleState.cursor} of {cycleState.totalRules} rules
              {cycleState.cursor === 0 ? " (at start)" : ""}
            </span>
            <span className="text-muted-foreground">
              {cycleState.completedCycles} completed cycle
              {cycleState.completedCycles === 1 ? "" : "s"}
            </span>
            {cycleState.lastRunAt && (
              <span className="text-muted-foreground">
                last run: {formatTimestampForServer(cycleState.lastRunAt)} (
                {cycleState.lastRunChunks} chunk{cycleState.lastRunChunks === 1 ? "" : "s"})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Per-rule scan-error banners. PR #148 + #150 (this PR): scanAll
          catches per-rule failures, persists the message on
          recommendation_rules.last_scan_error, and clears on next success.
          Surfaces here so silent broken rules don't decay invisibly. */}
      {scanState.failedRules.length > 0 && (
        <div className="mb-6 rounded-md border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-900 mb-2">
            {scanState.failedRules.length} rule
            {scanState.failedRules.length === 1 ? "" : "s"} failed during last scan
          </p>
          <ul className="space-y-2">
            {scanState.failedRules.map((fr) => (
              <li key={fr.ruleId} className="text-xs">
                <div className="font-mono text-red-900">{fr.ruleKey}</div>
                <div className="text-red-800 break-words">{fr.error}</div>
                <div className="text-red-700/80 mt-0.5">
                  Last successful scan:{" "}
                  {fr.lastScannedAt ? formatTimestampForServer(fr.lastScannedAt) : "never"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Analyst Item 2 (2026-05-30): per-ITEM opportunities feed —
          top 10 individual gsc_query targets across all rules, sorted
          by impressions (impact proxy). Operator clicks a row and goes
          straight to a specific URL with a specific action; bridges
          the gap between the Site CTR KPI ("rewrite event title /
          description template" — abstract) and Monday work. Distinct
          from the per-rule rollup below. */}
      {perItemOpportunities.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Top opportunities (next 10 to work)</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Highest-impact individual queries across all SEO rules. Sorted by impressions —
              biggest potential traffic recovery first.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {perItemOpportunities.map((o) => {
                const sevMeta = severityMeta[o.severity];
                return (
                  <li key={o.itemId} className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 mt-0.5 ${sevMeta.chip}`}
                      >
                        {o.ruleKey === "page_1_zero_click_queries"
                          ? "0-click"
                          : o.ruleKey === "low_ctr_pages"
                            ? "low CTR"
                            : o.ruleKey === "seo_position_11_20"
                              ? "page 2"
                              : "SEO"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground truncate">{o.query}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {o.targetUrl && (
                            <Link
                              href={o.targetUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-royal hover:underline"
                            >
                              {o.targetUrl}
                            </Link>
                          )}
                          {o.targetUrl && " · "}
                          <span className="tabular-nums">
                            {o.impressions} imp, {o.clicks} clicks, pos {o.position}
                          </span>
                          {" · "}
                          <span className="text-foreground">{o.suggestedAction}</span>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* §10.3 opportunities feed — top 10 across all tiers ordered by score.
          Per-RULE rollup. Complement to the per-ITEM feed above. */}
      {opportunities.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Top rules by impact ({opportunities.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {opportunities.map(({ group: g }) => {
                const sevMeta = severityMeta[g.severity];
                return (
                  <li key={g.ruleId} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${sevMeta.chip}`}
                      >
                        {g.tier}
                      </span>
                      <span className="text-sm text-foreground truncate">{g.title}</span>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {g.items.length} affected
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {(["T1", "T2", "T3"] as Tier[]).map((tier) => {
        const groups = byTier[tier];
        if (groups.length === 0) return null;
        const tMeta = TIER_META[tier];
        return (
          <div key={tier} className="mb-8">
            <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-2">
              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium border bg-muted text-foreground border-border">
                {tMeta.label}
              </span>
              <span className="text-muted-foreground font-normal">{groups.length}</span>
            </h2>
            <p className="text-xs text-muted-foreground mb-3">{tMeta.description}</p>
            <div className="space-y-3">
              {groups.map((group) => {
                const meta = severityMeta[group.severity];
                const count = group.items.length;
                const defaultOpen = count === 1;
                return (
                  <Card key={group.ruleId} className={meta.cardBorder}>
                    <details open={defaultOpen} className="group">
                      <summary className="cursor-pointer p-5 list-none [&::-webkit-details-marker]:hidden">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-muted-foreground group-open:rotate-90 transition-transform inline-block">
                                ▶
                              </span>
                              <p className="text-sm font-semibold text-foreground">{group.title}</p>
                              <span
                                className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${meta.chip}`}
                              >
                                {group.totalMatchCount > count
                                  ? `${count} of ${group.totalMatchCount} affected`
                                  : `${count} affected`}
                              </span>
                              {(() => {
                                // Analyst Item 10 (split, 2026-05-30) WoW chip:
                                // delta vs. open-count 7 days ago. Direction
                                // colored from the operator's perspective —
                                // ↓ (shrinking queue) = green, ↑ (growing) =
                                // amber, no change = gray dash. Hidden when
                                // both counts are 0 (avoids 0-vs-0 noise on
                                // freshly-shipped rules).
                                const prev = weekAgoCounts.get(group.ruleId) ?? 0;
                                const delta = count - prev;
                                if (prev === 0 && count === 0) return null;
                                const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "—";
                                const sign = delta > 0 ? "+" : "";
                                const trendClass =
                                  delta > 0
                                    ? "text-amber-700 bg-amber-50 border-amber-200"
                                    : delta < 0
                                      ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                                      : "text-muted-foreground bg-muted border-border";
                                return (
                                  <span
                                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border tabular-nums ${trendClass}`}
                                    title={`Week-over-week: ${prev} open 7d ago → ${count} now`}
                                  >
                                    {arrow}
                                    {delta === 0 ? "" : `${sign}${delta}`}
                                  </span>
                                );
                              })()}
                            </div>
                            <p className="text-sm text-foreground mt-1.5 ml-6">
                              {rationaleFor(group)}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1 ml-6 flex items-center gap-2 flex-wrap">
                              <span>rule {group.ruleKey}</span>
                              <ScanFreshnessBadge lastScannedAt={group.lastScannedAt} />
                            </p>
                          </div>
                          <div className="shrink-0">
                            <RecommendationBulkActions
                              ruleId={group.ruleId}
                              itemCount={group.items.length}
                            />
                          </div>
                        </div>
                      </summary>
                      <div className="border-t border-border divide-y divide-gray-100">
                        {[...group.items]
                          .sort((a, b) =>
                            targetLabel(a).localeCompare(targetLabel(b), undefined, {
                              sensitivity: "base",
                              numeric: true,
                            })
                          )
                          .map((item) => {
                            const link = targetLink(item);
                            const meta2 = targetMeta(item);
                            return (
                              <div
                                key={item.itemId}
                                className="px-5 py-3 flex items-start justify-between gap-4 flex-wrap hover:bg-muted"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-foreground">
                                    {link ? (
                                      <Link href={link} className="text-royal hover:underline">
                                        {targetLabel(item)}
                                      </Link>
                                    ) : (
                                      <span className="font-mono">{targetLabel(item)}</span>
                                    )}
                                  </p>
                                  {meta2 && (
                                    <p className="text-xs text-muted-foreground mt-0.5">{meta2}</p>
                                  )}
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

      {/* Scan freshness — every enabled rule, including ones with zero
          current matches. Catches the chronic case the analyst flagged:
          rules that never finished a scan are invisible above because
          they produce no items, but they're still in the queue. Sorted
          stale-first so red rows are immediately visible. */}
      {scanState.allRules.length > 0 && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-sm">
              Scan freshness ({scanState.allRules.length} enabled rule
              {scanState.allRules.length === 1 ? "" : "s"})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs">
              {[...scanState.allRules]
                .sort((a, b) => {
                  const aMs = a.lastScannedAt ? a.lastScannedAt.getTime() : 0;
                  const bMs = b.lastScannedAt ? b.lastScannedAt.getTime() : 0;
                  // Stale first: NULL ranks oldest, then ascending time
                  // means most-stale at the top.
                  if (aMs === bMs) return a.ruleKey.localeCompare(b.ruleKey);
                  return aMs - bMs;
                })
                .map((r) => (
                  <li key={r.ruleId} className="flex items-center justify-between gap-3 py-0.5">
                    <span className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="font-mono text-foreground truncate">{r.ruleKey}</span>
                      {r.hasError && (
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border bg-red-50 text-red-800 border-red-300 shrink-0">
                          last scan errored
                        </span>
                      )}
                    </span>
                    <span className="shrink-0">
                      <ScanFreshnessBadge lastScannedAt={r.lastScannedAt} />
                    </span>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground mt-6">
        Active items refresh on scan or when an item&apos;s match expires the 7-day window.
        Per-target Snooze hides an item temporarily; Mark done resolves it permanently. All actions
        are logged to <code>admin_actions</code>.
      </p>
    </>
  );
}

// ─── Existing tabs (unchanged below this line) ──────────────────────

// Allowed display sizes; anything else falls back to the default.
const INDEXNOW_LIMITS = [25, 100, 250] as const;
type IndexNowLimit = (typeof INDEXNOW_LIMITS)[number];

function parseIndexNowLimit(raw: string | undefined): IndexNowLimit {
  const n = Number(raw);
  return INDEXNOW_LIMITS.includes(n as IndexNowLimit) ? (n as IndexNowLimit) : 25;
}

async function IndexNowTab({ limit: rawLimit, source }: { limit?: string; source?: string }) {
  const db = getCloudflareDb();
  const limit = parseIndexNowLimit(rawLimit);
  // Source filter: free-form (event.approve, vendor.create, etc.), but we
  // restrict to a sane set for the dropdown so admins don't have to guess.
  const trimmedSource = source?.trim() || null;

  // Build the source set for the dropdown by aggregating distinct values from
  // recent submissions. Cap to 50 distinct sources to bound the query cost.
  const distinctSources = await db
    .selectDistinct({ source: indexnowSubmissions.source })
    .from(indexnowSubmissions)
    .orderBy(indexnowSubmissions.source)
    .limit(50);

  const baseQuery = db
    .select()
    .from(indexnowSubmissions)
    .orderBy(desc(indexnowSubmissions.timestamp));

  const recent = trimmedSource
    ? await baseQuery.where(eq(indexnowSubmissions.source, trimmedSource)).limit(limit)
    : await baseQuery.limit(limit);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      success: "bg-green-100 text-green-800",
      failure: "bg-red-100 text-red-800",
      no_key: "bg-muted text-foreground",
      no_eligible_urls: "bg-yellow-100 text-yellow-800",
    };
    const cls = map[status] ?? "bg-muted text-foreground";
    return (
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
        {status}
      </span>
    );
  };

  // Filter URL builder — keeps `tab=indexnow` and other params, swaps the one
  // we're toggling. Server-component-driven, so each interaction is a navigation.
  const filterUrl = (overrides: { limit?: number; source?: string | null }) => {
    const sp = new URLSearchParams();
    sp.set("tab", "indexnow");
    const newLimit = overrides.limit ?? limit;
    if (newLimit !== 25) sp.set("indexnow_limit", String(newLimit));
    const newSource = overrides.source !== undefined ? overrides.source : trimmedSource;
    if (newSource) sp.set("indexnow_source", newSource);
    const qs = sp.toString();
    return `/admin/analytics?${qs}`;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle>
            Recent IndexNow submissions
            {trimmedSource ? ` · source=${trimmedSource}` : ""} (last {limit})
          </CardTitle>
          <div className="flex items-center gap-2 text-sm">
            {/* Source dropdown — server-rendered <select> wrapped as a controlled
                navigation. We render distinct options from recent submissions. */}
            <form method="get" action="/admin/analytics" className="flex items-center gap-2">
              <input type="hidden" name="tab" value="indexnow" />
              {limit !== 25 && <input type="hidden" name="indexnow_limit" value={String(limit)} />}
              <select
                name="indexnow_source"
                defaultValue={trimmedSource ?? ""}
                className="rounded-md border border-border px-2 py-1 text-sm"
              >
                <option value="">All sources</option>
                {distinctSources.map((row) => (
                  <option key={row.source} value={row.source}>
                    {row.source}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
              >
                Apply
              </button>
            </form>
            <div className="inline-flex items-center bg-muted rounded-lg p-1 text-xs">
              {INDEXNOW_LIMITS.map((n) => (
                <Link
                  key={n}
                  href={filterUrl({ limit: n })}
                  className={
                    "px-2 py-0.5 rounded " +
                    (n === limit
                      ? "bg-card shadow text-foreground"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {n}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
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
                <td colSpan={6} className="px-6 py-6 text-muted-foreground">
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
                    <td className="px-6 py-2 whitespace-nowrap text-foreground tabular-nums">
                      {formatTimestampForServer(row.timestamp)}
                    </td>
                    <td className="px-6 py-2 font-mono text-xs text-foreground">{row.source}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.urlCount)}</td>
                    <td className="px-6 py-2">{statusBadge(row.status)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-foreground">
                      {row.httpStatus ?? "—"}
                    </td>
                    <td className="px-6 py-2 text-xs text-foreground break-all max-w-md">
                      {row.errorMessage ? (
                        <span className="text-red-700">{row.errorMessage}</span>
                      ) : urlsArr.length === 0 ? (
                        "—"
                      ) : urlsArr.length === 1 ? (
                        <a
                          href={urlsArr[0]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-navy hover:underline"
                        >
                          {urlsArr[0]}
                        </a>
                      ) : (
                        <details className="cursor-pointer">
                          <summary className="select-none">
                            <span className="font-mono">{urlsArr[0]}</span>
                            <span className="text-muted-foreground">
                              {" "}
                              +{urlsArr.length - 1} more (click to expand)
                            </span>
                          </summary>
                          <ul className="mt-2 space-y-1 pl-4 border-l-2 border-border">
                            {urlsArr.map((url, i) => (
                              <li key={i} className="font-mono break-all">
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-navy hover:underline"
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
  const sinceTimestamp = new Date(Date.now() - days * 86400 * 1000);

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
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="text-left px-6 py-2 font-medium">Event</th>
                <th className="text-right px-6 py-2 font-medium">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summary.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-6 py-6 text-muted-foreground">
                    No first-party events recorded yet.
                  </td>
                </tr>
              ) : (
                summary.map((row) => (
                  <tr key={row.eventName}>
                    <td className="px-6 py-2 font-mono text-xs text-foreground">{row.eventName}</td>
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
            <thead className="bg-muted text-muted-foreground">
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
                  <td colSpan={5} className="px-6 py-6 text-muted-foreground">
                    No events in the last {days} days.
                  </td>
                </tr>
              ) : (
                recent.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="px-6 py-2 whitespace-nowrap text-foreground tabular-nums">
                      {formatTimestampForServer(row.timestamp)}
                    </td>
                    <td className="px-6 py-2 text-foreground">{row.eventCategory}</td>
                    <td className="px-6 py-2 font-mono text-xs text-foreground">{row.eventName}</td>
                    <td className="px-6 py-2 font-mono text-xs text-muted-foreground">
                      {row.userId ? row.userId.slice(0, 8) : "—"}
                    </td>
                    <td className="px-6 py-2 font-mono text-xs text-foreground break-all max-w-md">
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
      className="mb-6 flex flex-wrap items-center gap-2 border-b border-border pb-2"
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
              isActive
                ? "bg-secondary text-secondary-foreground"
                : "bg-muted text-foreground hover:bg-muted"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
      {/* REL4 kill-switch — sits to the right of the IndexNow tab (the last tab)
          and only on the IndexNow view, where it's contextually relevant. */}
      {currentTab === "indexnow" && <IndexNowKillSwitchToggle />}
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

// K11 (analyst 2026-06-01 EVE) — "Congrats on X clicks in 28 days" milestone
// rows from gsc_milestone_emails. siteUrl filter is critical: the table also
// holds milestones for the Maine Cardworks property; the MMATF chart must
// scope by site_url='https://meetmeatthefair.com/'. Hard-coded (not env-var)
// because this is the admin page for THIS site.
async function loadGscMilestones(): Promise<GscMilestonePoint[]> {
  const { gscMilestoneEmails } = await import("@/lib/db/schema");
  const { and, eq, asc } = await import("drizzle-orm");
  const db = getCloudflareDb();
  const rows = await db
    .select({
      threshold: gscMilestoneEmails.threshold,
      emailDate: gscMilestoneEmails.emailDate,
      reachedDate: gscMilestoneEmails.reachedDate,
    })
    .from(gscMilestoneEmails)
    .where(
      and(
        eq(gscMilestoneEmails.metric, "clicks"),
        eq(gscMilestoneEmails.windowDays, 28),
        eq(gscMilestoneEmails.siteUrl, "https://meetmeatthefair.com/")
      )
    )
    .orderBy(asc(gscMilestoneEmails.emailDate));
  // The Mar 1 → Mar 5 dip (30 → 20) is a Google send-order artifact, NOT a
  // real decline. Render faithfully in email_date order — do not smooth or
  // sort by threshold.
  return rows.map((r) => ({
    threshold: r.threshold,
    emailDate: r.emailDate,
    reachedDate: r.reachedDate,
  }));
}

interface GscMilestonePoint {
  threshold: number;
  emailDate: string;
  reachedDate: string | null;
}

async function GoogleTab() {
  // Milestone card reads from our own D1 (gsc_milestone_emails), not the
  // Search Console API — so it must render whether or not SC_SITE_URL is
  // configured. Load + render it ABOVE the GSC API gate. The GSC-API
  // sections below early-return GscErrorPanel when SC is unconfigured.
  const milestones = await loadGscMilestones();
  const result = await loadGscData();
  if (!result.ok) {
    return (
      <>
        <GscMilestoneChartCard points={milestones} />
        <GscErrorPanel kind={result.kind} message={result.message} />
      </>
    );
  }
  const { queries, sitemaps } = result;
  const sitemapErrorCount = sitemaps?.sitemaps.reduce((acc, s) => acc + (s.errors ?? 0), 0) ?? 0;
  const sitemapWarningCount =
    sitemaps?.sitemaps.reduce((acc, s) => acc + (s.warnings ?? 0), 0) ?? 0;

  // Compute true indexed count from gsc_inspection_state. The Sitemaps API's
  // per-content `indexed` field has been deprecated by Google for years
  // (always returns 0 now) — the real per-URL signal lives in URL Inspection,
  // which our daily sweep persists into gsc_inspection_state.
  const { gscInspectionState } = await import("@/lib/db/schema");
  const { count, inArray } = await import("drizzle-orm");
  const dbForIndexed = getCloudflareDb();
  const [indexedRow, inspectedRow] = await Promise.all([
    dbForIndexed
      .select({ c: count() })
      .from(gscInspectionState)
      .where(inArray(gscInspectionState.lastVerdict, ["PASS", "SUCCESS"])),
    dbForIndexed.select({ c: count() }).from(gscInspectionState),
  ]);
  const indexedCount = indexedRow[0]?.c ?? 0;
  const inspectedCount = inspectedRow[0]?.c ?? 0;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Total clicks</p>
            <p className="text-2xl font-bold text-foreground mt-1 tabular-nums">
              {fmt(queries?.totals.clicks ?? 0)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {queries ? `${queries.dateRange.startDate} → ${queries.dateRange.endDate}` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Unique queries</p>
            <p className="text-2xl font-bold text-foreground mt-1 tabular-nums">
              {fmt(queries?.totals.queries ?? 0)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {fmt(queries?.totals.impressions ?? 0)} impressions
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Sitemap status</p>
            <p className="text-2xl font-bold text-foreground mt-1 tabular-nums">
              {fmt(indexedCount)} /{" "}
              <span className="text-base font-normal text-muted-foreground">
                {fmt(sitemaps?.totals.submitted ?? 0)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              indexed / submitted · {fmt(sitemapErrorCount)} errors · {fmt(sitemapWarningCount)}{" "}
              warnings
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Indexed = URLs with PASS verdict in our URL Inspection sweep ({fmt(inspectedCount)}{" "}
              inspected). GSC Sitemaps API stopped reporting per-URL indexed counts in 2022.
            </p>
          </CardContent>
        </Card>
      </div>

      <GscMilestoneChartCard points={milestones} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Top GSC queries</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
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
                  <td colSpan={5} className="px-6 py-6 text-muted-foreground">
                    No GSC query data for the current window.
                  </td>
                </tr>
              ) : (
                queries.queries.map((row, i) => (
                  <tr key={`${row.query}-${i}`}>
                    <td className="px-6 py-2 text-foreground truncate max-w-md">{row.query}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.clicks)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
                      {fmt(row.impressions)}
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
                      {(row.ctr * 100).toFixed(1)}%
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
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
            <thead className="bg-muted text-muted-foreground">
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
                  <td colSpan={6} className="px-6 py-6 text-muted-foreground">
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
                      <td className="px-6 py-2 text-foreground">
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
          <BarChart3 className="w-5 h-5 text-muted-foreground" />
          {isConfig ? "Search Console not configured" : "Could not load Search Console data"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-foreground mb-4">{message}</p>
        {isConfig && (
          <div className="text-sm text-foreground space-y-2">
            <p className="font-medium">One-time setup:</p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                Confirm{" "}
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
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
            <p className="text-sm text-muted-foreground">Bingbot crawl issues</p>
            <p className="text-2xl font-bold text-foreground mt-1 tabular-nums">
              {fmt(errorCount)} errors · {fmt(warningCount)} warnings
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              From Bingbot&apos;s crawl. The manual Site Scan tool isn&apos;t exposed via API —{" "}
              <a
                href="https://www.bing.com/webmasters/sitescan?siteUrl=https://meetmeatthefair.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-royal hover:text-navy"
              >
                view in BWT
              </a>
              .
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Search clicks (recent)</p>
            <p className="text-2xl font-bold text-foreground mt-1 tabular-nums">
              {fmt(queries.reduce((acc, q) => acc + q.clicks, 0))}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {queries.length} unique {queries.length === 1 ? "query" : "queries"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Bing direct submit quota</p>
            <p className="text-2xl font-bold text-foreground mt-1 tabular-nums">
              {quota ? fmt(quota.dailyRemaining) : "—"}
              {quota && (
                <span className="text-base font-normal text-muted-foreground">
                  {" "}
                  / {fmt(quota.dailyQuota)} daily
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {quota
                ? `${fmt(quota.monthlyRemaining)} of ${fmt(quota.monthlyQuota)} monthly`
                : "Unavailable"}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
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
            <thead className="bg-muted text-muted-foreground">
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
                  <td colSpan={4} className="px-6 py-6 text-muted-foreground">
                    No Bing query data yet. Bing typically takes 7&ndash;14 days after site
                    verification to start reporting search-performance data.
                  </td>
                </tr>
              ) : (
                queries.slice(0, 25).map((row, i) => (
                  <tr key={`${row.query}-${i}`}>
                    <td className="px-6 py-2 text-foreground truncate max-w-md">{row.query}</td>
                    <td className="px-6 py-2 text-right tabular-nums">{fmt(row.clicks)}</td>
                    <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
                      {fmt(row.impressions)}
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
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
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left px-6 py-2 font-medium">Page</th>
                  <th className="text-right px-6 py-2 font-medium">Clicks</th>
                  <th className="text-right px-6 py-2 font-medium">Impr.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pages.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-6 text-muted-foreground">
                      No data yet. Populates after Bing accumulates impression data (typically
                      7&ndash;14 days post-verification).
                    </td>
                  </tr>
                ) : (
                  pages.slice(0, 15).map((row, i) => (
                    <tr key={`${row.page}-${i}`}>
                      <td className="px-6 py-2 font-mono text-xs truncate max-w-xs">{row.page}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(row.clicks)}</td>
                      <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
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
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left px-6 py-2 font-medium">Date</th>
                  <th className="text-right px-6 py-2 font-medium">Crawled</th>
                  <th className="text-right px-6 py-2 font-medium">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {crawl.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-6 text-muted-foreground">
                      No crawl data yet. Bingbot needs to visit the site at least once; can take a
                      few days after sitemap submission.
                    </td>
                  </tr>
                ) : (
                  crawl.slice(0, 14).map((row) => (
                    <tr key={row.date}>
                      <td className="px-6 py-2 tabular-nums text-foreground">{row.date}</td>
                      <td className="px-6 py-2 text-right tabular-nums">{fmt(row.crawledPages)}</td>
                      <td className="px-6 py-2 text-right tabular-nums text-muted-foreground">
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
          <BarChart3 className="w-5 h-5 text-muted-foreground" />
          {isConfig ? "Bing Webmaster Tools not configured" : "Could not load Bing data"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-foreground mb-4">{message}</p>
        {isConfig && (
          <div className="text-sm text-foreground space-y-2">
            <p className="font-medium">One-time setup:</p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                Sign in at{" "}
                <a
                  href="https://www.bing.com/webmasters/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-royal hover:text-navy"
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
                <pre className="mt-2 bg-muted p-2 rounded font-mono text-xs">
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

// ── Site Health helpers (OPE-49) ──────────────────────────────────────────
// A row is "stale" — i.e. the tiered sweep hasn't re-inspected it — once its
// last_detected_at is older than this, so its still-open status is unconfirmed.
const SITE_HEALTH_STALE_MS = 14 * 24 * 3600 * 1000;

const SITE_HEALTH_SEVERITY_RANK: Record<string, number> = { ERROR: 0, WARNING: 1, NOTICE: 2 };

/** Terse "what do I do about this" hint, keyed by issueType + tier. */
function nextStepForIssue(issueType: string, tier: "ACTION" | "EXPECTED"): string {
  if (tier === "EXPECTED") return "No action — expected for thin/seasonal pages";
  switch (issueType) {
    case "GSC_RICH_RESULT_FAIL":
      return "Fix structured-data field, then Request indexing";
    case "GSC_INSPECTION_NON_OK":
      return "Investigate crawl/return code";
    case "GSC_SITEMAP_ERRORS":
    case "GSC_SITEMAP_WARNINGS":
      return "Review the sitemap entry in Search Console";
    default:
      if (issueType.startsWith("SITEMAP_")) return "Resubmit the sitemap in Bing Webmaster Tools";
      return "Investigate the flagged URL";
  }
}

/** Collapse near-identical messages so rows that differ only by a URL/entity
 *  name or a count fold into one group: lower-case, unicode dashes → "-",
 *  digit runs → "#". */
function normalizeHealthMessageKey(message: string | null): string {
  if (!message) return "";
  return message.toLowerCase().replace(/[‐-―]/g, "-").replace(/\d+/g, "#").trim();
}

interface SiteHealthRowInput {
  source: string;
  issueType: string;
  severity: string;
  url: string | null;
  message: string | null;
  lastDetectedAt: Date;
  snoozedUntil: Date | null;
}

interface SiteHealthGroup {
  key: string;
  source: string;
  issueType: string;
  severity: string;
  tier: "ACTION" | "EXPECTED";
  message: string | null;
  nextStep: string;
  urls: Array<{ url: string | null; lastDetectedAt: Date; snoozedUntil: Date | null }>;
  count: number;
  mostRecent: Date;
  stale: boolean;
}

/** Aggregate rows into (source + issueType + normalized-message) groups, each
 *  carrying the individual affected URLs for the expandable detail. */
function buildSiteHealthGroups(rows: SiteHealthRowInput[], now: number): SiteHealthGroup[] {
  const map = new Map<string, SiteHealthGroup>();
  for (const row of rows) {
    const tier: "ACTION" | "EXPECTED" = isExpectedNonIndexing(row.issueType, row.message)
      ? "EXPECTED"
      : "ACTION";
    const key = `${row.source}|${row.issueType}|${normalizeHealthMessageKey(row.message)}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        source: row.source,
        issueType: row.issueType,
        severity: row.severity,
        tier,
        message: row.message,
        nextStep: nextStepForIssue(row.issueType, tier),
        urls: [],
        count: 0,
        mostRecent: row.lastDetectedAt,
        stale: false,
      };
      map.set(key, group);
    }
    group.urls.push({
      url: row.url,
      lastDetectedAt: row.lastDetectedAt,
      snoozedUntil: row.snoozedUntil,
    });
    group.count++;
    if (row.lastDetectedAt.getTime() > group.mostRecent.getTime()) {
      group.mostRecent = row.lastDetectedAt;
    }
  }
  const groups = Array.from(map.values());
  for (const g of groups) {
    g.stale = now - g.mostRecent.getTime() > SITE_HEALTH_STALE_MS;
    g.urls.sort((a, b) => b.lastDetectedAt.getTime() - a.lastDetectedAt.getTime());
  }
  groups.sort(
    (a, b) =>
      (SITE_HEALTH_SEVERITY_RANK[a.severity] ?? 9) - (SITE_HEALTH_SEVERITY_RANK[b.severity] ?? 9) ||
      b.mostRecent.getTime() - a.mostRecent.getTime()
  );
  return groups;
}

/** Server-rendered, JS-free expandable list of aggregated issue groups. Uses
 *  <details>/<summary> so each group's affected URLs can be expanded without a
 *  client component. */
function SiteHealthIssueGroups({
  groups,
  now,
  defaultOpen,
  emptyLabel,
}: {
  groups: SiteHealthGroup[];
  now: number;
  defaultOpen: boolean;
  emptyLabel: string;
}) {
  if (groups.length === 0) {
    return <p className="px-6 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="divide-y divide-gray-100">
      {groups.map((group) => {
        const sevColor =
          group.severity === "ERROR"
            ? "text-red-700"
            : group.severity === "WARNING"
              ? "text-amber-700"
              : "text-muted-foreground";
        return (
          <details
            key={group.key}
            open={defaultOpen}
            className={`px-6 py-3 ${group.stale ? "opacity-60" : ""}`}
          >
            <summary className="cursor-pointer text-sm">
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 align-middle">
                <span className={`font-medium ${sevColor}`}>{group.severity}</span>
                <span className="font-mono text-xs text-muted-foreground">{group.source}</span>
                <span className="font-medium text-foreground">{group.issueType}</span>
                {group.message && <span className="text-muted-foreground">· {group.message}</span>}
                <span className="tabular-nums text-xs text-muted-foreground">
                  {fmt(group.count)} URL{group.count === 1 ? "" : "s"}
                </span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  last verified {formatStaleAge((now - group.mostRecent.getTime()) / 1000)} ago
                </span>
                {group.stale && (
                  <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    stale
                  </span>
                )}
              </span>
            </summary>
            <p className="mt-1 text-xs text-royal">Next step: {group.nextStep}</p>
            <ul className="mt-2 space-y-1">
              {group.urls.map((u, i) => {
                const snoozed = u.snoozedUntil != null && u.snoozedUntil.getTime() > now;
                return (
                  <li
                    key={`${u.url ?? "null"}-${i}`}
                    className={`flex flex-wrap items-center gap-x-3 text-xs ${snoozed ? "opacity-50" : ""}`}
                  >
                    {u.url ? (
                      <a
                        href={u.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="max-w-lg truncate font-mono text-royal hover:underline"
                      >
                        {u.url}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    <span className="tabular-nums text-muted-foreground">
                      {formatStaleAge((now - u.lastDetectedAt.getTime()) / 1000)} ago
                    </span>
                    {snoozed && u.snoozedUntil && (
                      <span className="text-muted-foreground">
                        snoozed until {formatDateOnly(u.snoozedUntil)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

async function SiteHealthTab() {
  const db = getCloudflareDb();
  const { getCurrentIssues } = await import("@/lib/site-health");
  const { getUnclassifiedOutboundDestinations } =
    await import("@/lib/url-classification-discovery");
  const { ClassifyDomainButtons } = await import("@/components/admin/classify-domain-buttons");
  const { SiteHealthSweepButton } = await import("@/components/admin/site-health-sweep-button");
  const { gscInspectionState } = await import("@/lib/db/schema");
  const { count: dCount } = await import("drizzle-orm");
  const [issues, unclassifiedDestinations, inspectionRow] = await Promise.all([
    getCurrentIssues(db, { hideSnoozed: false }),
    getUnclassifiedOutboundDestinations(db, { days: 7, minClicks: 5 }),
    db.select({ c: dCount() }).from(gscInspectionState),
  ]);
  const inspectionCount = inspectionRow[0]?.c ?? 0;
  const now = Date.now();
  const isActivelySnoozed = (snoozedUntil: Date | null | undefined) =>
    snoozedUntil != null && snoozedUntil.getTime() > now;
  const activeSnoozeCount = issues.filter((i) => isActivelySnoozed(i.snoozedUntil)).length;
  const isExpectedRow = (i: (typeof issues)[number]) =>
    isExpectedNonIndexing(i.issueType, i.message);
  // ACTION-tier counts drive the top-line cards so "open errors" reflects real
  // defects, not the expected non-indexing pile.
  const errorCount = issues.filter(
    (i) => i.severity === "ERROR" && !isExpectedRow(i) && !isActivelySnoozed(i.snoozedUntil)
  ).length;
  const warningCount = issues.filter(
    (i) => i.severity === "WARNING" && !isExpectedRow(i) && !isActivelySnoozed(i.snoozedUntil)
  ).length;
  const expectedCount = issues.filter(
    (i) => isExpectedRow(i) && !isActivelySnoozed(i.snoozedUntil)
  ).length;

  const groups = buildSiteHealthGroups(issues, now);
  const actionGroups = groups.filter((g) => g.tier === "ACTION");
  const expectedGroups = groups.filter((g) => g.tier === "EXPECTED");

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Action errors</p>
            <p className="text-3xl font-bold text-red-700 mt-1 tabular-nums">{fmt(errorCount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Action warnings</p>
            <p className="text-3xl font-bold text-amber-700 mt-1 tabular-nums">
              {fmt(warningCount)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Expected (non-indexing)</p>
            <p className="text-3xl font-bold text-muted-foreground mt-1 tabular-nums">
              {fmt(expectedCount)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">Snoozed</p>
            <p className="text-3xl font-bold text-muted-foreground mt-1 tabular-nums">
              {fmt(activeSnoozeCount)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Action needed</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Real defects — 5xx/fetch errors, broken structured data, sitemap errors, robots blocks.
            Near-identical rows are grouped; expand a group to see the affected URLs. Grey rows with
            a <span className="font-medium">stale</span> chip haven&apos;t been re-verified by the
            sweep in 14 days, so their open status is unconfirmed.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <SiteHealthIssueGroups
            groups={actionGroups}
            now={now}
            defaultOpen
            emptyLabel="No action-needed issues. Run the daily sweep to refresh."
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Expected (non-indexing)</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Normal GSC coverage states for thin / seasonal / duplicate pages (e.g. &quot;Discovered
            – currently not indexed&quot; on an off-season market page). Not defects — collapsed by
            default. Expand a group to review the URLs.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <SiteHealthIssueGroups
            groups={expectedGroups}
            now={now}
            defaultOpen={false}
            emptyLabel="No expected non-indexing rows."
          />
        </CardContent>
      </Card>

      <div className="mt-6 flex items-start justify-between flex-wrap gap-3 rounded-md border border-border bg-muted p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">URL Inspection sweep</p>
          <p className="text-xs text-muted-foreground mt-1">
            Inspects up to 8 URLs per click against GSC&apos;s URL Inspection API and persists
            verdicts to <code>gsc_inspection_state</code>. Drives the Google tab&apos;s &quot;real
            indexed&quot; count and detects new health issues. Each inspection takes 3-5 seconds;
            larger batches hit Cloudflare&apos;s 30s request timeout. Run repeatedly until inspected
            count stops growing (~250+ clicks for the full ~2,000-URL sitemap).
          </p>
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
            Currently inspected: {fmt(inspectionCount)} URLs
          </p>
        </div>
        <SiteHealthSweepButton />
      </div>

      <p className="text-xs text-muted-foreground mt-4">
        Snooze (temporary mute) and resolve (durable &quot;fixed&quot;) actions are exposed via the
        API endpoints under <code>/api/admin/site-health/*</code> and the{" "}
        <code>get_site_health_issues</code> / <code>snooze_site_health_issue</code> /{" "}
        <code>resolve_site_health_issue</code> MCP tools — use the group&apos;s fingerprint from{" "}
        <code>get_site_health_issues</code>. A resolved issue re-opens automatically if the sweep
        re-detects it.
      </p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Unclassified outbound destinations</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Domains that received outbound ticket clicks in the last 7 days but aren&apos;t in{" "}
            <code>url_domain_classifications</code> yet. Classify each one so the ingestion gate
            (see <code>src/lib/url-classification.ts</code>) knows whether it&apos;s a legitimate
            ticket destination, a promoter, an aggregator to block, etc.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
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
                  <td colSpan={4} className="px-6 py-6 text-muted-foreground">
                    No unclassified destinations with 5+ clicks in the last 7 days. The gate is
                    holding.
                  </td>
                </tr>
              ) : (
                unclassifiedDestinations.map((row) => (
                  <tr key={row.domain} className="align-top">
                    <td className="px-6 py-3 font-mono text-xs text-foreground break-all">
                      {row.domain}
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums font-medium">
                      {fmt(row.clicks)}
                    </td>
                    <td className="px-6 py-3 text-foreground break-all max-w-xs">
                      {row.sampleEventSlug ? (
                        <Link
                          href={`/events/${row.sampleEventSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-royal hover:underline font-mono text-xs"
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
