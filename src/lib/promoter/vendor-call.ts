/**
 * OPE-1513 — a claimed promoter edits the vendor call on its OWN event.
 *
 * Six items (OPE-1512 item 2): application deadline, booth fee (min/max +
 * notes), apply URL, capacity status, categories wanted, categories full.
 *
 * ── Where each item is written ────────────────────────────────────────────
 *
 * The public event page's vendor block still reads the LEGACY single-route
 * columns (`events.application_url` / `application_deadline`, see
 * event-detail-data.ts — the commercial lane is excluded from the
 * `event_applications` read on purpose), and the booth fee only exists on
 * `events`. So:
 *
 *   - fee min/max/notes            → events.vendor_fee_*           (only home)
 *   - apply URL, deadline          → BOTH events.application_* (what the page
 *                                    shows today) AND the commercial_vendor
 *                                    route row (the model, the digest feed)
 *   - capacity, categories         → the route row only
 *
 * Promoters already set the fee, URL and deadline on the create form
 * (POST /api/promoter/events), so editing them on their own event grants no
 * new authority.
 *
 * ── Ownership ─────────────────────────────────────────────────────────────
 *
 * The same rule as the rest of the portal: the session user's `promoters` row
 * (`promoters.user_id`) must be the event's `promoter_id`. Another promoter's
 * event and a merge tombstone both read as "not found" — no existence leak.
 *
 * Patch semantics throughout: an omitted key is never written; `null` clears.
 * The route-row rules are `buildApplicationPatch`, shared with the admin MCP
 * tool `upsert_event_application`, so the two writers cannot drift.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { adminActions, eventApplications, events, promoters } from "@/lib/db/schema";
import { toIsoDateOnlyInVenueZone } from "@takemetothefair/datetime";
import {
  buildApplicationPatch,
  dollarsToCents,
  normalizeEventDate,
  parseVendorCategories,
  type ApplicationPatchInput,
} from "@takemetothefair/utils";
import type { PromoterVendorCallInput } from "@/lib/validations";

type Db = DrizzleD1Database<typeof schema>;

const LANE = "commercial_vendor";

export interface VendorCallState {
  event: { id: string; name: string; slug: string; status: string };
  applicationDeadline: string | null;
  applicationUrl: string | null;
  vendorFeeMin: number | null;
  vendorFeeMax: number | null;
  vendorFeeNotes: string | null;
  capacityStatus: string;
  capacityAsOf: string | null;
  capacityNote: string | null;
  categoriesWanted: string[];
  categoriesFull: string[];
  categoriesAsOf: string | null;
}

const day = (d: Date | null | undefined) => (d ? toIsoDateOnlyInVenueZone(d) : null);
const dollars = (cents: number | null | undefined) => (cents == null ? null : cents / 100);

async function loadOwned(db: Db, userId: string, eventId: string) {
  const [promoter] = await db
    .select({ id: promoters.id })
    .from(promoters)
    .where(eq(promoters.userId, userId))
    .limit(1);
  if (!promoter) return null;
  const [event] = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      status: events.status,
      promoterId: events.promoterId,
      mergedInto: events.mergedInto,
      applicationUrl: events.applicationUrl,
      applicationDeadline: events.applicationDeadline,
      vendorFeeMinCents: events.vendorFeeMinCents,
      vendorFeeMaxCents: events.vendorFeeMaxCents,
      vendorFeeNotes: events.vendorFeeNotes,
    })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.promoterId, promoter.id)))
    .limit(1);
  if (!event || event.mergedInto) return null;
  const [app] = await db
    .select()
    .from(eventApplications)
    .where(
      and(
        eq(eventApplications.eventId, event.id),
        eq(eventApplications.lane, LANE),
        isNull(eventApplications.department)
      )
    )
    .limit(1);
  return { event, app: app ?? null };
}

function present(loaded: NonNullable<Awaited<ReturnType<typeof loadOwned>>>): VendorCallState {
  const { event, app } = loaded;
  return {
    event: { id: event.id, name: event.name, slug: event.slug, status: event.status },
    // The route row is the model; the legacy column is the fallback for the
    // events whose only application data predates it.
    applicationDeadline: day(app?.closesAt) ?? day(event.applicationDeadline),
    applicationUrl:
      event.applicationUrl ?? app?.url ?? (app?.contactEmail ? `mailto:${app.contactEmail}` : null),
    vendorFeeMin: dollars(event.vendorFeeMinCents),
    vendorFeeMax: dollars(event.vendorFeeMaxCents),
    vendorFeeNotes: event.vendorFeeNotes,
    capacityStatus: app?.capacityStatus ?? "UNKNOWN",
    capacityAsOf: day(app?.capacityAsOf),
    capacityNote: app?.capacityNote ?? null,
    categoriesWanted: parseVendorCategories(app?.categoriesWanted),
    categoriesFull: parseVendorCategories(app?.categoriesFull),
    categoriesAsOf: day(app?.categoriesAsOf),
  };
}

/** The current vendor call for the promoter's own event, or null (not theirs / not found). */
export async function loadPromoterVendorCall(
  db: Db,
  userId: string,
  eventId: string
): Promise<VendorCallState | null> {
  const loaded = await loadOwned(db, userId, eventId);
  return loaded ? present(loaded) : null;
}

