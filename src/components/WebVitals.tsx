"use client";

import { useEffect } from "react";
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";
import type { Metric } from "web-vitals";

function sendToGA4(metric: Metric) {
  if (typeof window === "undefined" || !window.gtag) return;

  window.gtag("event", metric.name, {
    // Use the metric value rounded to avoid decimal noise
    value: Math.round(metric.name === "CLS" ? metric.value * 1000 : metric.value),
    event_category: "Web Vitals",
    event_label: metric.id,
    // Send as non-interaction so it doesn't affect bounce rate
    non_interaction: true,
  });
}

export function WebVitals() {
  useEffect(() => {
    onCLS(sendToGA4);
    onFCP(sendToGA4);
    onINP(sendToGA4);
    onLCP(sendToGA4);
    onTTFB(sendToGA4);
  }, []);

  return null;
}
