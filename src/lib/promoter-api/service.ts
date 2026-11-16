/**
 * OPE-1620 — what the promoter API does, on the OPE-1618 import's write path.
 *
 *  - A NEW external_id goes through the import's preview (dedup) and then:
 *      new       → createEvent: a PENDING event, every value cited to the API
 *                  call (provenance `promoter_api`, the key_id in the citation);
 *      own match → the ref is bound to that event and the changes are staged;
 *      another promoter's event → 409, the import's rule.
 *  - A KNOWN external_id never dedups: its ref names the event, and the row is
 *    staged against it exactly like an import `match` (nothing is written to
 *    the live event; a `promoter_import_update` flag when something differs).
 *  - Cancel stages status → CANCELLED with a `promoter_cancel_request` flag.
 *
 * The ref is CLAIMED before the event is created (ON CONFLICT DO NOTHING on
 * UNIQUE(promoter, external_id)), so two concurrent first posts of one
 * external_id create one event. A claim whose create never finished is
 * reclaimed after CLAIM_STALE_MS.
 *
 * OPE-1625 — DRY RUN (`caller.dryRun`). The same functions decide, and every
 * write is behind a `!c.dryRun` check: no ref claim or release, no merge-hop
 * re-point, no event, no import-ledger row, no review flag. A dry run returns
 * the result the real call WOULD return (a would-be create has no event id).
 * The route also hands a dry run a `readOnlyDb`, whose writes throw, so a
 * write this file forgot to gate fails loudly instead of happening.
 */
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { events, promoterApiEventRefs, venues } from "@/lib/db/schema";
import {
  createEvent,
  diffAgainstEvent,
  previewRows,
  stageCancellation,
  stageUpdateForEvent,
  type CommitContext,
} from "@/lib/promoter-import/run";
import type { ImportField } from "@/lib/promoter-import/rows";
import { NOT_COMPARED_ON_UPDATE, parseApiRow, type FieldError } from "./fields";

type Db = ReturnType<typeof getCloudflareDb>;

export const CLAIM_STALE_MS = 120_000;
export const LIST_PAGE_MAX = 100;

export interface Caller {
  keyId: string;
  promoterId: string;
  promoterUserId: string | null;
  requestId: string;
  now: Date;
  /** OPE-1625 — decide only; write nothing. */
  dryRun?: boolean;
  /** OPE-1625 — the request was signed with a TEST key: every write is a dry run. */
  testKey?: boolean;
}

export type Outcome = "created" | "update_staged" | "unchanged" | "cancel_staged";

export type ServiceResult =
  | {
      ok: true;
      httpStatus: 200 | 201;
      body: {
        external_id: string;
        /** Null only on a dry run's would-be create. */
        event_id: string | null;
        outcome: Outcome;
        status: string;
        changes?: Record<string, { current: string | null; proposed: string | null }>;
        not_compared?: string[];
        warnings?: string[];
      };
    }
  | {
      ok: false;
      httpStatus: 404 | 409 | 422;
      code: string;
      message: string;
      errors?: FieldError[];
      event_id?: string;
    };

const ymd = (d: Date | null | undefined) =>
  d instanceof Date && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;

function ctxFor(c: Caller, externalId: string): CommitContext {
  return {
    promoterId: c.promoterId,
    // One ledger row per signed request: (key, request id) is unique (replay check).
    fileHash: `api:${c.keyId}:${c.requestId}`,
    fileName: null,
    uploadedBy: c.promoterUserId,
    channel: "api",
    now: c.now,
    source: {
      url: `promoter-api:${c.keyId}#external_id=${encodeURIComponent(externalId)}`,
      name: "Promoter API",
      provenanceKind: "promoter_api",
      notes: { key_id: c.keyId, external_id: externalId, request_id: c.requestId },
    },
  };
}

async function findRef(db: Db, promoterId: string, externalId: string) {
  const [ref] = await db
    .select()
    .from(promoterApiEventRefs)
    .where(
      and(
        eq(promoterApiEventRefs.promoterId, promoterId),
        eq(promoterApiEventRefs.externalId, externalId)
      )
    )
    .limit(1);
  return ref ?? null;
}

