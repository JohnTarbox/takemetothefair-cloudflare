export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { trackServerEvent } from "@/lib/server-analytics";
import {
  parseGaClientId,
  safeHostname,
  sendGa4MeasurementProtocol,
} from "@/lib/ga4-measurement-protocol";
import { trackClaimViewServer } from "@/lib/analytics/claim-funnel";

const MAX_BODY_BYTES = 4_000;
const MAX_PROPERTY_BYTES = 2_000;

// Allowlist of event names accepted from the client beacon.
// Anything outside this set is rejected with 400, preventing free-form spam.
// Add new names here when wiring new instrumentation.
const ALLOWED_EVENT_NAMES = [
  "outbound_application_click",
  "outbound_ticket_click",
  "filter_applied",
  "internal_search_performed",
  // BC2 (2026-06-08) — blog → listing click attribution. Beacon side
  // captured in D1 immediately; GA4 side surfaces source_slug/target_type/
  // target_slug as custom dimensions after John registers them per
  // docs/bc2-ga4-custom-dimensions.md.
  "blog_outbound_click",
  // ENG1.3 (2026-06-09) — segmented form-submit events. Only the two
  // audiences without existing GA4 coverage are mirrored to the beacon;
  // suggest_event_* / vendor_application_submit already have GA4-side
  // visibility via the legacy event_suggest / vendor_apply dual-emit.
  "newsletter_submit",
  "vendor_claim_submit",
  // PRINT2 (Dev-Email-2026-06-09 §C, 2026-06-09) — print-sheet beacon.
  // Fires on window.beforeprint (covers Ctrl+P + Print-button). Dual GA4
  // + beacon so operators see counts on /admin/analytics without waiting
  // for the 24h GA4 custom-dim propagation.
  "print_sheet",
  // ENG1.5 (Dev-Email-2026-06-10 §B, 2026-06-10) — supply-side claim funnel.
  // Low-volume; dual-emitted so the funnel is visible in /admin/analytics
  // First-party events without the GA4 registration delay. The admin_approved
  // method's server-side emit is a deferred follow-up (see analytics.ts).
  "claim_started",
  "claim_submitted",
  "claim_approved",
  // ENG1.7 (Dev-Email-2026-06-10 §B, 2026-06-10) — newsletter double-opt-in
  // confirmation. (view_item_list / select_item are GA4-only — high volume,
  // intentionally NOT beaconed.)
  "newsletter_confirm",
  // OPE-66 (2026-07-02) — claim-funnel entry. The register page beacons this
  // when arriving from a "Claim this listing" CTA; the mirror below re-emits it
  // as claim_view_server (ad-block-resilient). The three deeper claim-funnel
  // conversions fire from pure server routes, not this beacon.
  "claim_view",
] as const;

// ENG1.8 — outbound-click event names mirrored to GA4 server-side via the
// Measurement Protocol (in addition to the client gtag + D1 beacon). Survives
// ad-blockers that suppress the client-side gtag hit.
//
// The mirror is emitted under a DISTINCT "<name>_server" event name (not the
// original) so it does not double-count against the client-side gtag hit, which
// already fires the original name for non-ad-blocked users. GA4 key events are
// configured per event NAME, so a distinct name lets the analyst mark the
// server variant as the conversion and get exactly one count per click (the
// first-party beacon driving this route is not ad-blocked, so the server hit
// fires for ~100% of clicks). A `transport: "server"` param is also attached
// for explicit filtering in explorations / BigQuery.
const GA4_MIRRORED_OUTBOUND_NAMES = new Set([
  "outbound_application_click",
  "outbound_ticket_click",
]);

/** Map a client outbound-click name to its distinct server-mirror event name. */
function serverMirrorName(clientName: string): string {
  return `${clientName}_server`;
}

const trackSchema = z.object({
  name: z.enum(ALLOWED_EVENT_NAMES),
  category: z.enum(["funnel", "engagement", "conversion"]),
  properties: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const rateLimitResult = await checkRateLimit(request, "analytics-track");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = trackSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Cap properties size to bound storage cost.
  const propertiesJson = parsed.data.properties
    ? JSON.stringify(parsed.data.properties)
    : undefined;
  if (propertiesJson && propertiesJson.length > MAX_PROPERTY_BYTES) {
    return NextResponse.json({ error: "Properties too large" }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.id;

  const db = getCloudflareDb();
  await trackServerEvent(db, {
    eventName: parsed.data.name,
    eventCategory: parsed.data.category,
    properties: parsed.data.properties,
    userId,
    source: "client_beacon",
  });

  // ENG1.8 — mirror outbound application/ticket clicks to GA4 server-side. All
  // five params are derived from the existing beacon payload (no client change).
  // sendGa4MeasurementProtocol never throws and is inert until configured.
  if (GA4_MIRRORED_OUTBOUND_NAMES.has(parsed.data.name)) {
    const props = parsed.data.properties ?? {};
    const targetUrl = typeof props.destinationUrl === "string" ? props.destinationUrl : "";
    const entityId = typeof props.eventSlug === "string" ? props.eventSlug : "";
    const clientId = parseGaClientId(request.headers.get("cookie")) ?? crypto.randomUUID();
    await sendGa4MeasurementProtocol(clientId, [
      {
        name: serverMirrorName(parsed.data.name),
        params: {
          transport: "server",
          target_url: targetUrl,
          target_domain: safeHostname(targetUrl),
          entity_type: "event",
          entity_id: entityId,
          application_or_ticket:
            parsed.data.name === "outbound_application_click" ? "application" : "ticket",
        },
      },
    ]);
  }

  // OPE-66 — mirror the claim-funnel entry to GA4 server-side as
  // claim_view_server (the deeper conversions fire from pure server routes).
  // Params come straight from the beacon payload — no separate client emit.
  if (parsed.data.name === "claim_view") {
    const props = parsed.data.properties ?? {};
    const entityTypeRaw =
      typeof props.entityType === "string" ? props.entityType.toUpperCase() : "";
    const entitySlug = typeof props.entitySlug === "string" ? props.entitySlug : "";
    if ((entityTypeRaw === "VENDOR" || entityTypeRaw === "PROMOTER") && entitySlug) {
      const clientId = parseGaClientId(request.headers.get("cookie")) ?? crypto.randomUUID();
      await trackClaimViewServer({ clientId, entityType: entityTypeRaw, entitySlug });
    }
  }

  return new NextResponse(null, { status: 204 });
}
