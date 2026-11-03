/**
 * OPE-1496 — first-party click redirect for newsletter links to organizer sites.
 *
 * `/go/<kind>/<event-slug>?c=&s=&m=&l=` logs the click, then 302s to a
 * destination read from the EVENT RECORD. No request parameter can name the
 * destination, so the route cannot be used as an open redirect (cf. OPE-1378).
 *
 * The pure pieces live here so they are testable without a request context:
 * destination precedence, the scanner/prefetch classifier, and the event name
 * a row is written under.
 *
 * ── Why scanner rows get their OWN event name ────────────────────────────
 *
 * Corporate mail scanners (Safe Links, Proofpoint, Mimecast, Barracuda, Gmail's
 * proxy) fetch every link in a message before a person clicks. Every existing
 * conversion reader counts `outbound_ticket_click` / `outbound_application_click`
 * BY NAME (CONVERSION_EVENT_NAMES, the KPI badge, the organic numerator, the
 * engagement strip, per-event clicks). Writing a scanner hit under those names
 * would count prefetches as conversions on all of them. So a human click keeps
 * the shared name and every report picks it up unchanged; a scanner hit is kept
 * (so the filter can be audited) under `<name>_scanner`, with the same
 * properties and `source = 'redirect'`.
 */
import { classifyTrafficSource } from "@/lib/analytics/traffic-attribution";

export const GO_KINDS = ["apply", "tickets"] as const;
export type GoKind = (typeof GO_KINDS)[number];

export function isGoKind(v: string): v is GoKind {
  return (GO_KINDS as readonly string[]).includes(v);
}

export type ResolvedFrom =
  | "application_url"
  | "ticket_url"
  | "source_url"
  | "promoter_site"
  | "event_page"
  | "events_index";

export interface GoEventRow {
  slug: string;
  applicationUrl: string | null;
  ticketUrl: string | null;
  sourceUrl: string | null;
  promoterWebsite: string | null;
}

/** A stored URL is usable only if it parses and is http(s). A stored
 *  `javascript:` or relative value falls through to the next candidate. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Destination precedence — the same order the vendor digest links with today.
 *   apply:   application_url → source_url → promoter website → our event page
 *   tickets: ticket_url      → source_url → our event page
 * `origin` is our own site origin; the event page fallback is always on-site.
 */
export function resolveGoDestination(
  kind: GoKind,
  row: GoEventRow,
  origin: string
): { url: string; resolvedFrom: ResolvedFrom } {
  const candidates: Array<[string | null, ResolvedFrom]> =
    kind === "apply"
      ? [
          [row.applicationUrl, "application_url"],
          [row.sourceUrl, "source_url"],
          [row.promoterWebsite, "promoter_site"],
        ]
      : [
          [row.ticketUrl, "ticket_url"],
          [row.sourceUrl, "source_url"],
        ];
  for (const [raw, from] of candidates) {
    const url = safeHttpUrl(raw);
    if (url) return { url, resolvedFrom: from };
  }
  return { url: `${origin}/events/${row.slug}`, resolvedFrom: "event_page" };
}

/** User-agent fragments of link scanners, previewers and scripted clients.
 *  Lower-case substring match. Safe Links often sends a stock browser UA and
 *  cannot be caught this way — that is a known limit, not a bug. */
const SCANNER_UA_TOKENS = [
  "googleimageproxy",
  "bingpreview",
  "barracuda",
  "proofpoint",
  "mimecast",
  "symantec",
  "trendmicro",
  "forcepoint",
  "fireeye",
  "sophos",
  "microsoft office existence discovery",
  "ms-office",
  "outlook-iosandroid",
  "yahoomailproxy",
  "headlesschrome",
  "phantomjs",
  "python-requests",
  "python-urllib",
  "go-http-client",
  "okhttp",
  "java/",
  "curl/",
  "wget/",
  "libwww",
  "httpclient",
  "bot",
  "crawler",
  "spider",
  "preview",
  "scanner",
];

export interface UaClassification {
  uaClass: "human" | "scanner";
  /** Why it was called a scanner — kept on the row so the filter is auditable. */
  uaReason: string | null;
}

export function classifyGoRequest(input: {
  method: string;
  userAgent: string | null;
  /** `Sec-Purpose` or `Purpose` header — browsers send `prefetch` on speculative loads. */
  purpose: string | null;
}): UaClassification {
  if (input.method.toUpperCase() === "HEAD") return { uaClass: "scanner", uaReason: "head" };
  if (input.purpose && /prefetch|prerender/i.test(input.purpose)) {
    return { uaClass: "scanner", uaReason: "prefetch" };
  }
  const ua = (input.userAgent ?? "").trim().toLowerCase();
  if (!ua) return { uaClass: "scanner", uaReason: "empty-ua" };
  const hit = SCANNER_UA_TOKENS.find((t) => ua.includes(t));
  if (hit) return { uaClass: "scanner", uaReason: `ua:${hit}` };
  return { uaClass: "human", uaReason: null };
}

const MAX_PARAM_CHARS = 100;

function param(v: string | null): string | null {
  const t = v?.trim();
  return t ? t.slice(0, MAX_PARAM_CHARS) : null;
}

/**
 * Campaign / source / medium / label from the `/go/` query. Source and medium
 * go through the SAME classifier as the on-site beacon (as utm_source /
 * utm_medium, no referrer), so a missing pair reads `(direct)` / `(none)` and
 * a half pair reads `(not set)` — and the OPE-1165 attribution probe never
 * sees a redirect click without a medium.
 */
export function readGoParams(search: URLSearchParams): {
  campaign: string | null;
  trafficSource: string;
  trafficMedium: string;
  linkLabel: string | null;
} {
  const s = param(search.get("s"));
  const m = param(search.get("m"));
  const utm = new URLSearchParams();
  if (s) utm.set("utm_source", s);
  if (m) utm.set("utm_medium", m);
  const attribution = classifyTrafficSource({
    search: `?${utm.toString()}`,
    referrer: "",
    selfHost: "",
  });
  return {
    campaign: param(search.get("c")),
    trafficSource: attribution.source,
    trafficMedium: attribution.medium,
    linkLabel: param(search.get("l")),
  };
}

export const GO_CLICK_EVENT_NAME: Record<GoKind, string> = {
  apply: "outbound_application_click",
  tickets: "outbound_ticket_click",
};

/** The row's event name: the shared conversion name for a person, a
 *  `_scanner` sibling for a scanner (see the module note). */
export function goEventName(kind: GoKind, uaClass: UaClassification["uaClass"]): string {
  const base = GO_CLICK_EVENT_NAME[kind];
  return uaClass === "scanner" ? `${base}_scanner` : base;
}
