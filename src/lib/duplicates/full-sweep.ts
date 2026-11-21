/**
 * OPE-1597 — compare a whole table for likely duplicates, and store the result.
 *
 * The on-demand search compared the first 500 rows pairwise, because comparing
 * 13,801 live vendors that way is about 95 million comparisons. Here rows are
 * only compared inside a block, keyed on the first four characters of the
 * normalized name after a leading article. Measured on prod vendors 2026-11-09,
 * a bare four-character prefix makes 154,407 comparisons, 86,000 of them in the
 * one "the " block that stripping the article removes.
 *
 * ⚠️ What blocking gives up: two names that differ within their first four
 * characters ("Smith Farm" / "Smyth Farm") are never compared. The ticket also
 * proposed blocking on state; that is left out, because a vendor's state is
 * often blank and a state key would hide a same-name pair across states.
 *
 * Proposals only. Nothing in this file merges or edits a record.
 */
import { and, count, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  entityDuplicateSweepPairs,
  entityDuplicateSweepRuns,
  eventVendors,
  events,
  promoters,
  vendors,
  venues,
} from "@/lib/db/schema";
import { normalizeName } from "./normalize-name";
import {
  combinedSimilarity,
  getEventComparisonString,
  getPromoterComparisonString,
  getVendorComparisonString,
  getVenueComparisonString,
  normalizeString,
} from "./similarity";
import type { DuplicateEntityType } from "./types";

/** The lowest threshold the page offers; pairs below it can never be shown. */
const STORED_MIN_SIMILARITY = 0.6;
/** The highest-similarity pairs kept per type. */
const MAX_STORED_PAIRS = 1000;
/** Pairs one page load hydrates and renders. */
const MAX_DISPLAY_PAIRS = 200;
/** Five bound columns per pair against D1's 100-parameter statement cap. */
const INSERT_CHUNK = 20;
/** Ids per `inArray`, against the same cap. */
const ID_CHUNK = 90;

const LEADING_ARTICLES = new Set(["the", "a", "an"]);

export interface SweepRow {
  id: string;
  /** The name the block key comes from, without city or year. */
  blockName: string;
  /** The string the similarity score compares. */
  compare: string;
  /** An external identity (Google place id); equal keys are a near-certain match. */
  exactKey?: string | null;
}

export interface PlannedPair {
  entity1Id: string;
  entity2Id: string;
  similarity: number;
}

export function blockKey(name: string): string {
  const tokens = normalizeString(name).split(" ").filter(Boolean);
  while (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0])) tokens.shift();
  return tokens.join("").slice(0, 4);
}

function pushTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Pure: every candidate pair at or above `threshold`, highest first. */
export function planBlockedPairs(
  rows: SweepRow[],
  threshold: number
): { pairs: PlannedPair[]; comparisons: number } {
  const blocks = new Map<string, SweepRow[]>();
  const exact = new Map<string, SweepRow[]>();
  for (const row of rows) {
    const key = blockKey(row.blockName);
    if (key) pushTo(blocks, key, row);
    if (row.exactKey) pushTo(exact, row.exactKey, row);
  }

  const pairs: PlannedPair[] = [];
  const decided = new Set<string>();
  let comparisons = 0;

  const addPair = (a: SweepRow, b: SweepRow, similarity: number) => {
    const [entity1Id, entity2Id] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    pairs.push({ entity1Id, entity2Id, similarity: Math.round(similarity * 100) / 100 });
  };
  const pairKey = (a: SweepRow, b: SweepRow) =>
    a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;

  // Exact-identity pairs first: they can have unrelated names, so no name block
  // would ever pair them.
  for (const group of exact.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        decided.add(pairKey(group[i], group[j]));
        comparisons++;
        addPair(group[i], group[j], 0.99);
      }
    }
  }

  for (const group of blocks.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (decided.size > 0 && decided.has(pairKey(group[i], group[j]))) continue;
        comparisons++;
        const similarity = combinedSimilarity(group[i].compare, group[j].compare, 0.6, threshold);
        if (similarity >= threshold) addPair(group[i], group[j], similarity);
      }
    }
  }

  pairs.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.entity1Id.localeCompare(b.entity1Id) ||
      a.entity2Id.localeCompare(b.entity2Id)
  );
  return { pairs, comparisons };
}

