/**
 * OPE-1120 — what a promoter merge must do to the loser's rows that the
 * database will not do for it.
 *
 * Both merge paths (the `merge_promoter` MCP tool and the app's
 * /api/admin/duplicates/merge) reassigned `events.promoter_id` and then
 * HARD-DELETED the loser. Every table that points at promoters WITHOUT a
 * declared FK was left holding the dead id: measured 2026-09-22, 24
 * `promoter_enrichment_candidates` (20 still `pending` in the review queue,
 * proposing values for a promoter that no longer exists), 5
 * `pending_search_pings`, 2 `image_coverage_state` rows.
 *
 * One function, called by BOTH paths before the delete, so a fix here cannot
 * reach one path and miss the other — the shape of the original defect.
 *
 * Deliberately NOT touched: `enrichment_log` — a log keeps the historical id.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Staged enrichment field → the promoter column it would write. Same six the
 * enrichment dispatch and review tools map (both keep a private copy).
 */
export const PROMOTER_ENRICHMENT_FIELD_TO_COLUMN = {
  hero: "heroImageUrl",
  logo: "logoUrl",
  description: "description",
  social_links: "socialLinks",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
} as const satisfies Record<string, keyof typeof schema.promoters.$inferSelect>;

/** Marker written to `reviewed_by` on candidates a merge had to decide. */
export const PROMOTER_MERGE_REVIEWER = "system:promoter-merge";

/**
 * OPE-1647 — promoter columns a merge copies from the loser when the keeper's
 * is empty. On 2026-11-12 the loser's phone number had to be copied by hand.
 */
export const PROMOTER_HARVEST_COLUMNS = [
  "website",
  "contactEmail",
  "contactPhone",
  "logoUrl",
  "heroImageUrl",
  "socialLinks",
  "city",
  "state",
  "description",
] as const satisfies ReadonlyArray<keyof typeof schema.promoters.$inferSelect>;

/** Per-table outcome for the loser's rows. `deleted` is rows the delete would still take. */
export interface PromoterChildTableCount {
  moved: number;
  droppedAsDuplicate: number;
  deleted: number;
}

/** A loser row the keeper already has a twin of. The keeper's row wins; the loser's is dropped. */
export interface PromoterChildCollision {
  table: string;
  loserRowId: string;
  keeperRowId: string;
  key: string;
}

export interface PromoterChildRepointResult {
  /** True when nothing was written — the numbers say what a real merge WOULD do. */
  preview: boolean;
  /** Pending candidates moved to the keeper — the keeper's field was still empty. */
  candidatesRetargeted: number;
  /** Pending candidates rejected — the keeper already has a value; moving them would overwrite it. */
  candidatesRejected: number;
  /** Already-decided candidates repointed so their history stays attached to a live promoter. */
  candidatesHistoryRepointed: number;
  /** Search pings repointed (the entity_slug keeps the OLD url, which now 301s — still worth pinging). */
  pingsRepointed: number;
  /** The loser's image-coverage row, deleted — the next scan measures the keeper itself. */
  coverageRowsDeleted: number;
  /** OPE-1647 — every FK child of the loser, by table name. */
  tables: Record<string, PromoterChildTableCount>;
  /** OPE-1647 — keeper-wins collisions, each one named. Never dropped silently. */
  collisions: PromoterChildCollision[];
  /** OPE-1647 — keeper columns that were empty and were filled from the loser. */
  fieldsHarvested: Array<{ column: string; value: string }>;
  warnings: string[];
}

/**
 * OPE-1647 — every table that references promoters, and how this module
 * handles it. The schema-coverage test fails when a promoter-referencing
 * column appears that is in neither this list nor the allowlist below.
 * `events` is reassigned by both callers before they call this function.
 */