/** The ref's event, following one merge hop (merge_events leaves a tombstone). */
async function refEvent(db: Db, refId: string, eventId: string, now: Date, dryRun = false) {
  const [e] = await db
    .select({ id: events.id, status: events.status, mergedInto: events.mergedInto })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!e?.mergedInto) return e ?? null;
  const [keeper] = await db
    .select({ id: events.id, status: events.status, mergedInto: events.mergedInto })
    .from(events)
    .where(eq(events.id, e.mergedInto))
    .limit(1);
  if (!keeper) return e;
  if (dryRun) return keeper;
  await db
    .update(promoterApiEventRefs)
    .set({ eventId: keeper.id, updatedAt: now })
    .where(eq(promoterApiEventRefs.id, refId));
  return keeper;
}

const touchRef = (db: Db, refId: string, now: Date) =>
  db.update(promoterApiEventRefs).set({ updatedAt: now }).where(eq(promoterApiEventRefs.id, refId));

const notCompared = (supplied: ImportField[]) =>
  supplied.filter((f) => NOT_COMPARED_ON_UPDATE.has(f));

/** Stage a parsed row against an existing event (the known-ref path). */
async function stageAgainst(
  db: Db,
  c: Caller,
  externalId: string,
  refId: string,
  eventId: string,
  status: string,
  cells: Partial<Record<ImportField, string>>
): Promise<ServiceResult> {
  const { row, errors } = parseApiRow(cells);
  if (!row.value)
    return {
      ok: false,
      httpStatus: 422,
      code: "validation_failed",
      message: "Invalid fields.",
      errors,
    };
  const changes = c.dryRun
    ? row.value
      ? await diffAgainstEvent(db, eventId, row.value)
      : {}
    : (await stageUpdateForEvent(db, ctxFor(c, externalId), row, eventId)).changes;
  if (!c.dryRun) await touchRef(db, refId, c.now);
  const changed = Object.keys(changes).length > 0;
  const nc = notCompared(Object.keys(cells) as ImportField[]);
  return {
    ok: true,
    httpStatus: 200,
    body: {
      external_id: externalId,
      event_id: eventId,
      outcome: changed ? "update_staged" : "unchanged",
      status,
      changes,
      ...(nc.length ? { not_compared: nc } : {}),
      ...(row.warnings.length ? { warnings: row.warnings } : {}),
    },
  };
}

/** Claim the ref for a first post. Null when another request holds a live claim. */
async function claimRef(db: Db, c: Caller, externalId: string): Promise<string | null> {
  const insert = () =>
    db
      .insert(promoterApiEventRefs)
      .values({
        promoterId: c.promoterId,
        externalId,
        eventId: null,
        keyId: c.keyId,
        createdAt: c.now,
        updatedAt: c.now,
      })
      .onConflictDoNothing()
      .returning({ id: promoterApiEventRefs.id });
  let res = await insert();
  if (res.length) return res[0].id;
  // A claim left by a create that never finished (worker died mid-request).
  await db
    .delete(promoterApiEventRefs)
    .where(
      and(
        eq(promoterApiEventRefs.promoterId, c.promoterId),
        eq(promoterApiEventRefs.externalId, externalId),
        isNull(promoterApiEventRefs.eventId),
        lt(promoterApiEventRefs.updatedAt, new Date(c.now.getTime() - CLAIM_STALE_MS))
      )
    );
  res = await insert();
  return res.length ? res[0].id : null;
}

const releaseClaim = (db: Db, refId: string) =>
  db
    .delete(promoterApiEventRefs)
    .where(and(eq(promoterApiEventRefs.id, refId), isNull(promoterApiEventRefs.eventId)));

const inProgress = (): ServiceResult => ({
  ok: false,
  httpStatus: 409,
  code: "in_progress",
  message: "Another request for this external_id is still being processed. Retry in a moment.",
});

