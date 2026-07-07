/**
 * OPE-116 (2/3) — performer discovery harvest + dedup sweep.
 *
 * Two admin tools that scale the performer dataset without any live fetch:
 *
 *   - `harvest_performers_from_schema_org` — mine `performer` nodes out of the
 *     JSON-LD already scraped into `event_schema_org` (source-site structured
 *     data) and seed them as PENDING appearances. Pure DB reads — the JSON-LD is
 *     already stored, so there's no provenance-locked interactive fetch here.
 *     Fuzzy-links to an existing act at ≥0.92 (the same high bar the Phase-1
 *     create-or-link uses), else creates a new act. Everything lands as a PENDING
 *     appearance for operator confirmation; nothing is emitted to schema.org
 *     until confirmed (Phase 2 gate).
 *
 *   - `find_duplicate_performers` — pairwise fuzzy sweep of the live performer
 *     table, surfacing likely-duplicate pairs for `merge_performer`. Read-only.
 *     Complements the harvest: harvest only AUTO-links at ≥0.92, so near-dups
 *     below that bar accrete as separate acts — this sweep catches them.
 *
 * Provenance: harvested appearances carry source_url = the event's own
 * source_url (or the schema-org ticket_url) — "discovered from this source", not
 * "fetched now". Admin only.
 *
 * The DB-affecting cores are exported (harvestPerformersFromSchemaOrg /
 * findDuplicatePerformers) so the vitest suite can drive them against a real
 * test D1 without going through the MCP transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { performers, events, eventSchemaOrg, adminActions } from "../schema.js";
import { decodeHtmlEntities, jsonContent, unsafeSlug } from "../helpers.js";
import { combinedSimilarity } from "@takemetothefair/utils";
import { ensureUniquePerformerSlug, linkAppearance, FUZZY_THRESHOLD } from "./admin-performers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** How many live performers to hold in memory for fuzzy matching. */
const PERFORMER_SCAN_CAP = 2000;

interface HarvestedPerformer {
  name: string;
  performerType: "PERSON" | "GROUP" | null;
  website: string | null;
  socialLinks: string | null;
}

interface Candidate {
  id: string;
  name: string;
  slug: string;
}

function isHttpUrl(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

/** schema.org @type → performerType. Person = solo; group-ish = GROUP. */
function classifyType(t: unknown): "PERSON" | "GROUP" | null {
  const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
  const norm = types.map((x) => x.toLowerCase());
  if (norm.some((x) => x.includes("person"))) return "PERSON";
  if (
    norm.some(
      (x) =>
        x.includes("musicgroup") ||
        x.includes("performinggroup") ||
        x.includes("theatergroup") ||
        x.includes("dancegroup") ||
        x.includes("organization") ||
        x === "group"
    )
  )
    return "GROUP";
  return null;
}

const SOCIAL_PLATFORMS: [RegExp, string][] = [
  [/facebook\.com/i, "facebook"],
  [/instagram\.com/i, "instagram"],
  [/(youtube\.com|youtu\.be)/i, "youtube"],
  [/(twitter\.com|x\.com)/i, "twitter"],
  [/tiktok\.com/i, "tiktok"],
];

/** Build a {platform:url} JSON string from a schema.org sameAs value. */
function socialFromSameAs(sameAs: unknown): string | null {
  const arr = Array.isArray(sameAs) ? sameAs : sameAs != null ? [sameAs] : [];
  const out: Record<string, string> = {};
  for (const item of arr) {
    if (!isHttpUrl(item)) continue;
    for (const [re, key] of SOCIAL_PLATFORMS) {
      if (re.test(item) && !out[key]) out[key] = item.trim();
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** Collect every object node in the JSON-LD (handles arrays + @graph nesting). */
function collectObjects(parsed: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (Array.isArray(o["@graph"])) (o["@graph"] as unknown[]).forEach(visit);
    }
  };
  visit(parsed);
  return out;
}

/**
 * Extract performer nodes from a stored raw JSON-LD blob. Dedupes by
 * lowercased name within one event. Image + description are deliberately NOT
 * harvested — images are high-cost-if-wrong (defer to enrich_performer's review
 * path), and schema.org performer nodes rarely carry a real bio.
 */
export function extractPerformerNodes(raw: string | null): HarvestedPerformer[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const results: HarvestedPerformer[] = [];
  for (const o of collectObjects(parsed)) {
    const perf = o["performer"];
    if (!perf) continue;
    const nodes = Array.isArray(perf) ? perf : [perf];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const node = n as Record<string, unknown>;
      const rawName = node["name"];
      if (typeof rawName !== "string") continue;
      const name = decodeHtmlEntities(rawName).trim();
      if (name.length < 2 || name.length > 200) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        name,
        performerType: classifyType(node["@type"]),
        website: isHttpUrl(node["url"]) ? (node["url"] as string).trim() : null,
        socialLinks: socialFromSameAs(node["sameAs"]),
      });
    }
  }
  return results;
}

