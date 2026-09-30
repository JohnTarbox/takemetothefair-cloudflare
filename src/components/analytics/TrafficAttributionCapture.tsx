"use client";

import { useEffect } from "react";
import { captureLandingAttribution } from "@/lib/analytics/traffic-attribution";

/**
 * OPE-1165 — records the landing page's traffic source (utm → referrer →
 * direct) once per tab session, before an internal navigation drops the utm_*
 * parameters. Outbound click beacons read it back. Renders nothing.
 */
export function TrafficAttributionCapture() {
  useEffect(() => {
    captureLandingAttribution();
  }, []);
  return null;
}
