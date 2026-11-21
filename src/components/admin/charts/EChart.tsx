"use client";

/**
 * OPE-1565 — the one shared ECharts host for admin charts.
 *
 * - `echarts` is pulled in by a dynamic import inside an effect: never on the
 *   server (the Worker bundle must not grow) and never on a public page (only
 *   admin components import this file).
 * - Reserves its own height before the chart loads, so nothing shifts.
 * - Rebuilds the option on resize (narrow vs wide text/grid) and on theme
 *   change (next-themes `resolvedTheme`), so text stays fixed-pixel and
 *   legible in light and dark.
 */
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { ChartCtx } from "@/lib/charts/echarts-options";

const NARROW_PX = 480;

type EChartsInstance = {
  setOption: (option: unknown, opts?: { notMerge?: boolean }) => void;
  resize: () => void;
  dispose: () => void;
};

export function EChart({
  buildOption,
  height,
  ariaLabel,
}: {
  buildOption: (ctx: ChartCtx) => unknown;
  height: number;
  ariaLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const [width, setWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const { resolvedTheme } = useTheme();

  // Mount: load echarts, init once, track width.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth(w);
      chartRef.current?.resize();
    });
    ro.observe(host);
    import("./echarts-core").then(({ echarts }) => {
      if (disposed || !hostRef.current) return;
      chartRef.current = echarts.init(hostRef.current, undefined, {
        renderer: "svg",
      }) as unknown as EChartsInstance;
      setReady(true);
    });
    return () => {
      disposed = true;
      ro.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  // (Re)apply the option whenever the data, width class or theme changes.
  const narrow = width > 0 && width < NARROW_PX;
  const dark = resolvedTheme === "dark";
  useEffect(() => {
    if (!ready || !chartRef.current || !hostRef.current) return;
    const fontFamily = getComputedStyle(hostRef.current).fontFamily || undefined;
    chartRef.current.setOption(buildOption({ narrow, dark, fontFamily }), { notMerge: true });
  }, [ready, narrow, dark, buildOption]);

  return (
    <div ref={hostRef} role="img" aria-label={ariaLabel} className="w-full" style={{ height }} />
  );
}
