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
  type RollingClicksPoint,
} from "@/lib/charts/echarts-options";

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

export function MilestoneEChart({
  points,
  rolling = [],
}: {
  points: MilestoneChartPoint[];
  /** The trailing 28-day click total, drawn as the line the milestone dots sit on. */
  rolling?: RollingClicksPoint[];
}) {
  const build = useCallback(
    (ctx: ChartCtx) => milestoneChartOption(points, ctx, rolling),
    [points, rolling]
  );
  if (points.length === 0) return <Empty text="No milestones to plot yet." />;
  return (
    <>
      <EChart buildOption={build} height={260} ariaLabel="Search clicks milestone growth chart" />
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
