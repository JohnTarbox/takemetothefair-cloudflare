/**
 * §10.2 competitor / aggregator domain loader.
 *
 * Curated list of domains we treat as competitors when scoring URL fields
 * (events.ticket_url, vendors.website). Replaces the hardcoded array that
 * previously lived in src/lib/recommendations/rules/competitor-url-contamination.ts.
 *
 * Loaded once per scan via loadCompetitorDomains; the table rarely changes,
 * but admins may add new entries via /api/admin/competitor-domains without
 * a code deploy.
 */
import { competitorDomains } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

// Accept the Drizzle handle in either of the two shapes used in this
// codebase: the rules engine binds `DrizzleD1Database<typeof schema>` while
// most lib helpers use `ReturnType<typeof getCloudflareDb>`. They're
// structurally compatible at runtime; the union is purely for TS.
type Db = DrizzleD1Database<typeof schema>;

export async function loadCompetitorDomains(db: Db): Promise<string[]> {
  const rows = await db.select({ domain: competitorDomains.domain }).from(competitorDomains);
  return rows.map((r) => r.domain.toLowerCase());
}
