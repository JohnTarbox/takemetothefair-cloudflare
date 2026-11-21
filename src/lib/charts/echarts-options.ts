/**
 * OPE-1565 — ECharts option builders for the admin charts.
 *
 * Pure functions over serializable data, so the rules the acceptance names are
 * testable without a DOM or a canvas:
 *   - every text size is a fixed pixel size ≥ 10 (never viewBox-scaled — the
 *     hand-rolled SVG rendered 11px as ~5px on a 380px phone);
 *   - label collisions are the library's job (`labelLayout.hideOverlap`,
 *     `axisLabel.hideOverlap`), not hand-written stride/anchor arithmetic,
 *     which broke every time the milestone series grew (OPE-602 → OPE-1565);
 *   - hollow vs solid dots keep OPE-456's derived-vs-awarded distinction.
 *
 * Deliberately NO `echarts` import here: the option is plain data plus
 * formatter callbacks, and this module must stay cheap to import from tests.
 * The data passed in is already formatted on the server (date labels are
 * strings), because a Server Component cannot hand a function to a client one.
 */

export interface ChartCtx {
  /** Container narrower than ~480px. */
  narrow: boolean;
  dark: boolean;
  fontFamily?: string;
}

/** The smallest text any admin chart draws, in CSS px. */
export const MIN_CHART_FONT_PX = 10;

