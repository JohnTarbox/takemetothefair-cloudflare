/**
 * A9 (2026-06-26) — edge request sampling to identify the recurring
 * 21st-of-month bot inflating GA4.
 *
 * The zone is on the FREE plan, so Cloudflare Logpush (the only CF-native
 * raw-User-Agent capture) is unavailable — it's Enterprise-only. Instead,
 * src/middleware.ts samples a small slice of public page requests at the edge
 * and records UA + IP + ASN + path here. The write is fire-and-forget via
 * ctx.waitUntil so it never blocks the response, and this module never throws —
 * sampling is best-effort observability.
 *
 * Read back the spike window (≈ the 21st) via GET /api/admin/request-samples,
 * which groups by (asn, as_organization, user_agent) so the high-volume bot
 * fingerprint stands out for a WAF Managed-Challenge rule + GA4 filter.
 */
import type { Database } from "@/lib/db";
import { requestSamples } from "@/lib/db/schema";
import { hasSessionCookie } from "@/lib/conditional-get";

/** Fraction of eligible requests captured. The bot is high-volume on the 21st
 *  (~11k requests on a fixed page set), so 5% still yields hundreds of bot rows
 *  while keeping normal-traffic writes modest on this low-traffic Free zone. */
export const REQUEST_SAMPLE_RATE = 0.05;

/**
 * OPE-971 — the stored IP is a NETWORK PREFIX, not the visitor's address:
 * IPv4 keeps its /24, IPv6 its /48.
 *
 * Decided by what reads it. The admin read route groups by ASN, AS
 * organization and User-Agent (plus path) and never selects `ip`; the A9
 * playbook's one IP use is a GA4 "define internal traffic" rule matching an IP
 * RANGE. A /24 serves both. The full address served neither, and was a raw
 * personal identifier held for 60 days. Rows written before 2026-09-13 carry
 * the full address and age out by 2026-11-12.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  const v = (ip ?? "").trim();
  if (!v) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.split(".").slice(0, 3).join(".") + ".0/24";
  }
  if (v.includes(":")) {
    const [head] = v.split("::");
    const groups = head.split(":").filter(Boolean);
    const prefix = [...groups, "0", "0", "0"].slice(0, 3).join(":");
    return `${prefix}::/48`;
  }
  return null;
}

/** Pure sampling gate — `rand` injected so the decision is testable. */
export function shouldSample(rand: number): boolean {
  return rand < REQUEST_SAMPLE_RATE;
}

/**
 * OPE-1397 (EXP5) — an /admin* request that carries `RSC` or
 * `Next-Router-State-Tree` and NO session cookie.
 *
 * That is the shape of the OPE-1365 probe: a client-supplied router state tree
 * telling the App Router the admin layout is already mounted, so only the page
 * segment renders and the layout's redirect never runs. Every admin page now
 * guards itself (requireAdmin), so such a request is refused — but it left no
 * trace, because the A9 sampler skips /admin. A signed-in admin always sends
 * the session cookie; a signed-out browser doing a client navigation inside
 * /admin is the only benign source, and it is rare.
 *
 * Recorded at 100% (not the 5% page rate): a single crafted request is the
 * event worth finding. Stores path, timestamp, CF country and ASN only — no
 * headers, no IP, no UA.
 *
 * ⚠️ Only meaningful on the RAW request: call it from the Worker entry
 * (src/worker/admin-rsc-sampler.ts) and nowhere else. Next deletes these
 * headers before middleware (web/adapter.js:137-146) and before `headers()` in
 * render (async-storage/request-store.js:33-38), so there it is always false.
 * Guarded by src/__tests__/middleware-no-flight-headers-ope1397.test.ts.
 */
export const ADMIN_RSC_ANON_KIND = "admin_rsc_anon" as const;

export function isAnonymousAdminRscRequest(
  pathname: string,
  headers: Pick<Headers, "get">
): boolean {
  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return false;
  const rsc = headers.get("rsc") !== null || headers.get("next-router-state-tree") !== null;
  if (!rsc) return false;
  return !hasSessionCookie(headers.get("cookie"));
}

export interface RequestSampleInput {
  /** Defaults to "page" (the A9 public-page sample). */
  kind?: "page" | typeof ADMIN_RSC_ANON_KIND;
  path?: string | null;
  method?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  asn?: number | null;
  asOrganization?: string | null;
  country?: string | null;
  referer?: string | null;
  ray?: string | null;
}

/**
 * Insert one sampled request. Never throws.
 *
 * OPE-971 — this no longer prunes. Retention (REQUEST_SAMPLE_RETENTION_DAYS)
 * is enforced by the MCP daily cron, mcp-server/src/request-sample-retention.ts,
 * which runs whether or not anything is being sampled and reports what it did.
 */
export async function writeRequestSample(
  db: Database,
  input: RequestSampleInput,
  opts: { now?: Date } = {}
): Promise<void> {
  const now = opts.now ?? new Date();
  try {
    await db.insert(requestSamples).values({
      timestamp: now,
      kind: input.kind ?? "page",
      path: input.path ?? null,
      method: input.method ?? null,
      userAgent: input.userAgent ?? null,
      ip: truncateIp(input.ip),
      asn: input.asn ?? null,
      asOrganization: input.asOrganization ?? null,
      country: input.country ?? null,
      referer: input.referer ?? null,
      ray: input.ray ?? null,
    });
  } catch {
    // best-effort — must never surface to the request path.
  }
}