export const PROMOTER_CHILD_TABLES_HANDLED = [
  "event_series.promoter_id",
  "inbound_newsletters.promoter_id",
  "promoter_list_arrivals.promoter_id",
  "pending_promoter_contacts.attached_promoter_id",
  "promoters.succeeded_by_promoter_id",
  "promoter_slug_history.promoter_id",
  "promoter_contacts.promoter_id",
  "promoter_outreach_attempts.promoter_id",
  "promoter_list_subscriptions.promoter_id",
  "promoter_event_feeds.promoter_id",
  "feed_discrepancy_batches.promoter_id",
  "promoter_import_rows.promoter_id",
  "promoter_api_keys.promoter_id",
  "promoter_api_event_refs.promoter_id",
  "promoter_enrichment_candidates.promoter_id",
] as const;

/** Promoter-referencing columns deliberately NOT repointed here, with the reason. */
export const PROMOTER_CHILD_TABLES_ALLOWLISTED: Record<string, string> = {
  "events.promoter_id": "reassigned by both merge callers before repointPromoterChildren runs",
};

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "" || v.trim() === "[]" || v.trim() === "{}";
  return false;
}

/** Ids chunked well under D1's 100-bound-parameter cap. */
function chunks<T>(ids: T[], size = 90): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < ids.length; i += size) r.push(ids.slice(i, i + size));
  return r;
}

const count = (moved = 0, droppedAsDuplicate = 0, deleted = 0): PromoterChildTableCount => ({
  moved,
  droppedAsDuplicate,
  deleted,
});

export interface RepointPromoterChildrenOptions {
  /** OPE-1647 — read everything, write nothing, return what a merge would do. */
  preview?: boolean;
  now?: Date;
}

/**
 * Moves every row that references the loser onto the keeper, so the hard
 * delete that follows takes nothing with it (OPE-1120 for the FK-less tables,
 * OPE-1647 for the FK children). Keeper wins every collision on a unique key;
 * the loser's colliding row is dropped AFTER its own children move to the
 * keeper's twin, and each drop is reported in `collisions`.
 *
 * Two passes: a read-only plan, then the writes. With `preview` the second
 * pass is skipped, so the preview and the real merge report from the same plan.
 */
