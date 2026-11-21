/**
 * OPE-1565 — the ONLY module that imports `echarts`. Modular: just the line
 * chart, the cartesian grid (which brings the category/value/log axes), the
 * tooltip, the legend, label collision layout, and the SVG renderer.
 *
 * Loaded with a dynamic `import()` from `EChart.tsx` inside an effect, so it is
 * never evaluated during server rendering and lands in its own client chunk
 * fetched only by admin pages that mount a chart.
 */
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  LabelLayout,
  SVGRenderer,
]);

export { echarts };