export function chartPalette(dark: boolean) {
  return dark
    ? {
        text: "#d1d5db",
        muted: "#9ca3af",
        grid: "#374151",
        line: "#60a5fa",
        area: "rgba(96,165,250,0.15)",
        hollow: "#111827",
      }
    : {
        text: "#111827",
        muted: "#6b7280",
        grid: "#f3f4f6",
        line: "#2563eb",
        area: "rgba(219,234,254,0.6)",
        hollow: "#ffffff",
      };
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtCompact = (n: number) =>
  n >= 1000 ? `${Number((n / 1000).toFixed(n % 1000 === 0 ? 0 : 1))}K` : String(n);

function baseText(ctx: ChartCtx) {
  const p = chartPalette(ctx.dark);
  return {
    textStyle: { fontFamily: ctx.fontFamily ?? "inherit", fontSize: 11, color: p.text },
  };
}

/** Smallest of 1/2/5 × 10^k at or above `v`. Log-axis headroom without 2× waste. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const k = Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) {
    const c = m * 10 ** k;
    if (c >= v) return c;
  }
  return 10 ** (k + 1);
}

// ── Search clicks milestones ──────────────────────────────────────────────

const SYMBOL_SIZE = 8;
/** Larger than SYMBOL_SIZE on purpose — see the hideOverlap note in the series. */
export const LAST_SYMBOL_SIZE = 11;

export interface MilestoneChartPoint {
  threshold: number;
  /** ISO calendar date (YYYY-MM-DD) the milestone was reached — the x position. */
  date: string;
  /** Pre-formatted on the server ("Sep 19, 2026"). */
  dateLabel: string;
  /** True = crossing derived from our daily totals (hollow); false = Google badge. */
  derived: boolean;
}

/**
 * X axis is TIME (date-spaced). OPE-1565 first shipped it index-spaced because
 * 10 of the 42 plotted points (2026-11-02) carry a date nothing independent
 * establishes (2 NULL `reached_date`, 8 with `reached_date = email_date` and no
 * derived crossing). John ruled 2026-11-02 to date-space anyway: a few days of
 * error on those points is smaller than index spacing's distortion of the whole
 * curve (it put "Aug 8" at the midpoint of a May→Sep series).
 */
export interface RollingClicksPoint {
  /** YYYY-MM-DD — last day of the trailing 28-day window. */
  date: string;
  /** Clicks over the 28 days ending on `date`. */
  total: number;
  /** Pre-formatted on the server ("Oct 30, 2026"). */
  dateLabel: string;
}

export const MILESTONES_SERIES = "Milestones";
export const ROLLING_SERIES = "28-day clicks";

/**
 * Milestones as dots, sitting on the 28-day click total as the line.
 *
 * A milestone records only a NEW HIGH, so a milestones-only chart cannot show
 * a decline: after the 2026-09-20 peak (31,248) the 28-day total fell ~46% by
 * Oct 30 while the chart just stopped, reading as "no data since Sep 19". The
 * line is the measured series the derived milestones are computed from
 * (`rollingWindowTotals`, same skip-a-gap rule as `deriveCrossings`), so the
 * dots and the line cannot disagree. The milestone series draws no line of its
 * own — two near-identical lines would be noise.
 */
export function milestoneChartOption(
  points: MilestoneChartPoint[],
  ctx: ChartCtx,
  rolling: RollingClicksPoint[] = []
) {
  const p = chartPalette(ctx.dark);
  const values = [...points.map((x) => x.threshold), ...rolling.map((r) => r.total)].filter(
    (v) => v > 0
  );
  const maxV = values.reduce((m, v) => Math.max(m, v), 0);
  const minV = values.reduce((m, v) => Math.min(m, v), Number.POSITIVE_INFINITY);
  const last = points.length - 1;
  const lastRolling = rolling.length - 1;
  const labelSize = ctx.narrow ? 10 : 11;
  const hasRolling = rolling.length > 0;
  // The measured line, drawn first so the milestone dots sit on top of it.
  const rollingSeries = {
    name: ROLLING_SERIES,
    type: "line" as const,
    showSymbol: false,
    symbol: "circle",
    symbolSize: 4,
    lineStyle: { color: p.line, width: 2 },
    itemStyle: { color: p.line },
    areaStyle: { color: p.area },
    z: 1,
    data: rolling.map((r) => ({
      value: [r.date, r.total] as [string, number],
      dateLabel: r.dateLabel,
    })),
    // Where the total stands today — the number a milestones-only chart hid.
    // Far below and to the right of every milestone label, so it sits
    // outside their collision set without risk.
    endLabel: {
      show: hasRolling,
      fontSize: labelSize,
      fontWeight: 600,
      color: p.muted,
      formatter: () => (lastRolling >= 0 ? `${fmtCompact(rolling[lastRolling].total)} now` : ""),
    },
  };
  const milestonesSeries = {
    name: MILESTONES_SERIES,
    type: "line" as const,
    symbol: "circle",
    // Dots only: the line above is the series these milestones come from.
    lineStyle: { width: 0, opacity: 0 },
    itemStyle: { color: p.line },
    z: 2,
    data: points.map((x, i) => ({
      value: [x.date, x.threshold] as [string, number],
      dateLabel: x.dateLabel,
      derived: x.derived,
      // The headline (last) dot is drawn larger. ECharts' hideOverlap ranks
      // labels by their host symbol's AREA, so a bigger last dot guarantees
      // its label survives and the colliding neighbour is the one hidden.
      // (endLabel sat outside hideOverlap: live on 2026-11-03 it overprinted
      // 30,000, reached one day before 31,000.)
      symbolSize: i === last ? LAST_SYMBOL_SIZE : SYMBOL_SIZE,
      // OPE-456 — shape, not colour: hollow = derived, solid = Google badge.
      itemStyle: x.derived
        ? { color: p.hollow, borderColor: p.line, borderWidth: 2 }
        : { color: p.line, borderColor: p.line, borderWidth: 0 },
      // Above the dot, last one included: with the 28-day line running on
      // past the final milestone, a label to its RIGHT sat on the line.
      label: {
        show: true,
        position: "top" as const,
        // `minMargin` widens the rect hideOverlap tests (padding does not),
        // so labels that would merely butt together are thinned too —
        // "8,0009,000" was the live-data render without it.
        minMargin: 6,
        fontSize: i === last ? labelSize + 1 : labelSize,
        fontWeight: i === last ? 700 : 600,
        color: p.text,
        formatter: () => fmtInt(x.threshold),
      },
    })),
    labelLayout: { hideOverlap: true },
  };
  return {
    ...baseText(ctx),
    animation: false,
    legend: {
      show: hasRolling,
      top: 0,
      left: 0,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { fontSize: labelSize, color: p.muted },
      data: [ROLLING_SERIES, MILESTONES_SERIES],
    },
    grid: {
      left: 8,
      // containLabel ignores endLabel, so room for "16.7K now" is reserved here.
      right: hasRolling ? (ctx.narrow ? 64 : 76) : ctx.narrow ? 60 : 56,
      top: hasRolling ? 44 : 28,
      bottom: 8,
      containLabel: true,
    },
    tooltip: {
      trigger: "item" as const,
      textStyle: { fontSize: 12 },
      formatter: (params: {
        seriesName?: string;
        data?: { value: [string, number]; dateLabel: string; derived?: boolean };
      }) => {
        const d = params.data;
        if (!d) return "";
        if (params.seriesName === ROLLING_SERIES) {
          return `${fmtInt(d.value[1])} clicks in the 28 days to ${d.dateLabel}`;
        }
        return `${fmtInt(d.value[1])} clicks — ${d.dateLabel}<br/>${
          d.derived ? "Derived from our own daily totals" : "Badge awarded by Google"
        }`;
      },
    },
    xAxis: {
      type: "time" as const,
      splitNumber: ctx.narrow ? 4 : 8,
      axisLabel: { hideOverlap: true, fontSize: labelSize, color: p.muted, formatter: "{MMM} {d}" },
      splitLine: { show: false },
      axisLine: { lineStyle: { color: p.grid } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "log" as const,
      min: Number.isFinite(minV) ? 10 ** Math.floor(Math.log10(Math.max(minV, 1))) : 1,
      max: niceCeil(maxV * 1.2),
      axisLabel: {
        fontSize: labelSize,
        color: p.muted,
        showMaxLabel: false,
        formatter: (v: number) => fmtCompact(v),
      },
      splitLine: { lineStyle: { color: p.grid } },
    },
    // A fixed pair, not an array of a union: callers (and tests) index
    // series[0] / series[1] and need each one's own shape.
    series: [rollingSeries, milestonesSeries] as [typeof rollingSeries, typeof milestonesSeries],
  };
}

// ── Daily page views ──────────────────────────────────────────────────────

export interface DailyViewsPoint {
  /** Pre-formatted on the server. */
  dateLabel: string;
  views: number;
  users: number;
}

export function dailyViewsOption(rows: DailyViewsPoint[], ctx: ChartCtx) {
  const p = chartPalette(ctx.dark);
  const size = ctx.narrow ? 10 : 11;
  return {
    ...baseText(ctx),
    animation: false,
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis" as const,
      textStyle: { fontSize: 12 },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const r = rows[params[0]?.dataIndex ?? -1];
        return r ? `${r.dateLabel}<br/>${fmtInt(r.views)} views, ${fmtInt(r.users)} users` : "";
      },
    },
    xAxis: {
      type: "category" as const,
      data: rows.map((r) => r.dateLabel),
      boundaryGap: false,
      axisLabel: { hideOverlap: true, fontSize: size, color: p.muted },
      axisLine: { lineStyle: { color: p.grid } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value" as const,
      min: 0,
      axisLabel: { fontSize: size, color: p.muted, formatter: (v: number) => fmtCompact(v) },
      splitLine: { lineStyle: { color: p.grid, type: "dashed" as const } },
    },
    series: [
      {
        type: "line" as const,
        symbol: "circle",
        symbolSize: 5,
        showSymbol: rows.length <= 45,
        lineStyle: { color: p.line, width: 2 },
        itemStyle: { color: p.line },
        areaStyle: { color: p.area },
        data: rows.map((r) => r.views),
      },
    ],
  };
}

// ── Classifier accuracy trend ─────────────────────────────────────────────

export interface AccuracyBucket {
  weekStart: string;
  classifierVersion: string;
  total: number;
  disagreements: number;
  accuracyPct: number | null;
}

export const ACCURACY_LINE_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#ea580c",
  "#9333ea",
  "#0891b2",
];

