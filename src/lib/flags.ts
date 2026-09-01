// Server-read feature flags. Pattern mirrors src/lib/faq-pilot.ts:
// prefer the Cloudflare binding (wrangler.toml [vars]); fall back to process.env
// for local/dev. Unset/anything-but-true ⇒ OFF.

import { getCloudflareContext } from "@opennextjs/cloudflare";

function readVar(name: string): string | undefined {
  try {
    return (getCloudflareContext().env as unknown as Record<string, string | undefined>)[name];
  } catch {
    return process.env[name];
  }
}

function isOn(name: string): boolean {
  const raw = readVar(name);
  return raw === "true" || raw === "1";
}

/**
 * CAL1 — when ON, `/events?view=calendar` server-renders the new @jonnyboats Month
 * calendar instead of the legacy client calendar. Default OFF: live `/events` is
 * unchanged until this is flipped (per-env via wrangler.toml [vars] / dashboard).
 */
export function isCal1SsrMonthEnabled(): boolean {
  return isOn("CAL1_SSR_MONTH");
}

/**
 * CAL2 — when ON (and CAL1 is also ON), the SSR calendar gains the Agenda and Year
 * sub-views via a sub-view toggle (`?cal_view=month|agenda|year`). Default OFF →
 * the calendar shows Month only, exactly as CAL1 shipped. Requires CAL1 (the new
 * views live inside the SSR calendar path; with CAL1 OFF the legacy client calendar
 * renders and this flag has no effect).
 */
export function isCal2ViewsEnabled(): boolean {
  return isOn("CAL2_VIEWS");
}

/**
 * OPE-738 — when ON, `/fair-entry-deadlines` serves the cross-event exhibitor
 * entry-deadline index. Default OFF: the route 404s exactly as it does today.
 *
 * This is a STOP gate made structural rather than a note in a ticket, the same
 * reasoning as VENDOR_DIGEST_SEND_ENABLED and CONDITIONAL_GET_PUBLIC_CACHE.
 * OPE-738 requires issue-level approval before a NEW customer-facing surface
 * goes live, so the code ships and deploys dark and only John flips it. It must
 * be flipped in wrangler.toml, never the dashboard — a dashboard [vars]
 * override is silently wiped by the next deploy (OPE-284/OPE-509), which for an
 * OFF-by-default gate at least fails safe.
 */
export function isEntryDeadlinesIndexEnabled(): boolean {
  return isOn("ENTRY_DEADLINES_INDEX");
}