/** POST /api/v1/promoter/events — create or stage. */
export async function upsertEvent(
  db: Db,
  c: Caller,
  externalId: string,
  cells: Partial<Record<ImportField, string>>
): Promise<ServiceResult> {
  // Validate first: a bad body never claims a ref.
  const { row, errors } = parseApiRow(cells);
  if (!row.value)
    return {
      ok: false,
      httpStatus: 422,
      code: "validation_failed",
      message: "Invalid fields.",
      errors,
    };

  const existing = await findRef(db, c.promoterId, externalId);
  if (existing?.eventId) {
    const e = await refEvent(db, existing.id, existing.eventId, c.now, c.dryRun);
    if (e) return stageAgainst(db, c, externalId, existing.id, e.id, e.status, cells);
  }

  // A dry run claims nothing; a fresh claim another request holds is still "in progress".
  if (
    c.dryRun &&
    existing &&
    !existing.eventId &&
    existing.updatedAt.getTime() >= c.now.getTime() - CLAIM_STALE_MS
  )
    return inProgress();
  const refId = c.dryRun ? null : await claimRef(db, c, externalId);
  if (!refId && !c.dryRun) return inProgress();
  const release = async () => {
    if (refId) await releaseClaim(db, refId);
  };
  try {
    const ctx = ctxFor(c, externalId);
    const [p] = await previewRows(db, {
      promoterId: c.promoterId,
      fileHash: ctx.fileHash,
      rows: [row],
    });
    if (p.status === "error" || p.status === "already_imported") {
      await release();
      if (p.event)
        return {
          ok: false,
          httpStatus: 409,
          code: "conflict_other_promoter",
          message: p.errors.join(" ") || "This matches an event another organizer lists.",
        };
      return {
        ok: false,
        httpStatus: 422,
        code: "validation_failed",
        message: "Invalid fields.",
        errors: p.errors.map((m) => ({ field: null, message: m })),
      };
    }
    if (p.status === "match") {
      const eventId = p.event!.id;
      const [other] = await db
        .select({ externalId: promoterApiEventRefs.externalId })
        .from(promoterApiEventRefs)
        .where(
          and(
            eq(promoterApiEventRefs.promoterId, c.promoterId),
            eq(promoterApiEventRefs.eventId, eventId)
          )
        )
        .limit(1);
      if (other) {
        await release();
        return {
          ok: false,
          httpStatus: 409,
          code: "conflict_external_id",
          message: `This matches your event already linked to external_id "${other.externalId}". Use that id.`,
          event_id: eventId,
        };
      }
      if (refId)
        await db
          .update(promoterApiEventRefs)
          .set({ eventId, updatedAt: c.now })
          .where(eq(promoterApiEventRefs.id, refId));
      return stageAgainst(db, c, externalId, refId ?? "", eventId, p.event!.status, cells);
    }
    if (c.dryRun || !refId)
      return {
        ok: true,
        httpStatus: 201,
        body: {
          external_id: externalId,
          event_id: null,
          outcome: "created",
          status: "PENDING",
          ...(row.warnings.length ? { warnings: row.warnings } : {}),
        },
      };
    const created = await createEvent(db, ctx, row);
    if (created.outcome !== "created" || !created.event_id) {
      await release();
      return {
        ok: false,
        httpStatus: 422,
        code: "validation_failed",
        message: created.reason ?? "The event could not be created.",
        errors: [{ field: null, message: created.reason ?? "The event could not be created." }],
      };
    }
    await db
      .update(promoterApiEventRefs)
      .set({ eventId: created.event_id, updatedAt: c.now })
      .where(eq(promoterApiEventRefs.id, refId));
    return {
      ok: true,
      httpStatus: 201,
      body: {
        external_id: externalId,
        event_id: created.event_id,
        outcome: "created",
        status: "PENDING",
        ...(row.warnings.length ? { warnings: row.warnings } : {}),
      },
    };
  } catch (e) {
    await release();
    throw e;
  }
}

const notFound = (externalId: string): ServiceResult => ({
  ok: false,
  httpStatus: 404,
  code: "not_found",
  message: `No event with external_id "${externalId}" for this key's promoter.`,
});

/** The ref and its live event, or the error to return. */
async function resolveKnown(db: Db, c: Caller, externalId: string) {
  const ref = await findRef(db, c.promoterId, externalId);
  if (!ref) return { error: notFound(externalId) };
  if (!ref.eventId) return { error: inProgress() };
  const e = await refEvent(db, ref.id, ref.eventId, c.now, c.dryRun);
  if (!e) return { error: notFound(externalId) };
  return { ref, event: e };
}

/**
 * PATCH /api/v1/promoter/events/{external_id} — a partial update, staged. The
 * fields the parser requires but the patch omits are filled from the event as
 * it stands, so they propose nothing.
 */
