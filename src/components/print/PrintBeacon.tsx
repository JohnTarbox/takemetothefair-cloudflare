"use client";

import { useEffect, useRef } from "react";
import { trackPrintSheet, type PrintEntityType } from "@/lib/analytics";

interface PrintBeaconProps {
  entityType: PrintEntityType;
  entityId: string;
  entitySlug: string;
}

/**
 * PRINT2 (Dev-Email-2026-06-09 §C, 2026-06-09) — print-sheet engagement
 * beacon. Listens on `window.beforeprint` so it captures both the in-page
 * Print button AND keyboard shortcuts (Ctrl+P / Cmd+P), which the older
 * paper-carrying fairs audience the sheet was built for actually use.
 *
 * Why a separate client component rather than wiring the existing
 * PrintButton's onClick:
 *
 *   1. PrintEventSheet is a server component (no `"use client"` directive
 *      at the top). The beacon helper calls `window.gtag` and
 *      `navigator.sendBeacon` so it has to run client-side. Putting the
 *      beacon in PrintEventSheet would force the whole sheet client.
 *   2. PrintButton's onClick only fires when the user clicks the button.
 *      `beforeprint` fires for keyboard shortcuts too, which matters.
 *
 * Why the `fired` ref guard: browsers fire `beforeprint` once per print-
 * dialog open. A user who opens the dialog, cancels, and reopens would
 * inflate the counter without it.
 *
 * Mount alongside DetailPageTracker / ScrollDepthTracker on event detail
 * pages — same lifecycle, same client-component pattern.
 */
export function PrintBeacon({ entityType, entityId, entitySlug }: PrintBeaconProps) {
  const fired = useRef(false);

  useEffect(() => {
    const handler = () => {
      if (fired.current) return;
      fired.current = true;
      trackPrintSheet(entityType, entityId, entitySlug);
    };
    window.addEventListener("beforeprint", handler);
    return () => window.removeEventListener("beforeprint", handler);
  }, [entityType, entityId, entitySlug]);

  return null;
}
