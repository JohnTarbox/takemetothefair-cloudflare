import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * ENG1.8 — server-side GA4 Measurement Protocol mirror.
 *
 * Outbound application/ticket clicks already reach GA4 client-side via gtag and
 * are persisted to D1 via the first-party beacon. Client gtag is blocked by ad
 * blockers, so this server-side mirror makes the outbound handoff reliable for
 * GA4-native conversion modeling (once the events are marked as key events in
 * GA4 Admin → Events).
 *
 * Like all analytics in this codebase, this NEVER throws — a failed send must
 * not break the request that triggered it.
 */

const MP_ENDPOINT = "https://www.google-analytics.com/mp/collect";

export interface Ga4MpEvent {
  /** GA4 event name (≤40 chars, snake_case). */
  name: string;
  params: Record<string, string | number>;
}

/**
 * Parse the GA4 `client_id` from a request Cookie header.
 *
 * The browser's `_ga` cookie has the shape `GA1.1.<id1>.<id2>`; GA4's client_id
 * is `<id1>.<id2>`. Returning the same client_id the browser uses lets the
 * Measurement Protocol event stitch to the user's existing session instead of
 * creating a phantom user. Returns null when the cookie is absent/malformed.
 */
export function parseGaClientId(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  // Cookies are "; "-separated; find the _ga value (not _ga_<STREAM>).
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName !== "_ga") continue;
    const value = rest.join("=");
    // Expect GA1.<version>.<id1>.<id2> — take the trailing two dot segments.
    const segments = value.split(".");
    if (segments.length < 4) return null;
    const id1 = segments[segments.length - 2];
    const id2 = segments[segments.length - 1];
    if (!id1 || !id2) return null;
    return `${id1}.${id2}`;
  }
  return null;
}

/**
 * Extract a hostname from a URL string, returning "" on any parse failure so
 * callers never have to guard. Used for the GA4 `target_domain` param.
 */
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Fire-and-forget GA4 Measurement Protocol send. No-ops (returns early) when the
 * GA4_MEASUREMENT_ID / GA4_MP_API_SECRET env vars are unset, so the feature is
 * inert until an operator configures it. Never throws.
 */
export async function sendGa4MeasurementProtocol(
  clientId: string,
  events: Ga4MpEvent[]
): Promise<void> {
  try {
    if (events.length === 0) return;
    const { env } = getCloudflareContext();
    const measurementId = env.GA4_MEASUREMENT_ID?.trim();
    const apiSecret = env.GA4_MP_API_SECRET?.trim();
    if (!measurementId || !apiSecret) return; // unconfigured → inert

    const url = `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(
      measurementId
    )}&api_secret=${encodeURIComponent(apiSecret)}`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, events }),
    });
  } catch {
    // Analytics must never break the request that triggered it.
    console.error("[GA4-MP] Measurement Protocol send failed");
  }
}
