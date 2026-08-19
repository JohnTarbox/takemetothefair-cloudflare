/**
 * OPE-433 scope 5 — make mutations to public-facing rows answerable.
 *
 * `get_admin_action_log` covers event approvals/rejections and vendor status.
 * Venue and `event_days` writes are not audited **at all**, and the ticket's
 * specimen is what that costs: venue `5e6f81ed` was mutated in production at
 * 04:00:20Z on 2026-08-17 — city normalised, address filled, lat/long set — and
 * the candidate causes (an agent, a `venues_geocode` sweep, the mafa.org
 * importer running with `sync_enabled=1`) were **indistinguishable from the
 * evidence**, because there was none.
 *
 * Precedent is OPE-151, which did exactly this for email: "no send is
 * auditable" became `email_send_ledger`, and it worked.
 *
 * Pure. It builds the payload and decides whether one is worth writing; each
 * codebase owns its own insert into `admin_actions`, the same split every other
 * shared rule here uses because app and MCP are separate builds.
 */

/** Entities whose writes must be answerable. */
export type AuditedEntityType = "venue" | "event_day";

export interface MutationAuditInput {
  entityType: AuditedEntityType;
  entityId: string;
  /** create | update | delete — the verb, not the caller. */
  verb: "create" | "update" | "delete";
  /**
   * WHO. A user id when a human did it, otherwise a stable machine identity
   * (`venues_geocode`, `import-url`, `mcp:update_venue`).
   *
   * The specimen's whole problem was that this was unrecoverable, so an
   * anonymous write is worse than no audit row at all — it records that
   * something happened and still cannot say what.
   */
  actor: string;
  /** Values before the write, for the fields this write touched. */
  before?: Record<string, unknown> | null;
  /** Values after. For a create, this is the row. */
  after?: Record<string, unknown> | null;
  /** Free-form context — the sweep's run id, the source URL, the tool name. */
  note?: string | null;
}

export interface MutationAuditRow {
  action: string;
  actorUserId: string | null;
  targetType: string;
  targetId: string;
  payloadJson: string;
  createdAt: Date;
}

/**
 * Fields worth recording a change to.
 *
 * An allow-list for the same reason the citation table has one: an audit row
 * that fires on `updated_at` drowns the ones that matter. These are the fields
 * a reader of the public page would notice being wrong — which is the same list
 * the observed defects landed in.
 */
export const AUDITED_FIELDS: Record<AuditedEntityType, ReadonlySet<string>> = {
  venue: new Set([
    "name",
    "address",
    "city",
    "state",
    "zip",
    "latitude",
    "longitude",
    "website",
    "imageUrl",
    "status",
    "locationId",
  ]),
  event_day: new Set(["date", "openTime", "closeTime", "notes", "closed", "vendorOnly"]),
};

/** Values that differ, restricted to the audited fields. */
export function diffAuditedFields(
  entityType: AuditedEntityType,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): Record<string, { from: unknown; to: unknown }> {
  const allowed = AUDITED_FIELDS[entityType];
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})]);
  for (const k of keys) {
    if (!allowed.has(k)) continue;
    const from = before?.[k];
    const to = after?.[k];
    // `undefined` in `after` means "this write did not touch the field", which
    // is different from "this write set it to null". Only the second is a
    // change worth recording.
    if (after && !(k in after)) continue;
    if (Object.is(from, to)) continue;
    // A numeric 1 and a string "1" out of D1 are the same stored value; a diff
    // that reported them as a change would fill the log with noise from the
    // driver rather than from anybody's edit.
    if (from != null && to != null && String(from) === String(to)) continue;
    out[k] = { from: from ?? null, to: to ?? null };
  }
  return out;
}

/**
 * Build the audit row, or `null` when there is nothing to say.
 *
 * Returns null for an update that changed no audited field — a write that
 * touched only `updated_at` is not an event in the record, and logging it would
 * bury the ones that are. Creates and deletes always produce a row: their
 * existence is the fact.
 */
export function buildMutationAudit(input: MutationAuditInput, now: Date): MutationAuditRow | null {
  if (!input.entityId || !input.actor) return null;

  const changed =
    input.verb === "update"
      ? diffAuditedFields(input.entityType, input.before, input.after)
      : undefined;
  if (input.verb === "update" && changed && Object.keys(changed).length === 0) return null;

  return {
    action: `${input.entityType}.${input.verb}`,
    // `admin_actions.actor_user_id` is a user id column. A machine identity is
    // not one, so it goes in the payload rather than being forced into a field
    // that would then look like a person did it.
    actorUserId: input.actor.startsWith("mcp:") || input.actor.includes("_") ? null : input.actor,
    targetType: input.entityType,
    targetId: input.entityId,
    payloadJson: JSON.stringify({
      actor: input.actor,
      ...(changed ? { changed } : {}),
      ...(input.verb === "create" && input.after ? { created: input.after } : {}),
      ...(input.note ? { note: input.note } : {}),
    }),
    createdAt: now,
  };
}
