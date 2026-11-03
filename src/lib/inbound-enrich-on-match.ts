/**
 * OPE-1152 — what enrich-on-match did with ONE inbound email, for the review
 * surface.
 *
 * The MCP Worker's stager (`mcp-server/src/email-handlers/enrich-proposal.ts`)
 * writes one `admin_actions` row per match: `dedup.enrich_proposed` (fill-empty
 * proposals against the matched event) or `dedup.enrich_nothing_staged` (the
 * match staged nothing — with the fields the email carried and the ones dropped
 * because the event already held a different value). Before this, the one
 * proposal ever staged lived only in `admin_actions`: nothing displayed it, and
 * a match that staged nothing left no trace at all.
 *
 * Read-only. Applying a proposal stays a human act on the event (OPE-175 /
 * OPE-839 — stage, don't apply).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { adminActions, events } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";

/** Must match mcp-server/src/email-handlers/enrich-proposal.ts. */
export const ENRICH_PROPOSED_ACTION = "dedup.enrich_proposed";
/** Must match mcp-server/src/email-handlers/enrich-proposal.ts. */
export const ENRICH_NOTHING_STAGED_ACTION = "dedup.enrich_nothing_staged";

export interface EnrichOnMatchEntry {
  id: string;
  createdAt: string | null;
  outcome: "proposed" | "nothing-staged";
  event: { id: string; name: string | null; slug: string | null };
  path: string | null;
  matchType: string | null;
  proposals: Record<string, unknown>;
  extractedFields: string[];
  unstagedFields: string[];
}

interface Payload {
  proposals?: Record<string, unknown>;
  extractedFields?: unknown;
  unstagedFields?: unknown;
  path?: string;
  matchType?: string | null;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Parse one row. A malformed payload still lists — showing that a match
 *  happened beats hiding it because its detail could not be read. */
export function parseEnrichOnMatchRow(row: {
  id: string;
  action: string;
  targetId: string;
  createdAt: Date | number | string | null;
  payloadJson: string | null;
  eventName?: string | null;
  eventSlug?: string | null;
}): EnrichOnMatchEntry {
  let p: Payload = {};
  try {
    p = JSON.parse(row.payloadJson ?? "{}") as Payload;
  } catch {
    p = {};
  }
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : typeof row.createdAt === "number"
        ? new Date(row.createdAt * 1000).toISOString()
        : (row.createdAt ?? null);
  return {
    id: row.id,
    createdAt,
    outcome: row.action === ENRICH_PROPOSED_ACTION ? "proposed" : "nothing-staged",
    event: { id: row.targetId, name: row.eventName ?? null, slug: row.eventSlug ?? null },
    path: p.path ?? null,
    matchType: p.matchType ?? null,
    proposals:
      p.proposals && typeof p.proposals === "object" && !Array.isArray(p.proposals)
        ? p.proposals
        : {},
    extractedFields: strings(p.extractedFields),
    unstagedFields: strings(p.unstagedFields),
  };
}

export async function loadEnrichOnMatch(
  db: ReturnType<typeof getCloudflareDb>,
  inboundEmailId: string
): Promise<EnrichOnMatchEntry[]> {
  const rows = await db
    .select({
      id: adminActions.id,
      action: adminActions.action,
      targetId: adminActions.targetId,
      createdAt: adminActions.createdAt,
      payloadJson: adminActions.payloadJson,
      eventName: events.name,
      eventSlug: events.slug,
    })
    .from(adminActions)
    .leftJoin(events, eq(events.id, adminActions.targetId))
    .where(
      and(
        inArray(adminActions.action, [ENRICH_PROPOSED_ACTION, ENRICH_NOTHING_STAGED_ACTION]),
        sql`json_extract(${adminActions.payloadJson}, '$.inboundEmailId') = ${inboundEmailId}`
      )
    )
    .orderBy(adminActions.createdAt);
  return rows.map(parseEnrichOnMatchRow);
}