/** Best ≥threshold fuzzy match for a name among the candidate acts, or null. */
function bestMatch(name: string, candidates: Candidate[]): (Candidate & { score: number }) | null {
  let best: (Candidate & { score: number }) | null = null;
  for (const c of candidates) {
    const score = combinedSimilarity(name, c.name, 0.6, FUZZY_THRESHOLD);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) best = { ...c, score };
  }
  return best;
}

export interface HarvestSummary {
  dryRun: boolean;
  rowsScanned: number;
  performerNodesFound: number;
  performersCreated: Array<{ id: string; name: string }>;
  performersLinked: Array<{ id: string; name: string; score: number }>;
  appearancesCreated: number;
  appearancesExisting: number;
  performerScanCapped: boolean;
  byEvent: Array<{ event: string; performers: string[] }>;
}

/**
 * Harvest core. Scans `event_schema_org` (status='available') for performer
 * nodes and, per node, links to an existing act (≥0.92) or creates one, then
 * writes a PENDING appearance. dryRun computes the same decisions without
 * writing. Returns a structured summary.
 */
export async function harvestPerformersFromSchemaOrg(
  db: Db,
  auth: AuthContext | null,
  opts: { limit?: number; eventId?: string; dryRun?: boolean } = {}
): Promise<HarvestSummary> {
  const dryRun = opts.dryRun !== false;
  const limit = opts.limit ?? 50;

  const candidates: Candidate[] = (
    await db
      .select({ id: performers.id, name: performers.name, slug: performers.slug })
      .from(performers)
      .where(isNull(performers.deletedAt))
      .limit(PERFORMER_SCAN_CAP)
  ).map((c) => ({ id: c.id, name: c.name, slug: c.slug }));
  const performerScanCapped = candidates.length >= PERFORMER_SCAN_CAP;

  const whereConds = [eq(eventSchemaOrg.status, "available"), isNotNull(eventSchemaOrg.rawJsonLd)];
  if (opts.eventId) whereConds.push(eq(eventSchemaOrg.eventId, opts.eventId));

  const rows = await db
    .select({
      eventId: eventSchemaOrg.eventId,
      rawJsonLd: eventSchemaOrg.rawJsonLd,
      ticketUrl: eventSchemaOrg.ticketUrl,
      eventSourceUrl: events.sourceUrl,
      eventSlug: events.slug,
      eventName: events.name,
    })
    .from(eventSchemaOrg)
    .innerJoin(events, eq(events.id, eventSchemaOrg.eventId))
    .where(and(...whereConds))
    .limit(limit);

  const performersCreated: Array<{ id: string; name: string }> = [];
  const performersLinked: Array<{ id: string; name: string; score: number }> = [];
  let appearancesCreated = 0;
  let appearancesExisting = 0;
  let performerNodesFound = 0;
  const byEvent: Array<{ event: string; performers: string[] }> = [];

  for (const row of rows) {
    const nodes = extractPerformerNodes(row.rawJsonLd);
    if (nodes.length === 0) continue;
    const provenance =
      row.eventSourceUrl?.trim() ||
      row.ticketUrl?.trim() ||
      `https://meetmeatthefair.com/events/${row.eventSlug}`;
    const eventLabel: string[] = [];

    for (const node of nodes) {
      performerNodesFound++;
      const match = bestMatch(node.name, candidates);
      let performerId: string;

      if (match) {
        performerId = match.id;
        performersLinked.push({ id: match.id, name: node.name, score: match.score });
      } else if (dryRun) {
        performerId = `dry-${performersCreated.length}`;
        // Synthetic candidate so a repeat name later in the batch counts as a
        // link, not a second create.
        candidates.push({ id: performerId, name: node.name, slug: "" });
        performersCreated.push({ id: performerId, name: node.name });
      } else {
        const slug = await ensureUniquePerformerSlug(db, node.name);
        const now = new Date();
        const ins = await db
          .insert(performers)
          .values({
            name: node.name,
            slug: unsafeSlug(slug),
            performerType: node.performerType,
            website: node.website,
            socialLinks: node.socialLinks,
            enrichmentSource: "schema_org_harvest",
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: performers.id });
        performerId = ins[0].id;
        candidates.push({ id: performerId, name: node.name, slug });
        performersCreated.push({ id: performerId, name: node.name });
      }

      eventLabel.push(node.name);

      if (!dryRun) {
        const appr = await linkAppearance(db, {
          eventId: row.eventId,
          performerId,
          eventDayId: null,
          performanceStart: null,
          performanceEnd: null,
          stage: null,
          billing: null,
          status: "PENDING",
          sourceUrl: provenance,
        });
        if (appr.created) appearancesCreated++;
        else appearancesExisting++;
      }
    }
    byEvent.push({ event: row.eventName, performers: eventLabel });
  }

  if (!dryRun && auth && (performersCreated.length > 0 || appearancesCreated > 0)) {
    try {
      await db.insert(adminActions).values({
        action: "performer.harvest",
        actorUserId: auth.userId,
        targetType: "performer",
        targetId: "batch",
        payloadJson: JSON.stringify({
          rows_scanned: rows.length,
          performers_created: performersCreated.length,
          performers_linked: performersLinked.length,
          appearances_created: appearancesCreated,
          via: "harvest_performers_from_schema_org",
        }),
        createdAt: new Date(),
      });
    } catch {
      /* audit is non-critical */
    }
  }

  return {
    dryRun,
    rowsScanned: rows.length,
    performerNodesFound,
    performersCreated,
    performersLinked,
    appearancesCreated,
    appearancesExisting,
    performerScanCapped,
    byEvent,
  };
}

