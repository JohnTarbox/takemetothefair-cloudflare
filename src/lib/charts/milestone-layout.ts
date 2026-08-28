/**
 * OPE-602 — layout maths for the "Search clicks milestones" chart.
 *
 * ── Why this is a module and not inline JSX ───────────────────────────────
 * The defects this fixes are all arithmetic — label slots narrower than the
 * labels in them, a label box crossing the viewBox edge, a y-axis with no
 * ticks. None of that is testable while it lives inside the SVG markup, and
 * "the chart looks wrong" is exactly the class of bug that comes back because
 * nobody could write a test for it.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 * Root cause: `<svg viewBox="0 0 800 220" preserveAspectRatio="none"
 * class="w-full h-56">`. Width fluid, height pinned at 224px, axes free to
 * scale independently — so every glyph and dot was anisotropically distorted,
 * and the distortion CHANGED WITH THE WINDOW. Measured on the live panel:
 *
 *   container 1151px -> scaleX 1.439 / scaleY 1.018  (glyphs 1.41x too wide)
 *   container  380px -> scaleX 0.415 / scaleY 1.018  (squeezed unreadable)
 *
 * `<circle r="4">` painted an 11.5 x 8.1px ELLIPSE on desktop. The fix is in
 * the component (aspect-ratio box + `xMidYMid meet`); the arithmetic below
 * fixes the rest.
 */

/** A plotted milestone. `derived` = we inferred the crossing, Google did not award it. */
export interface MilestonePoint {
  threshold: number;
  emailDate: string;
  derived?: boolean;
}

export interface MilestoneChartDims {
  width: number;
  height: number;
  padTop: number;
  padBottom: number;
  padLeft: number;
  padRight: number;
}

export const MILESTONE_CHART_DIMS: MilestoneChartDims = {
  width: 800,
  height: 220,
  padTop: 28,
  padBottom: 36,
  padLeft: 12,
  padRight: 12,
};

/** Font size of the on-point value labels, in user units. */
export const VALUE_LABEL_FONT_PX = 11;

/**
 * Approximate rendered width of a label, in user units.
 *
 * A deliberate approximation: SVG text cannot be measured server-side, and the
 * alternative — rendering then measuring in the browser — is what the current
 * chart effectively does by not checking at all. 0.62em per character is a
 * standard average for the digits-and-comma set this chart draws, and the
 * measured case corroborates it: `"13,000"` at 11px measured **37.2** user
 * units live, and 6 chars x 11 x 0.62 = 40.9 — slightly conservative, which is
 * the correct direction to be wrong in for a collision test.
 */
export function approxLabelWidth(label: string, fontPx = VALUE_LABEL_FONT_PX): number {
  return label.length * fontPx * 0.62;
}

export interface MilestoneCoord {
  x: number;
  y: number;
  threshold: number;
  emailDate: string;
  derived: boolean;
  /** Whether to draw this point's value label (see `labelStride`). */
  showLabel: boolean;
  /** Anchor chosen so the label box never crosses the viewBox edge. */
  labelAnchor: "start" | "middle" | "end";
}

export interface MilestoneLayout {
  coords: MilestoneCoord[];
  /** Every Nth point carries a label; 1 = all of them. */
  labelStride: number;
  /** Log-scale y gridlines: value + pixel y. */
  ticks: { value: number; y: number }[];
  linePath: string;
  areaPath: string;
  dateLabelIndices: number[];
}

/**
 * Choose how many points to skip between value labels.
 *
 * The collision was STRUCTURAL, not incidental: 25 points across 776 usable
 * units puts them 32.33 apart, while `"13,000"` needs ~37. Any label of 5+
 * characters is wider than its own slot, so overlap was guaranteed for every
 * milestone from 9,000 up — four measured collisions of 3-7px each.
 *
 * Striding is preferred over shrinking the font (unreadable at 380px) or
 * rotating the labels (a diagonal number is harder to read than a missing
 * one). The widest label in the series sets the stride, so the answer holds
 * for the whole chart rather than for the point that happened to be checked.
 */
export function computeLabelStride(
  labels: string[],
  stepX: number,
  fontPx = VALUE_LABEL_FONT_PX
): number {
  if (labels.length <= 1 || stepX <= 0) return 1;
  const widest = Math.max(...labels.map((l) => approxLabelWidth(l, fontPx)));
  // +2 user units of breathing room so adjacent labels don't touch.
  return Math.max(1, Math.ceil((widest + 2) / stepX));
}

