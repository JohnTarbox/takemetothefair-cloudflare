// OPE-1565 / OPE-1403: the server-side resolve target for the `echarts/*`
// entry points (see `turbopack.resolveAlias` in next.config.mjs). Charts
// render only in the browser, so this module is never executed on the server.
// Turbopack checks named imports at build time, so it declares every name
// src/components/admin/charts/echarts-core.ts imports. Add a name here when
// that file imports a new one, or the build fails with "Export X doesn't exist".
export const use = undefined;
export const LineChart = undefined;
export const GridComponent = undefined;
export const LegendComponent = undefined;
export const TooltipComponent = undefined;
export const LabelLayout = undefined;
export const SVGRenderer = undefined;
