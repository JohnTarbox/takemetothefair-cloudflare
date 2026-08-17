/**
 * OPE-414 — the market-player register's tool surface.
 *
 * Six admin-only tools over the three tables added in drizzle/0194. The design
 * constraints worth knowing before editing:
 *
 *   - `upsert_market_player` is idempotent on `domain`, so a monthly sweep or a
 *     re-run of the seed updates in place. That is what makes it safe for the
 *     analyst to load the full brief later over these rows.
 *   - Upsert only overwrites fields the caller actually supplied. A sweep that
 *     re-checks `has_schema` must not blank out the `owner` somebody
 *     researched by hand, and a naive `set: {...allFields}` would do exactly
 *     that with undefined.
 *   - Snapshots and SERP ranks are INSERT-only. The trend is the product; an
 *     update-in-place tool would quietly destroy it, so none is offered.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import {
  marketPlayers,
  marketPlayerSnapshots,
  marketPlayerSerpRanks,
  MARKET_PLAYER_ORG_CLASSES,
  MARKET_PLAYER_RELATIONSHIPS,
  MARKET_PLAYER_THREAT_LEVELS,
  MARKET_PLAYER_THREAT_TRENDS,
  MARKET_PLAYER_STATUSES,
} from "../schema.js";

/** Normalize whatever the caller passed into a bare registrable domain:
 *  strip scheme, `www.`, any path, and lowercase. Without this the same site
 *  arrives as `https://VisitMaine.com/` one month and `visitmaine.com` the
 *  next, and the "idempotent on domain" guarantee silently becomes two rows. */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .replace(/\.$/, "");
}

/** Drop undefined keys so an upsert never writes NULL over a field the caller
 *  simply did not mention. */
function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `jsonContent` returns ONE content item; the SDK wants the envelope. */
function reply(data: unknown) {
  return { content: [jsonContent(data)] };
}

async function resolvePlayer(db: Db, domainOrId: string) {
  const domain = normalizeDomain(domainOrId);
  const [byDomain] = await db
    .select()
    .from(marketPlayers)
    .where(eq(marketPlayers.domain, domain))
    .limit(1);
  if (byDomain) return byDomain;
  const [byId] = await db
    .select()
    .from(marketPlayers)
    .where(eq(marketPlayers.id, domainOrId))
    .limit(1);
  return byId ?? null;
}

