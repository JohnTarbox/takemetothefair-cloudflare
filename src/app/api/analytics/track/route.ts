import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { trackServerEvent } from "@/lib/server-analytics";

export const runtime = "edge";

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
] as const;

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

  return new NextResponse(null, { status: 204 });
}
