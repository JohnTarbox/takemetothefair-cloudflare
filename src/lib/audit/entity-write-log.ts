/**
 * OPE-830 — record what a save actually did, including when it did nothing.
 *
 * ## The instrument gap this closes
 *
 * Two live "my vendor profile won't save" reports in ten days (2026-08-27,
 * 2026-09-06) could not be settled, because nothing recorded what any save
 * wrote. `enrichment_log` was the nearest thing and it has two blind spots:
 *
 * **It records successes only.** The vendor-profile PATCH rejects unverified
 * callers at `requireVerifiedSession()`, which returns above the route's first
 * `logError`. So a rejected save leaves no trace at all, and *"we have no
 * record of a save"* is indistinguishable from *"no save was attempted"*.
 * That single ambiguity is what made OPE-830 unanswerable — the specimen
 * vendor uploaded a photo at 21:47:53 (session gate) and verified his email at
 * 21:51:18 (edit gate), and whether he typed into the form during those 3½
 * minutes is exactly what nothing can say.
 *
 * **`fields_changed` does not mean changed fields.** It is
 * `Object.keys(updateData)` — the fields *present in the payload*. On the
 * specimen vendor it is byte-identical across all 18 saves, and would be
 * identical on a no-op resubmit. A change log that cannot distinguish a change
 * from a resubmit is not a change log.
 *
 * ## The two things that make this one different
 *
 * 1. **`outcome` is explicit**, and `rejected` is a first-class row rather
 *    than an absence. An absence now means "the request never reached us".
 * 2. **`changes` is a real diff** against the stored row, so a resubmit
 *    records `noop` with `[]` and a real edit records what moved.
 *
 * ⚠️ `changes` is NULL on a rejected row, never `[]`. Nothing was compared,
 * which is not the same as "compared and found nothing" — and the whole
 * defect family behind this ticket is two different facts sharing one value.
 */
import type { Db } from "@/lib/analytics-overview/shared";
import { entityWriteLog } from "@/lib/db/schema";

/** Which surface produced the write. Mirrors `enrichment_log.source`. */
export type WriteSource = "vendor_self" | "admin_ui" | "mcp" | "system";

/** What the write did. See the note above on why `noop` is separate. */
export type WriteOutcome = "applied" | "noop" | "rejected";

/**
 * Why a write was refused.
 *
 * `email_unverified` is the one OPE-830 turned on: the vendor-profile edit
 * gate. The others exist so the same helper covers every early return rather
 * than only the interesting one — a logger wired to a single branch would
 * still leave most rejections invisible.
 */
export type RejectReason =
  | "email_unverified"
  | "validation"
  | "not_found"
  | "forbidden"
  | "role_gate";

/**
 * Cap on a single stored value.
 *
 * The specimen's description is 1,177 characters, and storing before+after on
 * every one of 18 saves would put ~42 KB of duplicated prose in the log for a
 * single vendor's afternoon. 200 characters is enough to see *what changed*
 * without the table becoming a second copy of the content.
 */
export const VALUE_CAP = 200;

export interface FieldChange {
  field: string;
  before: string | null;
  after: string | null;
  /**
   * Present only when a side was cut at `VALUE_CAP`.
   *
   * ⚠️ A flag rather than an ellipsis in the string: a value that genuinely
   * ends in "..." and a value we truncated must not read the same to whoever
   * debugs the next report.
   */
  truncated?: true;
}

/** Stringify for comparison. NULL and "" are distinct and stay distinct. */
function normalize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function cap(v: string | null): { value: string | null; truncated: boolean } {
  if (v === null || v.length <= VALUE_CAP) return { value: v, truncated: false };
  return { value: v.slice(0, VALUE_CAP), truncated: true };
}

/**
 * Diff an update payload against the stored row.
 *
 * ⚠️ Only keys present in `payload` are considered. A patch-style writer omits
 * what it is not changing, and treating an absent key as "set to undefined"
 * would report every unsent column as a deletion.
 *
 * ⚠️ NULL vs "" is a real difference and is reported as one. That distinction
 * is what proved the OPE-830 write was landing complete: the specimen's empty
 * columns are `''`, and `''` appears on only 31 of 7,067 vendor rows, so it
 * was written rather than defaulted. A differ that treated them as equal would
 * have destroyed the evidence that settled it.
 */
export function diffFields(
  before: Record<string, unknown>,
  payload: Record<string, unknown>,
  options: { ignore?: readonly string[] } = {}
): FieldChange[] {
  const ignore = new Set(options.ignore ?? []);
  const changes: FieldChange[] = [];

  for (const key of Object.keys(payload)) {
    if (ignore.has(key)) continue;
    const b = normalize(before[key]);
    const a = normalize(payload[key]);
    if (b === a) continue;
    const cb = cap(b);
    const ca = cap(a);
    const change: FieldChange = { field: key, before: cb.value, after: ca.value };
    if (cb.truncated || ca.truncated) change.truncated = true;
    changes.push(change);
  }
  return changes;
}

/**
 * Fields excluded from every diff.
 *
 * `updatedAt` is set by the writer on every save and is declared
 * `.$onUpdateFn()` besides, so it changes unconditionally — leaving it in
 * would make every no-op look like a change and `outcome: "noop"` unreachable.
 * That would quietly disable the distinction this table exists for.
 */
export const ALWAYS_IGNORED = ["updatedAt", "updated_at"] as const;

export interface RecordWriteParams {
  entityType: string;
  entityId: string;
  source: WriteSource;
  actorUserId?: string | null;
  /** Omit for a rejected write — there is nothing to diff. */
  changes?: FieldChange[];
  /** Required when, and only when, the write was refused. */
  rejectReason?: RejectReason;
  at?: Date;
}

/**
 * Append one row.
 *
 * ⚠️ Never throws. An audit write that can fail a save turns an instrument
 * into an outage — and this one runs on the rejection path, where the request
 * is already failing. It logs to console and returns.
 */
export async function recordEntityWrite(db: Db, p: RecordWriteParams): Promise<void> {
  const outcome: WriteOutcome = p.rejectReason
    ? "rejected"
    : (p.changes?.length ?? 0) > 0
      ? "applied"
      : "noop";

  try {
    await db.insert(entityWriteLog).values({
      entityType: p.entityType,
      entityId: p.entityId,
      source: p.source,
      outcome,
      rejectReason: p.rejectReason ?? null,
      // NULL on rejected — nothing was compared. `[]` would claim we compared
      // and found no differences, which is a different and false statement.
      changesJson: p.rejectReason ? null : JSON.stringify(p.changes ?? []),
      actorUserId: p.actorUserId ?? null,
      createdAt: p.at ?? new Date(),
    });
  } catch (err) {
    console.error("entity_write_log insert failed", err);
  }
}
