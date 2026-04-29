/**
 * URL domain classification gate — MCP server mirror.
 *
 * Mirrors src/lib/url-classification.ts in the main app. Kept as a separate
 * file rather than imported because the MCP server is a separately-deployed
 * Worker with its own schema mirror; we follow the same convention as
 * mcp-server/src/helpers.ts:decodeHtmlEntities (per-package duplication).
 *
 * Used by MCP admin tools (update_event) and vendor tools (suggest_event) to
 * keep aggregator URLs out of ticket_url and application_url fields when an
 * agent is mutating events through the MCP boundary.
 */

import type { Db } from "./db.js";
import { urlDomainClassifications } from "./schema.js";

export type ClassificationContext = "ticket" | "application";

export interface ClassificationRow {
  useAsTicketUrl: boolean;
  useAsApplicationUrl: boolean;
  useAsSource: boolean;
}

export type ClassificationMap = Map<string, ClassificationRow>;

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