const liveWhere = {
  venues: () => ne(venues.status, "INACTIVE"),
  events: () => and(isNull(events.mergedInto), ne(events.status, "REJECTED")),
  vendors: () => isNull(vendors.deletedAt),
  promoters: () => undefined,
};

/** Narrow columns only: this reads a whole table inside one Worker's memory. */
async function loadSweepRows(db: Database, type: DuplicateEntityType): Promise<SweepRow[]> {
  switch (type) {
    case "venues": {
      const rows = await db
        .select({
          id: venues.id,
          name: venues.name,
          city: venues.city,
          state: venues.state,
          googlePlaceId: venues.googlePlaceId,
        })
        .from(venues)
        .where(liveWhere.venues());
      return rows.map((r) => ({
        id: r.id,
        blockName: r.name ?? "",
        compare: getVenueComparisonString(r),
        exactKey: r.googlePlaceId,
      }));
    }
    case "events": {
      const rows = await db
        .select({
          id: events.id,
          name: events.name,
          startDate: events.startDate,
          venueName: venues.name,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .where(liveWhere.events());
      return rows.map((r) => ({
        id: r.id,
        // Strips ordinals and the trailing year, so "38th Annual X" and
        // "39th Annual X" land in one block.
        blockName: normalizeName(r.name ?? ""),
        compare: getEventComparisonString({
          name: r.name,
          startDate: r.startDate,
          venue: r.venueName ? { name: r.venueName } : null,
        }),
      }));
    }
    case "vendors": {
      const rows = await db
        .select({ id: vendors.id, businessName: vendors.businessName })
        .from(vendors)
        .where(liveWhere.vendors());
      return rows.map((r) => ({
        id: r.id,
        blockName: r.businessName ?? "",
        compare: getVendorComparisonString(r),
      }));
    }
    case "promoters": {
      const rows = await db
        .select({ id: promoters.id, companyName: promoters.companyName })
        .from(promoters);
      return rows.map((r) => ({
        id: r.id,
        blockName: r.companyName ?? "",
        compare: getPromoterComparisonString(r),
      }));
    }
  }
}

async function countLive(db: Database, type: DuplicateEntityType): Promise<number> {
  const table = { venues, events, vendors, promoters }[type];
  const [r] = await db.select({ n: count() }).from(table).where(liveWhere[type]());
  return r?.n ?? 0;
}

export interface FullSweepResult {
  type: DuplicateEntityType;
  runId: string;
  checkedCount: number;
  liveCount: number;
  comparisons: number;
  pairCount: number;
  storedPairCount: number;
}

export async function runFullDuplicateSweep(
  db: Database,
  type: DuplicateEntityType,
  opts: { now: Date }
): Promise<FullSweepResult> {
  const rows = await loadSweepRows(db, type);
  const liveCount = await countLive(db, type);
  const { pairs, comparisons } = planBlockedPairs(rows, STORED_MIN_SIMILARITY);
  const stored = pairs.slice(0, MAX_STORED_PAIRS);
  const runId = crypto.randomUUID();

  for (let i = 0; i < stored.length; i += INSERT_CHUNK) {
    await db
      .insert(entityDuplicateSweepPairs)
      .values(stored.slice(i, i + INSERT_CHUNK).map((p) => ({ ...p, runId, entityType: type })));
  }

  // Read back before the cut-over: until the run row moves, readers keep the
  // previous result, so a short write can't replace good data with partial data.
  const [written] = await db
    .select({ n: count() })
    .from(entityDuplicateSweepPairs)
    .where(eq(entityDuplicateSweepPairs.runId, runId));
  if ((written?.n ?? 0) !== stored.length) {
    throw new Error(
      `full sweep ${type}: wrote ${written?.n ?? 0} of ${stored.length} pairs; run not published`
    );
  }

  const run = {
    runId,
    lastRunAt: opts.now,
    checkedCount: rows.length,
    liveCount,
    comparisons,
    pairCount: pairs.length,
    storedPairCount: stored.length,
  };
  await db
    .insert(entityDuplicateSweepRuns)
    .values({ entityType: type, ...run })
    .onConflictDoUpdate({ target: entityDuplicateSweepRuns.entityType, set: run });

  await db
    .delete(entityDuplicateSweepPairs)
    .where(
      and(
        eq(entityDuplicateSweepPairs.entityType, type),
        ne(entityDuplicateSweepPairs.runId, runId)
      )
    );

  return {
    type,
    runId,
    checkedCount: rows.length,
    liveCount,
    comparisons,
    pairCount: pairs.length,
    storedPairCount: stored.length,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Hydrated = Record<string, unknown> & { id: string };

/** Full rows with the counts the merge UI shows. Live rows only, so a pair merged since the run drops out. */
async function hydrate(
  db: Database,
  type: DuplicateEntityType,
  ids: string[]
): Promise<Map<string, Hydrated>> {
  const out = new Map<string, Hydrated>();
  for (const part of chunk(ids, ID_CHUNK)) {
    if (type === "venues") {
      const rows = await db
        .select()
        .from(venues)
        .where(and(inArray(venues.id, part), liveWhere.venues()));
      const counts = await db
        .select({ id: events.venueId, n: count() })
        .from(events)
        .where(inArray(events.venueId, part))
        .groupBy(events.venueId);
      const byId = new Map(counts.map((c) => [c.id, c.n]));
      for (const r of rows) out.set(r.id, { ...r, _count: { events: byId.get(r.id) ?? 0 } });
    } else if (type === "events") {
      const rows = await db
        .select({ event: events, venueName: venues.name, promoterName: promoters.companyName })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(inArray(events.id, part), liveWhere.events()));
      const counts = await db
        .select({ id: eventVendors.eventId, n: count() })
        .from(eventVendors)
        .where(inArray(eventVendors.eventId, part))
        .groupBy(eventVendors.eventId);
      const byId = new Map(counts.map((c) => [c.id, c.n]));
      for (const r of rows) {
        out.set(r.event.id, {
          ...r.event,
          venue: r.venueName ? { name: r.venueName } : null,
          promoter: r.promoterName ? { companyName: r.promoterName } : null,
          _count: { eventVendors: byId.get(r.event.id) ?? 0 },
        });
      }
    } else if (type === "vendors") {
      const rows = await db
        .select()
        .from(vendors)
        .where(and(inArray(vendors.id, part), liveWhere.vendors()));
      const counts = await db
        .select({ id: eventVendors.vendorId, n: count() })
        .from(eventVendors)
        .where(inArray(eventVendors.vendorId, part))
        .groupBy(eventVendors.vendorId);
      const byId = new Map(counts.map((c) => [c.id, c.n]));
      for (const r of rows) out.set(r.id, { ...r, _count: { eventVendors: byId.get(r.id) ?? 0 } });
    } else {
      const rows = await db.select().from(promoters).where(inArray(promoters.id, part));
      const counts = await db
        .select({ id: events.promoterId, n: count() })
        .from(events)
        .where(inArray(events.promoterId, part))
        .groupBy(events.promoterId);
      const byId = new Map(counts.map((c) => [c.id, c.n]));
      for (const r of rows) out.set(r.id, { ...r, _count: { events: byId.get(r.id) ?? 0 } });
    }
  }
  return out;
}

export async function loadStoredDuplicates(
  db: Database,
  type: DuplicateEntityType,
  threshold: number
) {
  const [run] = await db
    .select()
    .from(entityDuplicateSweepRuns)
    .where(eq(entityDuplicateSweepRuns.entityType, type))
    .limit(1);
  if (!run) return null;

  const pairs = await db
    .select()
    .from(entityDuplicateSweepPairs)
    .where(
      and(
        eq(entityDuplicateSweepPairs.runId, run.runId),
        gte(entityDuplicateSweepPairs.similarity, threshold)
      )
    )
    .orderBy(desc(entityDuplicateSweepPairs.similarity))
    .limit(MAX_DISPLAY_PAIRS);

  const ids = [...new Set(pairs.flatMap((p) => [p.entity1Id, p.entity2Id]))];
  const entities = await hydrate(db, type, ids);
  const duplicates = pairs.flatMap((p) => {
    const entity1 = entities.get(p.entity1Id);
    const entity2 = entities.get(p.entity2Id);
    return entity1 && entity2
      ? [{ entity1, entity2, similarity: p.similarity, matchedFields: ["name"] }]
      : [];
  });
  return { run, duplicates };
}