export type ApplyResult =
  | { ok: true; state: VendorCallState; fieldsWritten: string[] }
  | { ok: false; status: 400 | 404; error: string };

/** Map the promoter's apply link onto the route row: a mailto: is an email route. */
function routeFromLink(
  link: string | null | undefined
): Pick<ApplicationPatchInput, "url" | "contact_email"> {
  if (link === undefined) return {};
  if (link === null) return { url: null };
  if (/^mailto:/i.test(link)) {
    const raw = link.slice(7).split("?")[0];
    let address = raw;
    try {
      address = decodeURIComponent(raw);
    } catch {
      // a malformed %-escape: keep the address as typed
    }
    return { url: null, contact_email: address || null };
  }
  return { url: link };
}

export async function applyPromoterVendorCall(
  db: Db,
  userId: string,
  eventId: string,
  input: PromoterVendorCallInput,
  now: Date = new Date()
): Promise<ApplyResult> {
  const loaded = await loadOwned(db, userId, eventId);
  if (!loaded) return { ok: false, status: 404, error: "Event not found" };
  const { event, app } = loaded;

  // events.* — fee, plus the legacy URL/deadline the public page still reads.
  const eventPatch: Partial<typeof events.$inferInsert> = {};
  if (input.vendorFeeMin !== undefined)
    eventPatch.vendorFeeMinCents = dollarsToCents(input.vendorFeeMin);
  if (input.vendorFeeMax !== undefined)
    eventPatch.vendorFeeMaxCents = dollarsToCents(input.vendorFeeMax);
  if (input.vendorFeeNotes !== undefined) eventPatch.vendorFeeNotes = input.vendorFeeNotes || null;
  if (input.applicationUrl !== undefined) eventPatch.applicationUrl = input.applicationUrl || null;
  if (input.applicationDeadline !== undefined) {
    eventPatch.applicationDeadline = input.applicationDeadline
      ? normalizeEventDate(input.applicationDeadline)
      : null;
  }
  // A fee range checked against the STORED other end, not only the request.
  const min =
    eventPatch.vendorFeeMinCents !== undefined
      ? eventPatch.vendorFeeMinCents
      : event.vendorFeeMinCents;
  const max =
    eventPatch.vendorFeeMaxCents !== undefined
      ? eventPatch.vendorFeeMaxCents
      : event.vendorFeeMaxCents;
  if (min != null && max != null && max < min) {
    return { ok: false, status: 400, error: "Maximum booth fee must be at least the minimum" };
  }

  // The commercial_vendor route row — the shared rules.
  const { patch: appPatch, problems } = buildApplicationPatch(
    {
      ...routeFromLink(input.applicationUrl),
      ...(input.applicationDeadline !== undefined ? { closes_on: input.applicationDeadline } : {}),
      ...(input.capacityStatus !== undefined ? { capacity_status: input.capacityStatus } : {}),
      ...(input.capacityNote !== undefined ? { capacity_note: input.capacityNote || null } : {}),
      ...(input.categoriesWanted !== undefined
        ? { categories_wanted: input.categoriesWanted }
        : {}),
      ...(input.categoriesFull !== undefined ? { categories_full: input.categoriesFull } : {}),
    },
    app,
    now
  );
  if (problems.length) return { ok: false, status: 400, error: problems.join("; ") };

  const fieldsWritten = [
    ...Object.keys(eventPatch).map((k) => `events.${k}`),
    ...Object.keys(appPatch).map((k) => `event_applications.${k}`),
  ];
  if (fieldsWritten.length === 0) return { ok: false, status: 400, error: "Nothing to save" };

  const appId = app?.id ?? crypto.randomUUID();
  const stmts: unknown[] = [];
  if (Object.keys(eventPatch).length) {
    stmts.push(
      db
        .update(events)
        .set({ ...eventPatch, updatedAt: now })
        .where(eq(events.id, event.id))
    );
  }
  if (Object.keys(appPatch).length) {
    stmts.push(
      app
        ? db
            .update(eventApplications)
            .set({ ...appPatch, updatedAt: now })
            .where(eq(eventApplications.id, appId))
        : db.insert(eventApplications).values({
            id: appId,
            eventId: event.id,
            lane: LANE,
            department: null,
            ...appPatch,
            createdAt: now,
            updatedAt: now,
          })
    );
  }
  stmts.push(
    db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action: "event_application.promoter_upsert",
      actorUserId: userId,
      targetType: "event",
      targetId: event.id,
      payloadJson: JSON.stringify({
        application_id: appId,
        created_route_row: !app && Object.keys(appPatch).length > 0,
        fields: fieldsWritten,
        before: present(loaded),
      }),
      createdAt: now,
    })
  );
  // One atomic batch: the event columns, the route row and the audit row.
  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);

  const after = await loadOwned(db, userId, eventId);
  return { ok: true, state: present(after!), fieldsWritten };
}
