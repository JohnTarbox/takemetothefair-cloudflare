/**
 * URL domain classification gate.
 *
 * Background: ~33% of populated events.ticket_url values pointed to competitor
 * aggregator sites because the ingestion pipeline was using the source
 * aggregator's own detail page as the ticket URL. This module is the gate
 * applied at every ingestion site to keep aggregator URLs out of ticket_url /
 * application_url and to skip ingesting from sources we've blocked.
 *
 * Storage: url_domain_classifications table (drizzle/0036). Three independent
 * boolean flags handle the asymmetry — Eventbrite is a fine ticket destination
 * but not a source-of-truth; fairsandfestivals.net is the inverse.
 *
 * Fail-open: unknown domains pass through. Discovery loop closes via the Site
 * Health admin panel, which surfaces high-traffic unclassified destinations
 * for one-click classification.
 *
 * Two call patterns:
 *   - Bulk: load full table once into a Map, gate per row in-memory.
 *   - Single-shot: gateUrlOnce hits the DB once.
 */

import type { getCloudflareDb } from "@/lib/cloudflare";
import { urlDomainClassifications } from "@/lib/db/schema";

// Field-write contexts: gateUrlForField returns null to block writing the URL
// to this field. "source" is intentionally NOT a field-write context — gating
// source means "skip the entire event," which is a different shape; use
// shouldIngestFromSource for that.
export type ClassificationContext = "ticket" | "application";

export interface ClassificationRow {
  useAsTicketUrl: boolean;
  useAsApplicationUrl: boolean;
  useAsSource: boolean;
}

export type ClassificationMap = Map<string, ClassificationRow>;

type Db = ReturnType<typeof getCloudflareDb>;

/**
 * Normalize a URL to its bare hostname (lowercase, no protocol, no www., no path).
 * Returns null for unparseable input. Bare hostnames (no protocol) are accepted
 * by prepending "https://" before parsing.
 */
export function extractDomain(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProtocol);
    if (!u.hostname) return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Load every classification row into a Map keyed by domain. Call once at the
 * top of a bulk-ingestion handler, then pass the Map to gateUrlForField for
 * each event being processed.
 */
export async function loadClassifications(db: Db): Promise<ClassificationMap> {
  const rows = await db
    .select({
      domain: urlDomainClassifications.domain,
      useAsTicketUrl: urlDomainClassifications.useAsTicketUrl,
      useAsApplicationUrl: urlDomainClassifications.useAsApplicationUrl,
      useAsSource: urlDomainClassifications.useAsSource,
    })
    .from(urlDomainClassifications);

  const map: ClassificationMap = new Map();
  for (const row of rows) {
    map.set(row.domain, {
      useAsTicketUrl: row.useAsTicketUrl,
      useAsApplicationUrl: row.useAsApplicationUrl,
      useAsSource: row.useAsSource,
    });
  }
  return map;
}

/**
 * Apply the classification gate to a URL meant for the ticket_url or
 * application_url column. Returns the URL unchanged if allowed, null if
 * blocked or malformed. Unknown domains pass through (fail-open).
 *
 * For "source" gating use shouldIngestFromSource — that's a different shape
 * (skip-the-whole-event vs. null-the-field).
 */
export function gateUrlForField(
  url: string | null | undefined,
  context: ClassificationContext,
  classifications: ClassificationMap
): string | null {
  if (!url) return null;
  const domain = extractDomain(url);
  if (!domain) return null;
  const row = classifications.get(domain);
  if (!row) return url;
  const flag = context === "ticket" ? row.useAsTicketUrl : row.useAsApplicationUrl;
  return flag ? url : null;
}

/**
 * Whether it's OK to ingest events whose source URL is on this domain.
 * Returns true if the source is allowed or unknown (fail-open), false only if
 * the domain is explicitly classified with use_as_source=0.
 *
 * Callers should treat false as "skip this event entirely" — distinct from
 * field-level gating, which only nulls the field.
 */
export function shouldIngestFromSource(
  url: string | null | undefined,
  classifications: ClassificationMap
): boolean {
  if (!url) return true;
  const domain = extractDomain(url);
  if (!domain) return true;
  const row = classifications.get(domain);
  if (!row) return true;
  return row.useAsSource;
}

/**
 * Single-shot gate for handlers that process one event at a time. Internally
 * loads the classifications table, so don't call this in a hot loop — use
 * loadClassifications + gateUrlForField for batch paths.
 */
export async function gateUrlOnce(
  db: Db,
  url: string | null | undefined,
  context: ClassificationContext
): Promise<string | null> {
  if (!url) return null;
  const domain = extractDomain(url);
  if (!domain) return null;
  const classifications = await loadClassifications(db);
  return gateUrlForField(url, context, classifications);
}