export interface DuplicatePair {
  a: Candidate;
  b: Candidate;
  score: number;
}

/** Dedup core. Pairwise fuzzy sweep of the live performer table. */
export async function findDuplicatePerformers(
  db: Db,
  opts: { minScore?: number; scanCap?: number } = {}
): Promise<{ scanned: number; scanCapped: boolean; pairs: DuplicatePair[] }> {
  const minScore = opts.minScore ?? 0.85;
  const scanCap = opts.scanCap ?? 1000;

  const acts = await db
    .select({ id: performers.id, name: performers.name, slug: performers.slug })
    .from(performers)
    .where(isNull(performers.deletedAt))
    .limit(scanCap);

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < acts.length; i++) {
    for (let j = i + 1; j < acts.length; j++) {
      const score = combinedSimilarity(acts[i].name, acts[j].name, 0.6, minScore);
      if (score >= minScore) pairs.push({ a: acts[i], b: acts[j], score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return { scanned: acts.length, scanCapped: acts.length >= scanCap, pairs };
}

export function registerPerformerDiscoveryTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "harvest_performers_from_schema_org",
    "Mine `performer` nodes from the JSON-LD already scraped into event_schema_org and seed them as PENDING appearances. Pure DB reads (no live fetch). For each act found: fuzzy-links to an existing performer at ≥0.92 similarity, else creates a new performer (name + type + website + socials from sameAs; image/description are left for enrich_performer). Every appearance is written status=PENDING with source_url = the event's source URL (provenance) — nothing is emitted to schema.org until an operator confirms it. dry_run defaults true (reports what WOULD be created/linked without writing). Admin only.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max event_schema_org rows (status='available') to scan this run."),
      event_id: z.string().optional().describe("Restrict to a single event's schema-org row."),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe("Report-only (default true). false actually creates performers + appearances."),
    },
    async (params) => {
      const s = await harvestPerformersFromSchemaOrg(db, auth, {
        limit: params.limit,
        eventId: params.event_id,
        dryRun: params.dry_run,
      });
      return {
        content: [
          jsonContent({
            success: true,
            dry_run: s.dryRun,
            rows_scanned: s.rowsScanned,
            performer_nodes_found: s.performerNodesFound,
            performers_created: s.performersCreated.length,
            performers_linked: s.performersLinked.length,
            appearances_created: s.dryRun ? null : s.appearancesCreated,
            appearances_already_existed: s.dryRun ? null : s.appearancesExisting,
            note: s.dryRun
              ? "dry-run — nothing written. Re-call with dry_run=false to apply. All appearances land as PENDING for confirmation."
              : "Harvested acts are PENDING appearances awaiting confirmation; run find_duplicate_performers to catch near-dup acts below the 0.92 auto-link bar.",
            performer_scan_capped: s.performerScanCapped,
            created_sample: s.performersCreated.slice(0, 25).map((p) => p.name),
            linked_sample: s.performersLinked
              .slice(0, 25)
              .map((p) => ({ name: p.name, score: Number(p.score.toFixed(3)) })),
            by_event: s.byEvent.slice(0, 25),
          }),
        ],
      };
    }
  );

  server.tool(
    "find_duplicate_performers",
    "Pairwise fuzzy sweep of the live performer table to surface likely-duplicate acts for merge_performer. Read-only. Complements harvest_performers_from_schema_org (which only auto-links at ≥0.92, so near-dups below that bar accumulate). Returns pairs at or above min_score, highest-scoring first. Admin only.",
    {
      min_score: z
        .number()
        .min(0.5)
        .max(1)
        .optional()
        .default(0.85)
        .describe("Minimum combined-similarity for a pair to surface (default 0.85)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max pairs to return."),
      scan_cap: z
        .number()
        .int()
        .min(10)
        .max(PERFORMER_SCAN_CAP)
        .optional()
        .default(1000)
        .describe(
          "Max performers to scan (O(n²) pairwise); newest names may be dropped past this."
        ),
    },
    async (params) => {
      const limit = params.limit ?? 50;
      const { scanned, scanCapped, pairs } = await findDuplicatePerformers(db, {
        minScore: params.min_score,
        scanCap: params.scan_cap,
      });
      return {
        content: [
          jsonContent({
            success: true,
            scanned,
            scan_capped: scanCapped,
            min_score: params.min_score ?? 0.85,
            pairs_found: pairs.length,
            pairs: pairs.slice(0, limit).map((p) => ({
              score: Number(p.score.toFixed(3)),
              a: { id: p.a.id, name: p.a.name, slug: p.a.slug },
              b: { id: p.b.id, name: p.b.name, slug: p.b.slug },
              hint: "merge_performer(keeper_id, duplicate_id) — keep the fuller record.",
            })),
          }),
        ],
      };
    }
  );
}