export async function repointPromoterChildren(
  db: Db,
  keeperId: string,
  loserId: string,
  nowOrOptions: Date | RepointPromoterChildrenOptions = {}
): Promise<PromoterChildRepointResult> {
  const opts: RepointPromoterChildrenOptions =
    nowOrOptions instanceof Date ? { now: nowOrOptions } : nowOrOptions;
  const preview = opts.preview ?? false;
  const now = opts.now ?? new Date();
  if (keeperId === loserId)
    throw new Error("repointPromoterChildren: keeper and loser are the same promoter");

  const [keeper] = await db
    .select()
    .from(schema.promoters)
    .where(eq(schema.promoters.id, keeperId))
    .limit(1);
  if (!keeper) throw new Error(`repointPromoterChildren: keeper ${keeperId} not found`);
  const [loser] = await db
    .select()
    .from(schema.promoters)
    .where(eq(schema.promoters.id, loserId))
    .limit(1);
  if (!loser) throw new Error(`repointPromoterChildren: loser ${loserId} not found`);

  const out: PromoterChildRepointResult = {
    preview,
    candidatesRetargeted: 0,
    candidatesRejected: 0,
    candidatesHistoryRepointed: 0,
    pingsRepointed: 0,
    coverageRowsDeleted: 0,
    tables: {},
    collisions: [],
    fieldsHarvested: [],
    warnings: [],
  };
  /** Writes, queued during the plan and run only when not previewing. */
  const writes: Array<() => Promise<unknown>> = [];

  // ── Field harvest (OPE-1647). Planned first, so the candidate decisions
  //    below judge "is the keeper's field empty" against the merged row.
  const keeperAfter: Record<string, unknown> = { ...keeper };
  const harvest: Record<string, unknown> = {};
  for (const col of PROMOTER_HARVEST_COLUMNS) {
    const lv = (loser as Record<string, unknown>)[col];
    if (isEmpty(keeper[col]) && !isEmpty(lv)) {
      harvest[col] = lv;
      keeperAfter[col] = lv;
      out.fieldsHarvested.push({ column: col, value: String(lv) });
    }
  }
  if (Object.keys(harvest).length > 0) {
    writes.push(() =>
      db
        .update(schema.promoters)
        .set({ ...harvest, updatedAt: now })
        .where(eq(schema.promoters.id, keeperId))
    );
  }

  // ── Enrichment candidates (OPE-1120).
  const candidates = await db
    .select({
      id: schema.promoterEnrichmentCandidates.id,
      field: schema.promoterEnrichmentCandidates.proposedField,
      decision: schema.promoterEnrichmentCandidates.decision,
    })
    .from(schema.promoterEnrichmentCandidates)
    .where(eq(schema.promoterEnrichmentCandidates.promoterId, loserId));

  // OPE-1120 — fields the KEEPER already has a pending proposal for.
  // `idx_pec_pending_field` is UNIQUE (promoter_id, proposed_field) WHERE
  // decision='pending', so retargeting a second pending row onto the keeper
  // throws and takes the whole merge down with it. Found during the step-4
  // cleanup: #656 (logo) could not move to lowell-folk-festival, which already
  // held its own pending logo #2551. The keeper's own proposal wins; the
  // loser's is rejected, like any proposal the keeper would clash with.
  const keeperPending = new Set(
    (
      await db
        .select({ field: schema.promoterEnrichmentCandidates.proposedField })
        .from(schema.promoterEnrichmentCandidates)
        .where(
          and(
            eq(schema.promoterEnrichmentCandidates.promoterId, keeperId),
            eq(schema.promoterEnrichmentCandidates.decision, "pending")
          )
        )
    ).map((r) => r.field)
  );

  const retarget: number[] = [];
  const reject: number[] = [];
  const history: number[] = [];
  for (const c of candidates) {
    if (c.decision !== "pending") {
      history.push(c.id);
      continue;
    }
    const column =
      PROMOTER_ENRICHMENT_FIELD_TO_COLUMN[
        c.field as keyof typeof PROMOTER_ENRICHMENT_FIELD_TO_COLUMN
      ];
    // An unknown field has no column to protect: move it and let review decide.
    const keeperValue = column ? keeperAfter[column] : null;
    if (isEmpty(keeperValue) && !keeperPending.has(c.field)) {
      retarget.push(c.id);
      // Two loser rows for one field would collide with each other too.
      keeperPending.add(c.field);
    } else reject.push(c.id);
  }
  for (const ids of chunks([...retarget, ...history])) {
    writes.push(() =>
      db
        .update(schema.promoterEnrichmentCandidates)
        .set({ promoterId: keeperId })
        .where(inArray(schema.promoterEnrichmentCandidates.id, ids))
    );
  }
  for (const ids of chunks(reject)) {
    writes.push(() =>
      db
        .update(schema.promoterEnrichmentCandidates)
        .set({
          promoterId: keeperId,
          decision: "rejected",
          reviewedAt: now,
          reviewedBy: PROMOTER_MERGE_REVIEWER,
        })
        .where(inArray(schema.promoterEnrichmentCandidates.id, ids))
    );
  }
  out.candidatesRetargeted = retarget.length;
  out.candidatesRejected = reject.length;
  out.candidatesHistoryRepointed = history.length;
  out.tables.promoter_enrichment_candidates = count(candidates.length);

  // ── Plain FK children: no unique key involves the promoter, so every row moves.
  const simple = async (
    name: string,
    table:
      | typeof schema.eventSeries
      | typeof schema.inboundNewsletters
      | typeof schema.promoterListArrivals
      | typeof schema.promoterOutreachAttempts
      | typeof schema.promoterApiKeys
      | typeof schema.feedDiscrepancyBatches,
    col:
      | typeof schema.eventSeries.promoterId
      | typeof schema.inboundNewsletters.promoterId
      | typeof schema.promoterListArrivals.promoterId
      | typeof schema.promoterOutreachAttempts.promoterId
      | typeof schema.promoterApiKeys.promoterId
      | typeof schema.feedDiscrepancyBatches.promoterId
  ) => {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(eq(col, loserId));
    out.tables[name] = count(Number(n));
    if (Number(n) > 0)
      writes.push(() =>
        db
          .update(table)
          .set({ promoterId: keeperId } as never)
          .where(eq(col, loserId))
      );
  };
  await simple("event_series", schema.eventSeries, schema.eventSeries.promoterId);
  await simple(
    "inbound_newsletters",
    schema.inboundNewsletters,
    schema.inboundNewsletters.promoterId
  );
  await simple(
    "promoter_list_arrivals",
    schema.promoterListArrivals,
    schema.promoterListArrivals.promoterId
  );
  await simple(
    "promoter_outreach_attempts",
    schema.promoterOutreachAttempts,
    schema.promoterOutreachAttempts.promoterId
  );
  await simple("promoter_api_keys", schema.promoterApiKeys, schema.promoterApiKeys.promoterId);
  // Batches move before any colliding contact is dropped below: a batch on a
  // dropped contact is re-pointed at the keeper's twin first.
  await simple(
    "feed_discrepancy_batches",
    schema.feedDiscrepancyBatches,
    schema.feedDiscrepancyBatches.promoterId
  );

  // pending_promoter_contacts.attached_promoter_id (SET NULL).
  {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.pendingPromoterContacts)
      .where(eq(schema.pendingPromoterContacts.attachedPromoterId, loserId));
    out.tables["pending_promoter_contacts"] = count(Number(n));
    if (Number(n) > 0)
      writes.push(() =>
        db
          .update(schema.pendingPromoterContacts)
          .set({ attachedPromoterId: keeperId })
          .where(eq(schema.pendingPromoterContacts.attachedPromoterId, loserId))
      );
  }

  // promoters.succeeded_by_promoter_id (SET NULL). A pointer at the loser now
  // points at the keeper — except the keeper's own, which would point at itself.
  {
    const pointers = await db
      .select({ id: schema.promoters.id })
      .from(schema.promoters)
      .where(eq(schema.promoters.succeededByPromoterId, loserId));
    const others = pointers.filter((p) => p.id !== keeperId);
    const selfLoop = pointers.length - others.length;
    out.tables["promoters.succeeded_by"] = count(others.length, 0, selfLoop);
    if (selfLoop > 0)
      out.warnings.push(
        "The keeper named the loser as its successor; that pointer is cleared rather than pointed at the keeper itself."
      );
    if (loser.succeededByPromoterId && loser.succeededByPromoterId !== keeperId)
      out.warnings.push(
        `The loser named ${loser.succeededByPromoterId} as its successor; that pointer goes with the loser row.`
      );
    for (const ids of chunks(others.map((p) => p.id)))
      writes.push(() =>
        db
          .update(schema.promoters)
          .set({ succeededByPromoterId: keeperId })
          .where(inArray(schema.promoters.id, ids))
      );
    if (selfLoop > 0)
      writes.push(() =>
        db
          .update(schema.promoters)
          .set({ succeededByPromoterId: null })
          .where(eq(schema.promoters.id, keeperId))
      );
  }

  // promoter_slug_history (CASCADE). The loser's own earlier renames: re-own
  // them and aim them straight at the keeper, one hop (as OPE-1232 did for venues).
  {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.promoterSlugHistory)
      .where(eq(schema.promoterSlugHistory.promoterId, loserId));
    out.tables["promoter_slug_history"] = count(Number(n));
    if (Number(n) > 0)
      writes.push(() =>
        db
          .update(schema.promoterSlugHistory)
          .set({ promoterId: keeperId, newSlug: keeper.slug })
          .where(eq(schema.promoterSlugHistory.promoterId, loserId))
      );
  }

  // ── Children with a unique key on (promoter_id, …): keeper wins.
  //    `keyed` plans: rows to move, and loser rows whose key the keeper holds.
  const keyed = <R extends { id: string }>(
    table: string,
    loserRows: R[],
    keeperRows: R[],
    keyOf: (r: R) => string
  ) => {
    const keeperByKey = new Map(keeperRows.map((r) => [keyOf(r), r.id]));
    const move: string[] = [];
    const drop: Array<{ loserRowId: string; keeperRowId: string }> = [];
    for (const r of loserRows) {
      const k = keyOf(r);
      const twin = keeperByKey.get(k);
      if (twin) {
        drop.push({ loserRowId: r.id, keeperRowId: twin });
        out.collisions.push({ table, loserRowId: r.id, keeperRowId: twin, key: k });
      } else {
        move.push(r.id);
        // Two loser rows with one key would collide with each other too.
        keeperByKey.set(k, r.id);
      }
    }
    out.tables[table] = count(move.length, drop.length);
    return { move, drop };
  };

  // promoter_contacts — UNIQUE (promoter_id, email), compared case-insensitively.
  {
    const sel = () =>
      db
        .select({ id: schema.promoterContacts.id, email: schema.promoterContacts.email })
        .from(schema.promoterContacts);
    const plan = keyed(
      "promoter_contacts",
      await sel().where(eq(schema.promoterContacts.promoterId, loserId)),
      await sel().where(eq(schema.promoterContacts.promoterId, keeperId)),
      (r) => r.email.trim().toLowerCase()
    );
    for (const { loserRowId, keeperRowId } of plan.drop) {
      // Its grandchildren move to the keeper's twin first: batches would
      // CASCADE with it, field pins would lose their contact.
      writes.push(() =>
        db
          .update(schema.feedDiscrepancyBatches)
          .set({ contactId: keeperRowId })
          .where(eq(schema.feedDiscrepancyBatches.contactId, loserRowId))
      );
      writes.push(() =>
        db
          .update(schema.eventFieldPins)
          .set({ contactId: keeperRowId })
          .where(eq(schema.eventFieldPins.contactId, loserRowId))
      );
      writes.push(() =>
        db.delete(schema.promoterContacts).where(eq(schema.promoterContacts.id, loserRowId))
      );
    }
    for (const ids of chunks(plan.move))
      writes.push(() =>
        db
          .update(schema.promoterContacts)
          .set({ promoterId: keeperId })
          .where(inArray(schema.promoterContacts.id, ids))
      );
  }

  // promoter_list_subscriptions — UNIQUE (promoter_id, address). Arrivals name
  // their subscription by id (no FK), so they follow a dropped row to its twin.
  {
    const sel = () =>
      db
        .select({
          id: schema.promoterListSubscriptions.id,
          address: schema.promoterListSubscriptions.address,
        })
        .from(schema.promoterListSubscriptions);
    const plan = keyed(
      "promoter_list_subscriptions",
      await sel().where(eq(schema.promoterListSubscriptions.promoterId, loserId)),
      await sel().where(eq(schema.promoterListSubscriptions.promoterId, keeperId)),
      (r) => r.address.trim().toLowerCase()
    );
    for (const { loserRowId, keeperRowId } of plan.drop) {
      writes.push(() =>
        db
          .update(schema.promoterListArrivals)
          .set({ subscriptionId: keeperRowId })
          .where(eq(schema.promoterListArrivals.subscriptionId, loserRowId))
      );
      writes.push(() =>
        db
          .delete(schema.promoterListSubscriptions)
          .where(eq(schema.promoterListSubscriptions.id, loserRowId))
      );
    }
    for (const ids of chunks(plan.move))
      writes.push(() =>
        db
          .update(schema.promoterListSubscriptions)
          .set({ promoterId: keeperId })
          .where(inArray(schema.promoterListSubscriptions.id, ids))
      );
  }

  // promoter_event_feeds — UNIQUE (promoter_id, feed_url). A dropped feed's
  // items and read history move to the keeper's feed (items the keeper's feed
  // already holds, by external_id, stay behind and go with it); its WebSub
  // subscription is not moved, since the keeper's feed has its own.
  {
    const sel = () =>
      db
        .select({ id: schema.promoterEventFeeds.id, url: schema.promoterEventFeeds.feedUrl })
        .from(schema.promoterEventFeeds);
    const plan = keyed(
      "promoter_event_feeds",
      await sel().where(eq(schema.promoterEventFeeds.promoterId, loserId)),
      await sel().where(eq(schema.promoterEventFeeds.promoterId, keeperId)),
      (r) => r.url.trim()
    );
    let itemsMoved = 0;
    let itemsDropped = 0;
    let readsMoved = 0;
    let websubDropped = 0;
    for (const { loserRowId, keeperRowId } of plan.drop) {
      const twinExt = new Set(
        (
          await db
            .select({ ext: schema.promoterFeedItems.externalId })
            .from(schema.promoterFeedItems)
            .where(eq(schema.promoterFeedItems.feedId, keeperRowId))
        ).map((r) => r.ext)
      );
      const items = await db
        .select({ id: schema.promoterFeedItems.id, ext: schema.promoterFeedItems.externalId })
        .from(schema.promoterFeedItems)
        .where(eq(schema.promoterFeedItems.feedId, loserRowId));
      const moveItems = items.filter((i) => !twinExt.has(i.ext)).map((i) => i.id);
      itemsMoved += moveItems.length;
      itemsDropped += items.length - moveItems.length;
      for (const ids of chunks(moveItems))
        writes.push(() =>
          db
            .update(schema.promoterFeedItems)
            .set({ feedId: keeperRowId })
            .where(inArray(schema.promoterFeedItems.id, ids))
        );
      const [{ n: reads }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.promoterFeedReads)
        .where(eq(schema.promoterFeedReads.feedId, loserRowId));
      readsMoved += Number(reads);
      writes.push(() =>
        db
          .update(schema.promoterFeedReads)
          .set({ feedId: keeperRowId })
          .where(eq(schema.promoterFeedReads.feedId, loserRowId))
      );
      const [{ n: subs }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.feedWebsubSubscriptions)
        .where(eq(schema.feedWebsubSubscriptions.feedId, loserRowId));
      websubDropped += Number(subs);
      writes.push(() =>
        db.delete(schema.promoterEventFeeds).where(eq(schema.promoterEventFeeds.id, loserRowId))
      );
    }
    if (plan.drop.length > 0) {
      out.tables["promoter_feed_items"] = count(itemsMoved, itemsDropped);
      out.tables["promoter_feed_reads"] = count(readsMoved);
      out.tables["feed_websub_subscriptions"] = count(0, 0, websubDropped);
      if (itemsDropped > 0)
        out.warnings.push(
          `${itemsDropped} feed item(s) on the loser's duplicate feed were already on the keeper's feed and are dropped with it.`
        );
    }
    for (const ids of chunks(plan.move))
      writes.push(() =>
        db
          .update(schema.promoterEventFeeds)
          .set({ promoterId: keeperId })
          .where(inArray(schema.promoterEventFeeds.id, ids))
      );
  }

  // promoter_import_rows — UNIQUE (promoter_id, file_hash, row_number).
  {
    const sel = () =>
      db
        .select({
          id: schema.promoterImportRows.id,
          hash: schema.promoterImportRows.fileHash,
          row: schema.promoterImportRows.rowNumber,
        })
        .from(schema.promoterImportRows);
    const plan = keyed(
      "promoter_import_rows",
      await sel().where(eq(schema.promoterImportRows.promoterId, loserId)),
      await sel().where(eq(schema.promoterImportRows.promoterId, keeperId)),
      (r) => `${r.hash}#${r.row}`
    );
    for (const ids of chunks(plan.drop.map((d) => d.loserRowId)))
      writes.push(() =>
        db.delete(schema.promoterImportRows).where(inArray(schema.promoterImportRows.id, ids))
      );
    for (const ids of chunks(plan.move))
      writes.push(() =>
        db
          .update(schema.promoterImportRows)
          .set({ promoterId: keeperId })
          .where(inArray(schema.promoterImportRows.id, ids))
      );
  }

  // promoter_api_event_refs — UNIQUE (promoter_id, external_id). The keeper's
  // ref keeps the external id; the loser's event stays, without an API handle.
  {
    const sel = () =>
      db
        .select({
          id: schema.promoterApiEventRefs.id,
          ext: schema.promoterApiEventRefs.externalId,
        })
        .from(schema.promoterApiEventRefs);
    const plan = keyed(
      "promoter_api_event_refs",
      await sel().where(eq(schema.promoterApiEventRefs.promoterId, loserId)),
      await sel().where(eq(schema.promoterApiEventRefs.promoterId, keeperId)),
      (r) => r.ext
    );
    if (plan.drop.length > 0)
      out.warnings.push(
        `${plan.drop.length} API event ref(s) share an external id with the keeper's; the keeper's ref wins, and the loser's event can no longer be updated through the API by that id.`
      );
    for (const ids of chunks(plan.drop.map((d) => d.loserRowId)))
      writes.push(() =>
        db.delete(schema.promoterApiEventRefs).where(inArray(schema.promoterApiEventRefs.id, ids))
      );
    for (const ids of chunks(plan.move))
      writes.push(() =>
        db
          .update(schema.promoterApiEventRefs)
          .set({ promoterId: keeperId })
          .where(inArray(schema.promoterApiEventRefs.id, ids))
      );
  }

  // ── FK-less polymorphic rows (OPE-1120).
  const [{ n: pingCount }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.pendingSearchPings)
    .where(
      and(
        sql`lower(${schema.pendingSearchPings.entityType}) = 'promoter'`,
        eq(schema.pendingSearchPings.entityId, loserId)
      )
    );
  out.pingsRepointed = Number(pingCount);
  if (out.pingsRepointed > 0)
    writes.push(() =>
      db
        .update(schema.pendingSearchPings)
        .set({ entityId: keeperId })
        .where(
          and(
            sql`lower(${schema.pendingSearchPings.entityType}) = 'promoter'`,
            eq(schema.pendingSearchPings.entityId, loserId)
          )
        )
    );

  // Case-insensitive: the enum says PROMOTER, but the orphan audit that
  // found these queried lower(entity_type), and a guard that misses a
  // lower-cased row is the defect this function exists to close.
  const coverageWhere = and(
    sql`lower(${schema.imageCoverageState.entityType}) = 'promoter'`,
    eq(schema.imageCoverageState.entityId, loserId)
  );
  const [{ n: coverageCount }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.imageCoverageState)
    .where(coverageWhere);
  out.coverageRowsDeleted = Number(coverageCount);
  if (out.coverageRowsDeleted > 0)
    writes.push(() => db.delete(schema.imageCoverageState).where(coverageWhere));

  if (!preview) for (const w of writes) await w();
  return out;
}

