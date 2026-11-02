"use client";

/**
 * OPE-1565 — the admin charts, as client components that take ONLY
 * serializable props (a Server Component page cannot pass a formatter
 * function). Each renders an empty state for `[]` rather than handing ECharts
 * nothing (OPE-242 — the empty-collection family).
 */
import { useCallback } from "react";
import { EChart } from "./EChart";
import {
  accuracyOption,
  dailyViewsOption,
  milestoneChartOption,
  type AccuracyBucket,
  type ChartCtx,
  type DailyViewsPoint,
  type MilestoneChartPoint,
} from "@/lib/charts/echarts-options";

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

export function MilestoneEChart({ points }: { points: MilestoneChartPoint[] }) {
  const build = useCallback((ctx: ChartCtx) => milestoneChartOption(points, ctx), [points]);
  if (points.length === 0) return <Empty text="No milestones to plot yet." />;
  return (
    <>
      <EChart buildOption={build} height={260} ariaLabel="Search clicks milestone growth chart" />
      {/* OPE-602 defect 3 / OPE-1565 — stated, not hidden: the points are
          evenly spaced by milestone. 10 of the 42 plotted dates on 2026-11-02
          had no independent source, so date-spacing would look more precise
          than the data is. */}
      <p className="mt-1 text-xs text-muted-foreground">
        Points are evenly spaced by milestone, not by date. Hover a point for its date.
      </p>
    </>
  );
}

export function DailyViewsEChart({ rows }: { rows: DailyViewsPoint[] }) {
  const build = useCallback((ctx: ChartCtx) => dailyViewsOption(rows, ctx), [rows]);
  if (rows.length === 0) return <Empty text="No page views in this window." />;
  return <EChart buildOption={build} height={220} ariaLabel="Daily page views chart" />;
}

export function AccuracyEChart({
  buckets,
  versions,
}: {
  buckets: AccuracyBucket[];
  versions: string[];
}) {
  const build = useCallback(
    (ctx: ChartCtx) => accuracyOption(buckets, versions, ctx),
    [buckets, versions]
  );
  if (buckets.length === 0) {
    return <Empty text="No classified emails in this window yet." />;
  }
  return <EChart buildOption={build} height={280} ariaLabel="Classifier accuracy trend" />;
}