/**
 * One series per classifier version, aligned on `weekStart`. The hand-rolled
 * chart positioned each version's points by ARRAY index, so a version that
 * started mid-window was drawn shifted left onto the wrong weeks; aligning on
 * the week fixes that as a side effect. A null accuracy (or a week a version
 * did not run) breaks the line, as before.
 */
export function accuracyOption(buckets: AccuracyBucket[], versions: string[], ctx: ChartCtx) {
  const p = chartPalette(ctx.dark);
  const size = ctx.narrow ? 10 : 11;
  const weeks = [...new Set(buckets.map((b) => b.weekStart))].sort();
  const byKey = new Map(buckets.map((b) => [`${b.classifierVersion}|${b.weekStart}`, b]));
  return {
    ...baseText(ctx),
    animation: false,
    color: ACCURACY_LINE_COLORS,
    grid: { left: 8, right: 16, top: 16, bottom: 36, containLabel: true },
    legend: {
      bottom: 0,
      type: "scroll" as const,
      textStyle: { fontSize: size, color: p.text },
    },
    tooltip: {
      trigger: "axis" as const,
      textStyle: { fontSize: 12 },
      formatter: (params: Array<{ seriesName: string; dataIndex: number; marker: string }>) => {
        const week = weeks[params[0]?.dataIndex ?? -1];
        if (!week) return "";
        const lines = params
          .map((s) => {
            const b = byKey.get(`${s.seriesName}|${week}`);
            if (!b || b.accuracyPct === null) return null;
            return `${s.marker}${s.seriesName}: ${b.accuracyPct}% (${b.total - b.disagreements}/${b.total})`;
          })
          .filter(Boolean);
        return [`Week of ${week}`, ...lines].join("<br/>");
      },
    },
    xAxis: {
      type: "category" as const,
      data: weeks.map((w) => w.slice(5)),
      boundaryGap: false,
      axisLabel: { hideOverlap: true, fontSize: size, color: p.muted },
      axisLine: { lineStyle: { color: p.grid } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value" as const,
      min: 0,
      max: 100,
      interval: 25,
      axisLabel: { fontSize: size, color: p.muted, formatter: "{value}%" },
      splitLine: { lineStyle: { color: p.grid, type: "dashed" as const } },
    },
    series: versions.map((v) => ({
      name: v,
      type: "line" as const,
      symbol: "circle",
      symbolSize: 6,
      connectNulls: false,
      data: weeks.map((w) => byKey.get(`${v}|${w}`)?.accuracyPct ?? null),
    })),
  };
}
