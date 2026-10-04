/**
 * OPE-1270 — what "healthy" means for a VENDOR's website, which is not what it
 * means for an organizer's.
 *
 * `classifyUrlHealth` was written for organizer pages: `ok` requires EVENT
 * signals (a month, a year, "admission"), because an organizer site that stops
 * talking about its fair is the repurposed-domain case. A crafter's shop, a
 * roofer, a bank has no fair dates on it at all — so run unchanged over vendor
 * sites, nearly every healthy one would read `no_event_signal`. The base
 * classifier is reused for everything it gets right (reachability, status
 * codes, closure notices); only the event-signal clause is replaced.
 *
 * Vendor verdicts, in precedence order:
 *
 *   unreachable / http_error / closure_notice — the base classifier's, unchanged
 *   domain_takeover — the OPE-988 detector, unchanged, on a 2xx body
 *   empty_page      — 2xx with < MIN_MEANINGFUL_TEXT visible chars. Recorded,
 *                     NOT queued: from a Worker this is usually a bot wall in
 *                     front of a live site (OPE-1281 measured it), not a
 *                     parked domain, so it is evidence of "could not see"
 *   moved           — 2xx, but redirects landed on ANOTHER registrable domain:
 *                     baystatesavingsbank.com → baystatebank.com. A plain up/down
 *                     check calls that healthy; the stored link is stale anyway
 *   ok              — 2xx with real content, on the domain we stored
 *
 * Name drift (name-drift.ts) is reported ALONGSIDE the verdict, not as one: a
 * site can be perfectly healthy and still call the business something else.
 */
import {
  classifyUrlHealth,
  visibleText,
  MIN_MEANINGFUL_TEXT,
  type UrlHealthInput,
} from "./url-health";
import { detectDomainTakeover, registrable } from "./domain-takeover";
import { detectNameDrift, type NameDrift } from "./name-drift";

export type VendorSiteVerdict =
  | "ok"
  | "unreachable"
  | "http_error"
  | "closure_notice"
  | "domain_takeover"
  | "empty_page"
  | "moved";

export interface VendorSiteResult {
  verdict: VendorSiteVerdict;
  signals: string[];
  detail: string;
  nameDrift: NameDrift;
}

export function classifyVendorSite(
  probe: UrlHealthInput & { finalUrl?: string | null },
  ctx: { requestedUrl: string; businessName: string | null }
): VendorSiteResult {
  const unknownDrift: NameDrift = { drift: null, declared: [] };
  const base = classifyUrlHealth(probe);
  if (
    base.verdict === "unreachable" ||
    base.verdict === "http_error" ||
    base.verdict === "closure_notice"
  ) {
    return {
      verdict: base.verdict,
      signals: base.signals,
      detail: base.detail,
      nameDrift: unknownDrift,
    };
  }

  // 2xx from here on.
  const html = probe.html ?? "";
  const nameDrift = detectNameDrift(ctx.businessName, html);
  const driftSignals =
    nameDrift.drift === true ? [`name-drift:${nameDrift.declared.join(" | ").slice(0, 120)}`] : [];

  const takeover = detectDomainTakeover(html, {
    entityName: ctx.businessName,
    requestedUrl: ctx.requestedUrl,
    finalUrl: probe.finalUrl,
    // OPE-1281 rework — a company blog is not impersonation.
    entityKind: "vendor",
  });
  if (takeover.takenOver) {
    return {
      verdict: "domain_takeover",
      signals: [...takeover.signals, ...driftSignals],
      detail: takeover.detail,
      nameDrift,
    };
  }

  const chars = visibleText(html).length;
  if (chars < MIN_MEANINGFUL_TEXT) {
    return {
      verdict: "empty_page",
      signals: driftSignals,
      detail: `200 but only ${chars} chars of visible text`,
      nameDrift,
    };
  }

  const from = registrable(ctx.requestedUrl);
  const to = registrable(probe.finalUrl);
  if (from && to && from !== to) {
    return {
      verdict: "moved",
      signals: [`cross-domain-redirect:${to}`, ...driftSignals],
      detail: `redirected to another domain: ${probe.finalUrl}`,
      nameDrift,
    };
  }

  return {
    verdict: "ok",
    signals: driftSignals,
    detail: nameDrift.drift
      ? `200, ${chars} chars; site names itself ${nameDrift.declared.join(" | ").slice(0, 120)}`
      : `200, ${chars} chars`,
    nameDrift,
  };
}