/**
 * OPE-1125 — a plain DELETE has no keeper to repoint to, so the loser's
 * FK-less rows are removed instead of orphaned. Only ever called for a promoter
 * that owns ZERO events (the route refuses otherwise), so what is removed is
 * proposals and bookkeeping for an entity that is going away — never content.
 * `enrichment_log` is left alone, as on merge.
 */
export async function deletePromoterChildren(
  db: Db,
  promoterId: string
): Promise<{ candidatesDeleted: number; pingsDeleted: number; coverageRowsDeleted: number }> {
  const candidates = await db
    .delete(schema.promoterEnrichmentCandidates)
    .where(eq(schema.promoterEnrichmentCandidates.promoterId, promoterId))
    .returning({ id: schema.promoterEnrichmentCandidates.id });
  const pings = await db
    .delete(schema.pendingSearchPings)
    .where(
      and(
        sql`lower(${schema.pendingSearchPings.entityType}) = 'promoter'`,
        eq(schema.pendingSearchPings.entityId, promoterId)
      )
    )
    .returning({ id: schema.pendingSearchPings.id });
  const coverage = await db
    .delete(schema.imageCoverageState)
    .where(
      and(
        sql`lower(${schema.imageCoverageState.entityType}) = 'promoter'`,
        eq(schema.imageCoverageState.entityId, promoterId)
      )
    )
    .returning({ id: schema.imageCoverageState.entityId });
  return {
    candidatesDeleted: candidates.length,
    pingsDeleted: pings.length,
    coverageRowsDeleted: coverage.length,
  };
}
