/**
 * Discovery feedback loop for URL domain classification.
 *
 * Surfaces hostnames that received `outbound_ticket_click` events recently but
 * are NOT yet in url_domain_classifications, so an admin can classify them
 * before they pile up as more contamination.
 *
 * Closes the loop on the fail-open default in src/lib/url-classification.ts:
 * unknown destinations pass through ingestion, this panel catches them based
 * on what real users actually click on.
 */

import { and, gte, eq } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { analyticsEvents, urlDomainClassifications } from "@/lib/db/schema";
import { extractDomain } from "@/lib/url-classification";

type Db = ReturnType<typeof getCloudflareDb>;

export interface UnclassifiedDestination {
  domain: string;
  clicks: number;
  /** Slug of one event whose ticket-click contributed to this row — for context. */
  sampleEventSlug: string | null;
}

interface BeaconProperties {
  destinationUrl?: string;
  eventSlug?: string;
  destination_url?: string;
}

export async function getUnclassifiedOutboundDestinations(
  db: Db,
  opts: { days?: number; minClicks?: number } = {}
): Promise<UnclassifiedDestination[]> {
  const days = opts.days ?? 7;
  const minClicks = opts.minClicks ?? 5;
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  // Pull the raw beacon rows. Indexed on (event_name, timestamp).
  const rows = await db
    .select({
      properties: analyticsEvents.properties,
    })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventName, "outbound_ticket_click"),
        gte(analyticsEvents.timestamp, since)
      )
    );

  // Aggregate by hostname in JS — D1's JSON1 support is limited and the row
  // count over a 7-day window is small (a few thousand at most).
  const byDomain = new Map<string, { clicks: number; sampleEventSlug: string | null }>();
  for (const row of rows) {
    if (!row.properties) continue;
    let parsed: BeaconProperties;
    try {
      parsed = JSON.parse(row.properties) as BeaconProperties;
    } catch {
      continue;
    }
    // Beacon writes camelCase; older GA4 path used snake_case. Accept either.
    const url = parsed.destinationUrl ?? parsed.destination_url;
    if (!url) continue;
    const domain = extractDomain(url);
    if (!domain) continue;
    const existing = byDomain.get(domain);
    if (existing) {
      existing.clicks += 1;
    } else {
      byDomain.set(domain, {
        clicks: 1,
        sampleEventSlug: parsed.eventSlug ?? null,
      });
    }
  }

  if (byDomain.size === 0) return [];

  // Look up which domains are already classified, so we can subtract them.
  const classifiedRows = await db
    .select({ domain: urlDomainClassifications.domain })
    .from(urlDomainClassifications);
  const classified = new Set(classifiedRows.map((r) => r.domain));

  const result: UnclassifiedDestination[] = [];
  for (const [domain, agg] of byDomain) {
    if (classified.has(domain)) continue;
    if (agg.clicks < minClicks) continue;
    result.push({ domain, clicks: agg.clicks, sampleEventSlug: agg.sampleEventSlug });
  }

  result.sort((a, b) => b.clicks - a.clicks);
  return result;
}