export function registerMarketPlayerTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_market_players",
    [
      "OPE-414 — list the market-player register: external sites that list the same events we do.",
      "",
      "⚠️ NOT all of them are competitors, and the two axes say so separately:",
      "`org_class` is what the organization IS (for_profit / nonprofit / government /",
      "individual), `relationship` is what it is TO US (competitor / aggregator / partner /",
      "citation_source / neutral). visitmaine.com and maine.gov are government",
      "citation_sources — filtering on relationship='competitor' is how you avoid treating",
      "a partner as a threat. Admin only.",
    ].join(" "),
    {
      relationship: z.enum(MARKET_PLAYER_RELATIONSHIPS).optional(),
      org_class: z.enum(MARKET_PLAYER_ORG_CLASSES).optional(),
      type: z.string().optional().describe("Free-text type, exact match (e.g. 'directory')."),
      threat_level: z.enum(MARKET_PLAYER_THREAT_LEVELS).optional(),
      status: z.enum(MARKET_PLAYER_STATUSES).optional(),
      limit: z.number().int().min(1).max(200).optional().default(100),
    },
    async (params) => {
      const conditions = [
        params.relationship ? eq(marketPlayers.relationship, params.relationship) : undefined,
        params.org_class ? eq(marketPlayers.orgClass, params.org_class) : undefined,
        params.type ? eq(marketPlayers.type, params.type) : undefined,
        params.threat_level ? eq(marketPlayers.threatLevel, params.threat_level) : undefined,
        params.status ? eq(marketPlayers.status, params.status) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const rows = await db
        .select()
        .from(marketPlayers)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(marketPlayers.domain)
        .limit(params.limit ?? 100);

      return reply({
        count: rows.length,
        filters_applied: definedOnly({
          relationship: params.relationship,
          org_class: params.org_class,
          type: params.type,
          threat_level: params.threat_level,
          status: params.status,
        }),
        players: rows,
      });
    }
  );

  server.tool(
    "get_market_player",
    [
      "OPE-414 — one market player with its latest snapshot and most recent SERP ranks.",
      "Accepts a domain (in any form — scheme/www/path are stripped) or the row id.",
      "Admin only.",
    ].join(" "),
    {
      domain: z.string().min(1).describe("Domain or row id."),
      rank_limit: z.number().int().min(1).max(50).optional().default(10),
    },
    async (params) => {
      const player = await resolvePlayer(db, params.domain);
      if (!player) {
        return reply({ found: false, domain: normalizeDomain(params.domain) });
      }
      const [snapshots, ranks] = await Promise.all([
        db
          .select()
          .from(marketPlayerSnapshots)
          .where(eq(marketPlayerSnapshots.playerId, player.id))
          .orderBy(desc(marketPlayerSnapshots.snapshotAt))
          .limit(5),
        db
          .select()
          .from(marketPlayerSerpRanks)
          .where(eq(marketPlayerSerpRanks.playerId, player.id))
          .orderBy(desc(marketPlayerSerpRanks.checkedAt))
          .limit(params.rank_limit ?? 10),
      ]);
      return reply({
        found: true,
        player,
        latest_snapshot: snapshots[0] ?? null,
        recent_snapshots: snapshots,
        recent_ranks: ranks,
        // Stated rather than implied: an empty list here means nobody has
        // measured this player yet, NOT that it has no presence.
        note:
          snapshots.length === 0
            ? "No snapshots recorded — this player has never been measured, which is not the same as measuring zero."
            : undefined,
      });
    }
  );

  server.tool(
    "upsert_market_player",
    [
      "OPE-414 — create or update one market player. Idempotent on `domain`, so re-running a",
      "seed or a monthly sweep updates in place instead of duplicating.",
      "",
      "Only the fields you pass are written: omitted fields keep their existing values, so a",
      "sweep that re-checks has_schema cannot blank out an `owner` somebody researched by hand.",
      "",
      "Set `relationship` deliberately — it is our posture, not a fact about them. A government",
      "tourism board that lists our events is a citation_source, not a competitor. Admin only.",
    ].join(" "),
    {
      domain: z.string().min(1),
      name: z.string().optional(),
      relationship: z.enum(MARKET_PLAYER_RELATIONSHIPS).optional(),
      org_class: z.enum(MARKET_PLAYER_ORG_CLASSES).optional(),
      type: z.string().optional(),
      geo_scope: z.string().optional(),
      owner: z.string().optional(),
      registered_at: z.string().optional().describe("ISO date the domain was registered."),
      business_model: z.string().optional(),
      pricing: z.string().optional(),
      tech_stack: z.string().optional(),
      has_schema: z.boolean().optional(),
      has_llms_txt: z.boolean().optional(),
      threat_level: z.enum(MARKET_PLAYER_THREAT_LEVELS).optional(),
      threat_trend: z.enum(MARKET_PLAYER_THREAT_TRENDS).optional(),
      status: z.enum(MARKET_PLAYER_STATUSES).optional(),
      notes: z.string().optional(),
      mark_checked: z
        .boolean()
        .optional()
        .describe("Stamp last_checked_at = now. Pass true when this call reflects a real look."),
    },
    async (params) => {
      const domain = normalizeDomain(params.domain);
      if (!domain) {
        return reply({ ok: false, error: "domain resolved to empty after normalization" });
      }
      const now = new Date();
      const registeredAt = params.registered_at ? new Date(params.registered_at) : undefined;
      if (registeredAt && Number.isNaN(registeredAt.getTime())) {
        return reply({ ok: false, error: `unparseable registered_at: ${params.registered_at}` });
      }

      const fields = definedOnly({
        name: params.name,
        relationship: params.relationship,
        orgClass: params.org_class,
        type: params.type,
        geoScope: params.geo_scope,
        owner: params.owner,
        registeredAt,
        businessModel: params.business_model,
        pricing: params.pricing,
        techStack: params.tech_stack,
        hasSchema: params.has_schema,
        hasLlmsTxt: params.has_llms_txt,
        threatLevel: params.threat_level,
        threatTrend: params.threat_trend,
        status: params.status,
        notes: params.notes,
        lastCheckedAt: params.mark_checked ? now : undefined,
      });

      const existing = await resolvePlayer(db, domain);
      await db
        .insert(marketPlayers)
        .values({ domain, createdAt: now, updatedAt: now, ...fields })
        .onConflictDoUpdate({
          target: marketPlayers.domain,
          set: { ...fields, updatedAt: now },
        });

      const saved = await resolvePlayer(db, domain);
      return reply({
        ok: true,
        action: existing ? "updated" : "created",
        fields_written: Object.keys(fields),
        player: saved,
      });
    }
  );

  server.tool(
    "add_market_player_snapshot",
    [
      "OPE-414 — record one metric observation for a market player. APPEND-ONLY: every call is a",
      "new row, because the trend is the point and overwriting a prior count would erase it.",
      "",
      "Leave a metric out rather than guessing it — NULL means 'not countable on this visit',",
      "which is a real and useful observation. `source_url` makes a surprising number auditable.",
      "Admin only.",
    ].join(" "),
    {
      domain: z.string().min(1),
      event_count: z.number().int().min(0).optional(),
      ne_event_count: z.number().int().min(0).optional(),
      search_visibility: z.number().optional(),
      notes: z
        .string()
        .optional()
        .describe("Include the UNIT for search_visibility here — an unlabelled number rots fast."),
      source_url: z.string().optional(),
      snapshot_at: z.string().optional().describe("ISO timestamp; defaults to now."),
    },
    async (params) => {
      const player = await resolvePlayer(db, params.domain);
      if (!player) {
        return reply({
          ok: false,
          error: `no market player for domain '${normalizeDomain(params.domain)}' — create it with upsert_market_player first`,
        });
      }
      const snapshotAt = params.snapshot_at ? new Date(params.snapshot_at) : new Date();
      if (Number.isNaN(snapshotAt.getTime())) {
        return reply({ ok: false, error: `unparseable snapshot_at: ${params.snapshot_at}` });
      }
      const now = new Date();
      await db.insert(marketPlayerSnapshots).values({
        playerId: player.id,
        eventCount: params.event_count ?? null,
        neEventCount: params.ne_event_count ?? null,
        searchVisibility: params.search_visibility ?? null,
        notes: params.notes ?? null,
        sourceUrl: params.source_url ?? null,
        snapshotAt,
        createdAt: now,
      });
      // Recording an observation IS a check.
      await db
        .update(marketPlayers)
        .set({ lastCheckedAt: snapshotAt })
        .where(eq(marketPlayers.id, player.id));

      const [{ n }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(marketPlayerSnapshots)
        .where(eq(marketPlayerSnapshots.playerId, player.id));
      return reply({ ok: true, domain: player.domain, total_snapshots: Number(n) });
    }
  );

  server.tool(
    "record_market_player_serp_rank",
    [
      "OPE-414 — record where a market player ranked for one query, in one market, at one moment.",
      "",
      "Omit `position` when you searched and did NOT find them in range: that is a real",
      "observation (they are not ranking) and is different from never having checked, which is",
      "simply the absence of a row. Admin only.",
    ].join(" "),
    {
      domain: z.string().min(1),
      query: z.string().min(1).describe("The search query exactly as issued."),
      market: z.string().optional().describe("e.g. 'Bangor, ME'. Omit for national."),
      position: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("1-based SERP position. OMIT if not found in range."),
      ranking_url: z.string().optional(),
      checked_at: z.string().optional().describe("ISO timestamp; defaults to now."),
    },
    async (params) => {
      const player = await resolvePlayer(db, params.domain);
      if (!player) {
        return reply({
          ok: false,
          error: `no market player for domain '${normalizeDomain(params.domain)}' — create it with upsert_market_player first`,
        });
      }
      const checkedAt = params.checked_at ? new Date(params.checked_at) : new Date();
      if (Number.isNaN(checkedAt.getTime())) {
        return reply({ ok: false, error: `unparseable checked_at: ${params.checked_at}` });
      }
      await db.insert(marketPlayerSerpRanks).values({
        playerId: player.id,
        query: params.query.trim(),
        market: params.market ?? null,
        position: params.position ?? null,
        rankingUrl: params.ranking_url ?? null,
        checkedAt,
        createdAt: new Date(),
      });
      return reply({
        ok: true,
        domain: player.domain,
        query: params.query.trim(),
        position: params.position ?? null,
        recorded_as: params.position ? "ranked" : "not-found-in-range",
      });
    }
  );

  server.tool(
    "get_market_player_trend",
    [
      "OPE-414 — the observation series for one player: snapshots and SERP ranks oldest-first,",
      "which is the shape you want for 'is this site growing into our market or drifting out'.",
      "",
      "A single data point is not a trend, and the response says so explicitly rather than",
      "letting one snapshot be read as a direction. Admin only.",
    ].join(" "),
    {
      domain: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional().default(50),
    },
    async (params) => {
      const player = await resolvePlayer(db, params.domain);
      if (!player) {
        return reply({ found: false, domain: normalizeDomain(params.domain) });
      }
      const [snapshots, ranks] = await Promise.all([
        db
          .select()
          .from(marketPlayerSnapshots)
          .where(eq(marketPlayerSnapshots.playerId, player.id))
          .orderBy(marketPlayerSnapshots.snapshotAt)
          .limit(params.limit ?? 50),
        db
          .select()
          .from(marketPlayerSerpRanks)
          .where(eq(marketPlayerSerpRanks.playerId, player.id))
          .orderBy(marketPlayerSerpRanks.checkedAt)
          .limit(params.limit ?? 50),
      ]);
      return reply({
        found: true,
        domain: player.domain,
        relationship: player.relationship,
        org_class: player.orgClass,
        snapshots,
        serp_ranks: ranks,
        trend_readable: snapshots.length >= 2,
        note:
          snapshots.length < 2
            ? `${snapshots.length} snapshot(s) — not enough for a trend. Two observations at different times are the minimum.`
            : undefined,
      });
    }
  );
}
