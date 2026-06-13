/**
 * Vendor-site fetch for the enrichment Worker (I1, 2026-06-13).
 *
 * Thin wrapper over the shared A5 path (@takemetothefair/site-fetch): SSRF
 * guard → standard fetch → Browser-Rendering escalation on 401/403/429/
 * timeout. The vendor `website` is operator-curated (lower risk than arbitrary
 * user input), but the guard is cheap defense-in-depth.
 */
import {
  fetchWithEscalation,
  isBlockedSsrfHost,
  type BrowserRenderingEnv,
} from "@takemetothefair/site-fetch";

export interface SiteFetchResult {
  ok: boolean;
  html: string | null;
  /** 'standard' | 'browser-rendering' | 'failed' */
  fetchMethod: "standard" | "browser-rendering" | "failed";
  /** Post-redirect URL from the standard path, when available. */
  finalUrl?: string;
  /** Short reason on failure, for enrichment_log notes. */
  failReason?: string;
}

/**
 * Fetch a vendor website, escalating to Browser Rendering when a WAF blocks
 * the plain fetch. Returns html=null with a failReason on any miss (including
 * a blocked/invalid URL) — the caller marks the attempt + moves on; a dead
 * site is itself a signal, never a throw.
 */
export async function fetchVendorSite(
  rawUrl: string,
  env: BrowserRenderingEnv
): Promise<SiteFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, html: null, fetchMethod: "failed", failReason: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, html: null, fetchMethod: "failed", failReason: "bad-protocol" };
  }
  if (isBlockedSsrfHost(parsed.hostname)) {
    return { ok: false, html: null, fetchMethod: "failed", failReason: "ssrf-blocked" };
  }

  const result = await fetchWithEscalation(parsed.href, env);
  if (result.html != null) {
    return {
      ok: true,
      html: result.html,
      fetchMethod: result.fetchMethod,
      finalUrl: result.finalUrl,
    };
  }
  const reason =
    result.escalated && !result.escalated.ok
      ? `standard=${result.standard.ok ? "ok" : result.standard.error}|br=${result.escalated.error}`
      : result.standard.ok
        ? "unknown"
        : result.standard.error;
  return { ok: false, html: null, fetchMethod: "failed", failReason: reason };
}