/**
 * Log-scale tick values spanning the plotted range.
 *
 * Defect 4: the subtitle promised "log scale" and the plot had ONE baseline
 * rule and no ticks, so nothing let a reader take a value off the curve — the
 * line was decorative and the printed point labels were the only data. Powers
 * of ten (with a 5x midpoint when the span is narrow) are the natural ticks
 * for a log axis and keep the count small.
 */
export function computeLogTicks(min: number, max: number): number[] {
  const lo = Math.max(1, min);
  const hi = Math.max(lo, max);
  const ticks: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    const base = Math.pow(10, e);
    if (base >= lo && base <= hi) ticks.push(base);
    const half = base * 5;
    if (half >= lo && half <= hi) ticks.push(half);
  }
  // A range entirely inside one decade would otherwise render no ticks at all.
  if (ticks.length === 0) return [lo, hi];
  return ticks.sort((a, b) => a - b);
}

/**
 * Full layout for the chart. Pure — no DOM, no I/O.
 *
 * `formatValue` is injected rather than imported so the label-width maths sees
 * exactly the strings the SVG will draw. A stride computed against `13000` and
 * a label reading `"13,000"` would be off by the two commas, which is the
 * whole margin at issue.
 */
export function computeMilestoneLayout(
  points: MilestonePoint[],
  formatValue: (n: number) => string,
  dims: MilestoneChartDims = MILESTONE_CHART_DIMS
): MilestoneLayout {
  const { width, height, padTop, padBottom, padLeft, padRight } = dims;
  const plotHeight = height - padTop - padBottom;
  const baselineY = height - padBottom;

  if (points.length === 0) {
    return {
      coords: [],
      labelStride: 1,
      ticks: [],
      linePath: "",
      areaPath: "",
      dateLabelIndices: [],
    };
  }

  const stepX = points.length > 1 ? (width - padLeft - padRight) / (points.length - 1) : 0;

  // Log-linear y, unchanged from K12 (2026-06-16): a linear axis crushes the
  // early milestones — with a 1000-click max the 20-40 starting points sit at
  // <4% of the plot height and the growth SHAPE is unreadable.
  const logVals = points.map((p) => Math.log(Math.max(1, p.threshold)));
  const logMax = Math.max(...logVals);
  const logMinRaw = Math.min(...logVals);
  const logSpan = logMax - logMinRaw || 1;
  const logMin = logMinRaw - logSpan * 0.08;
  const yFor = (threshold: number) =>
    padTop + plotHeight * (1 - (Math.log(Math.max(1, threshold)) - logMin) / (logMax - logMin));

  const labels = points.map((p) => formatValue(p.threshold));
  const labelStride = computeLabelStride(labels, stepX);

  const coords: MilestoneCoord[] = points.map((p, i) => {
    const x = padLeft + i * stepX;
    const isLast = i === points.length - 1;
    // Always label the last point: it is the headline number, and dropping it
    // to satisfy a stride would hide the most important value on the chart.
    const showLabel = i % labelStride === 0 || isLast;

    // Defect 2 — clipping. `"13,000"` centred on the final dot at x=788 put
    // its right edge at 806.6 in an 800-wide viewBox, so it rendered "13,00".
    // Anchoring by proximity to the edge keeps every label inside the box
    // without adding padding that would shrink the plot.
    const half = approxLabelWidth(labels[i]) / 2;
    const labelAnchor: "start" | "middle" | "end" =
      x + half > width - padRight ? "end" : x - half < padLeft ? "start" : "middle";

    return {
      x,
      y: yFor(p.threshold),
      threshold: p.threshold,
      emailDate: p.emailDate,
      derived: Boolean(p.derived),
      showLabel,
      labelAnchor,
    };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const areaPath =
    `${linePath} L ${coords[coords.length - 1].x} ${baselineY} ` +
    `L ${coords[0].x} ${baselineY} Z`;

  const thresholds = points.map((p) => p.threshold);
  const ticks = computeLogTicks(Math.min(...thresholds), Math.max(...thresholds)).map((value) => ({
    value,
    y: yFor(value),
  }));

  const dateLabelIndices = Array.from(
    new Set(coords.length <= 1 ? [0] : [0, Math.floor((coords.length - 1) / 2), coords.length - 1])
  );

  return { coords, labelStride, ticks, linePath, areaPath, dateLabelIndices };
}
