/**
 * OPE-1410 — which scraper-synced fields has an operator edited since the
 * scraper last wrote them?
 *
 * `rescrape_events` (src/app/api/admin/import/rescrape-events/route.ts) runs
 * whether or not `sync_enabled` is on — gating it on that flag would break it
 * for most events — so OPE-1393's "an operator edit turns sync off" guard does
 * not protect it. Event 05d96d95 had its description edited through MCP on
 * 2026-06-13 and a rescrape overwrote it (and the operator-uploaded image) on
 * 06-16.
 *
 * The rule, per field F the rescrape would write:
 *   F is LOCKED when the newest operator edit of F is at or after the newest
 *   scraper write of F (or the scraper has never logged a write of F).
 *
 * Operator edits come from two audit trails, because neither covers every
 * operator write path on its own:
 *   - `admin_actions` rows with action `event.update` — written by the admin
 *     edit form (camelCase field names, `source: "admin_ui"`) and MCP
 *     `update_event` (snake_case param names, `source: "mcp"`);
 *   - `enrichment_log` rows with source `manual_admin` — the same MCP
 *     `update_event`, plus `upload_event_image`, which writes no admin_actions
 *     row.
 * Scraper writes are `enrichment_log` rows with source `scraper`, status
 * `success` — the rescrape logs its `fieldsUpdated` there.
 *
 * Because a locked field is skipped (so the scraper never logs a newer write
 * of it), a field stays locked once an operator touches it. That is the point:
 * the operator's value wins until an operator says otherwise.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  SCRAPER_SYNCED_EVENT_FIELDS,
  type ScraperSyncedEventField,
  chunkIds,
} from "@takemetothefair/utils";
import { adminActions, enrichmentLog } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

const SYNCED = new Set<string>(SCRAPER_SYNCED_EVENT_FIELDS);

/**
 * Map an audit-row field name to the camelCase synced-field key, or null.
 * Audit rows carry both spellings: the admin form logs Drizzle keys
 * (`imageUrl`), MCP logs its snake_case params (`image_url`).
 */
export function toSyncedField(name: unknown): ScraperSyncedEventField | null {
  if (typeof name !== "string") return null;
  const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return SYNCED.has(camel) ? (camel as ScraperSyncedEventField) : null;
}

export interface FieldTouch {
  eventId: string;
  fields: readonly unknown[];
  at: Date;
}

/** Parse a JSON field list (`["description"]` or `{"fields":[…]}`); [] on junk. */
export function parseFieldList(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray((v as { fields?: unknown }).fields)) {
      return (v as { fields: unknown[] }).fields;
    }
  } catch {
    /* malformed audit payload — contributes nothing */
  }
  return [];
}

/**
 * Pure core: per event, the synced fields whose newest operator edit is at or
 * after the newest scraper write.
 */
export function computeOperatorLockedFields(
  operatorEdits: readonly FieldTouch[],
  scraperWrites: readonly FieldTouch[]
): Map<string, Set<ScraperSyncedEventField>> {
  const newest = (touches: readonly FieldTouch[]) => {
    const m = new Map<string, number>(); // `${eventId}\0${field}` → ms
    for (const t of touches) {
      const ms = t.at.getTime();
      if (Number.isNaN(ms)) continue;
      for (const raw of t.fields) {
        const f = toSyncedField(raw);
        if (!f) continue;
        const k = `${t.eventId}\0${f}`;
        if ((m.get(k) ?? -Infinity) < ms) m.set(k, ms);
      }
    }
    return m;
  };
  const lastEdit = newest(operatorEdits);
  const lastScrape = newest(scraperWrites);

  const locked = new Map<string, Set<ScraperSyncedEventField>>();
  for (const [k, editMs] of lastEdit) {
    const scrapeMs = lastScrape.get(k);
    if (scrapeMs !== undefined && scrapeMs > editMs) continue;
    const [eventId, field] = k.split("\0") as [string, ScraperSyncedEventField];
    let s = locked.get(eventId);
    if (!s) locked.set(eventId, (s = new Set()));
    s.add(field);
  }
  return locked;
}

/** Load both audit trails for `eventIds` and compute the locked fields. */
export async function loadOperatorLockedFields(
  db: Db,
  eventIds: readonly string[]
): Promise<Map<string, Set<ScraperSyncedEventField>>> {
  if (eventIds.length === 0) return new Map();
  const operatorEdits: FieldTouch[] = [];
  const scraperWrites: FieldTouch[] = [];

  for (const ids of chunkIds(eventIds)) {
    const actions = await db
      .select({
        targetId: adminActions.targetId,
        payloadJson: adminActions.payloadJson,
        createdAt: adminActions.createdAt,
      })
      .from(adminActions)
      .where(
        and(
          eq(adminActions.action, "event.update"),
          eq(adminActions.targetType, "event"),
          inArray(adminActions.targetId, ids)
        )
      );
    for (const a of actions) {
      operatorEdits.push({
        eventId: a.targetId,
        fields: parseFieldList(a.payloadJson),
        at: a.createdAt,
      });
    }

    const logs = await db
      .select({
        targetId: enrichmentLog.targetId,
        source: enrichmentLog.source,
        status: enrichmentLog.status,
        fieldsChanged: enrichmentLog.fieldsChanged,
        attemptedAt: enrichmentLog.attemptedAt,
      })
      .from(enrichmentLog)
      .where(
        and(
          eq(enrichmentLog.targetType, "event"),
          inArray(enrichmentLog.targetId, ids),
          inArray(enrichmentLog.source, ["manual_admin", "scraper"]),
          eq(enrichmentLog.status, "success")
        )
      );
    for (const l of logs) {
      const touch = {
        eventId: l.targetId,
        fields: parseFieldList(l.fieldsChanged),
        at: l.attemptedAt,
      };
      (l.source === "scraper" ? scraperWrites : operatorEdits).push(touch);
    }
  }

  return computeOperatorLockedFields(operatorEdits, scraperWrites);
}