export async function patchEvent(
  db: Db,
  c: Caller,
  externalId: string,
  cells: Partial<Record<ImportField, string>>
): Promise<ServiceResult> {
  if (!Object.keys(cells).length)
    return {
      ok: false,
      httpStatus: 422,
      code: "validation_failed",
      message: "No fields to change.",
      errors: [{ field: null, message: "Send at least one field to change." }],
    };
  const known = await resolveKnown(db, c, externalId);
  if ("error" in known) return known.error!;
  const [cur] = await db
    .select({
      name: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      stateCode: events.stateCode,
      city: venues.city,
      venueState: venues.state,
    })
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .where(eq(events.id, known.event.id))
    .limit(1);
  const filled: Partial<Record<ImportField, string>> = {
    name: cur?.name ?? "",
    start_date: ymd(cur?.startDate) ?? "",
    end_date: ymd(cur?.endDate) ?? "",
    // City/state are not compared on update (NOT_COMPARED_ON_UPDATE); they only
    // satisfy the parser's required columns.
    city: cur?.city || "-",
    state: cur?.venueState || cur?.stateCode || "NH",
    ...cells,
  };
  // A one-day event moved by its start date alone moves its end with it.
  if (cells.start_date && !cells.end_date && ymd(cur?.startDate) === ymd(cur?.endDate))
    filled.end_date = cells.start_date;
  const result = await stageAgainst(
    db,
    c,
    externalId,
    known.ref.id,
    known.event.id,
    known.event.status,
    filled
  );
  if (result.ok) {
    const nc = notCompared(Object.keys(cells) as ImportField[]);
    if (nc.length) result.body.not_compared = nc;
    else delete result.body.not_compared;
  }
  return result;
}

/** POST /api/v1/promoter/events/{external_id}/cancel — staged, never direct. */
export async function cancelEvent(
  db: Db,
  c: Caller,
  externalId: string,
  reason: string | null
): Promise<ServiceResult> {
  const known = await resolveKnown(db, c, externalId);
  if ("error" in known) return known.error!;
  const { ref, event } = known;
  if (event.status === "CANCELLED") {
    if (!c.dryRun) await touchRef(db, ref.id, c.now);
    return {
      ok: true,
      httpStatus: 200,
      body: {
        external_id: externalId,
        event_id: event.id,
        outcome: "unchanged",
        status: event.status,
      },
    };
  }
  if (!c.dryRun) {
    await stageCancellation(db, ctxFor(c, externalId), event.id, event.status, reason);
    await touchRef(db, ref.id, c.now);
  }
  return {
    ok: true,
    httpStatus: 200,
    body: {
      external_id: externalId,
      event_id: event.id,
      outcome: "cancel_staged",
      status: event.status,
      // What the staged request proposes (the ledger row's proposed_changes).
      ...(c.dryRun
        ? {
            changes: {
              status: { current: event.status, proposed: "CANCELLED" },
              ...(reason ? { reason: { current: null, proposed: reason } } : {}),
            },
          }
        : {}),
    },
  };
}

/** GET /api/v1/promoter/events — this promoter's refs, ordered by external_id, keyset-paged. */
export async function listRefs(
  db: Db,
  promoterId: string,
  opts: { limit: number; cursor: string | null }
) {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit) || 50), LIST_PAGE_MAX);
  const rows = await db
    .select({
      external_id: promoterApiEventRefs.externalId,
      event_id: promoterApiEventRefs.eventId,
      status: events.status,
      name: events.name,
      start_date: events.startDate,
      updated_at: promoterApiEventRefs.updatedAt,
    })
    .from(promoterApiEventRefs)
    .leftJoin(events, eq(events.id, promoterApiEventRefs.eventId))
    .where(
      and(
        eq(promoterApiEventRefs.promoterId, promoterId),
        opts.cursor ? gt(promoterApiEventRefs.externalId, opts.cursor) : undefined
      )
    )
    .orderBy(asc(promoterApiEventRefs.externalId))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      external_id: r.external_id,
      event_id: r.event_id,
      status: r.event_id ? (r.status ?? null) : "PROCESSING",
      name: r.name ?? null,
      start_date: ymd(r.start_date),
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : null,
    })),
    next_cursor: rows.length > limit ? page[page.length - 1].external_id : null,
  };
}
