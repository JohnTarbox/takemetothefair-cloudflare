export const dynamic = "force-dynamic";
/**
 * OPE-113 PR#2 — admin event-edit "Performers / Entertainment" API.
 *
 * GET    list appearances for an event (joined with performer name/slug)
 * POST   add an act: fuzzy-dedup by name (surface matches for confirm) → create
 *        performer if new → insert the appearance (one row = one set). Pass
 *        performer_id to link a known act, or confirm_create_new to force-create.
 * PATCH  update one appearance (status / billing / day / time / stage)
 * DELETE remove one appearance
 *
 * Admin-only (withAuth ADMIN). Direct D1 — the mcp-server tools (OPE-113 PR#1)
 * are the agent-side equivalent; this is the operator UI's backend. Every write
 * stores source_url (provenance, §4.2).
 */
import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { performers, eventPerformers, eventDays } from "@/lib/db/schema";
import { createSlug, appendSlugSegment, unsafeSlug } from "@takemetothefair/utils";
import { rankPerformerMatches } from "@/lib/performers/match";
import { logError } from "@/lib/logger";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import type { Database } from "@/lib/db";

/**
 * OPE-115 — nudge IndexNow for a performer's public page once it has a CONFIRMED
 * appearance (the moment the page is indexable + sitemap-eligible). pingIndexNow
 * honours the kill-switch + same-URL dedup suppressor, so this can't burst-ping.
 * Fail-open: an IndexNow hiccup must never fail the appearance write.
 */
async function nudgePerformerIndexNow(db: Database, performerId: string, reason: string) {
  try {
    const [p] = await db
      .select({ slug: performers.slug })
      .from(performers)
      .where(eq(performers.id, performerId))
      .limit(1);
    if (p) {
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("performers", p.slug), env, reason);
    }
  } catch {
    /* observability only — never break the write path on a ping */
  }
}

const BILLING = new Set(["HEADLINER", "FEATURED", "SUPPORTING"]);
const STATUS = new Set(["CONFIRMED", "PENDING", "CANCELLED"]);
const billingRank: Record<string, number> = { HEADLINER: 0, FEATURED: 1, SUPPORTING: 2 };

const toDate = (sec: unknown): Date | null =>
  typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000) : null;
const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

function appearanceOut(a: typeof eventPerformers.$inferSelect, name?: string, slug?: string) {
  return {
    id: a.id,
    event_id: a.eventId,
    performer_id: a.performerId,
    performer_name: name,
    performer_slug: slug,
    event_day_id: a.eventDayId,
    performance_start: toSec(a.performanceStart),
    performance_end: toSec(a.performanceEnd),
    stage: a.stage,
    billing: a.billing,
    status: a.status,
    source_url: a.sourceUrl,
  };
}

// GET — list appearances for the event.
export const GET = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ db, params }) => {
  const rows = await db
    .select({ a: eventPerformers, name: performers.name, slug: performers.slug })
    .from(eventPerformers)
    .innerJoin(performers, eq(eventPerformers.performerId, performers.id))
    .where(eq(eventPerformers.eventId, params.id))
    .orderBy(desc(eventPerformers.performanceStart));
  const out = rows
    .map((r) => appearanceOut(r.a, r.name, r.slug))
    .sort(
      (x, y) =>
        (billingRank[x.billing ?? ""] ?? 3) - (billingRank[y.billing ?? ""] ?? 3) ||
        (x.performance_start ?? 0) - (y.performance_start ?? 0)
    );
  return NextResponse.json({ appearances: out });
});

// POST — add an act (create-or-link + appearance).
export const POST = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ request, db, params }) => {
  const eventId = params.id;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
  if (!sourceUrl) return NextResponse.json({ error: "source_url is required" }, { status: 400 });

  const eventDayId = typeof body.event_day_id === "string" ? body.event_day_id : null;
  if (eventDayId) {
    const day = await db
      .select({ eventId: eventDays.eventId })
      .from(eventDays)
      .where(eq(eventDays.id, eventDayId))
      .limit(1);
    if (day.length === 0 || day[0].eventId !== eventId)
      return NextResponse.json({ error: "event_day_id not on this event" }, { status: 400 });
  }

  const billing =
    typeof body.billing === "string" && BILLING.has(body.billing) ? body.billing : null;
  const status =
    typeof body.status === "string" && STATUS.has(body.status)
      ? (body.status as string)
      : "PENDING";
  const perfStart = toDate(body.performance_start);
  const perfEnd = toDate(body.performance_end);
  const stage = typeof body.stage === "string" ? body.stage : null;

  try {
    let performerId = typeof body.performer_id === "string" ? body.performer_id : "";

    if (!performerId) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name)
        return NextResponse.json({ error: "name or performer_id required" }, { status: 400 });

      if (!body.confirm_create_new) {
        const candidates = await db
          .select({ id: performers.id, name: performers.name, slug: performers.slug })
          .from(performers)
          .where(isNull(performers.deletedAt))
          .limit(500);
        const matches = rankPerformerMatches(name, candidates);
        if (matches.length > 0) {
          return NextResponse.json({ needs_confirmation: true, matches }, { status: 409 });
        }
      }

      // Create the performer (unique slug).
      const base = createSlug(name);
      const clash = await db
        .select({ id: performers.id })
        .from(performers)
        .where(eq(performers.slug, base))
        .limit(1);
      const slug =
        clash.length === 0 ? base : appendSlugSegment(base, crypto.randomUUID().slice(0, 8));
      const now = new Date();
      const created = await db
        .insert(performers)
        .values({
          name,
          slug: unsafeSlug(slug),
          performerType:
            body.performer_type === "PERSON" || body.performer_type === "GROUP"
              ? body.performer_type
              : null,
          actCategory: typeof body.act_category === "string" ? (body.act_category as string) : null,
          website: typeof body.website === "string" ? body.website : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: performers.id });
      performerId = created[0].id;
    }

    // Insert the appearance, deduping on identity (incl. NULL-start, which the
    // UNIQUE index can't enforce — OPE-112 caveat).
    const existing = await db
      .select()
      .from(eventPerformers)
      .where(
        and(
          eq(eventPerformers.eventId, eventId),
          eq(eventPerformers.performerId, performerId),
          eventDayId == null
            ? isNull(eventPerformers.eventDayId)
            : eq(eventPerformers.eventDayId, eventDayId),
          perfStart == null
            ? isNull(eventPerformers.performanceStart)
            : eq(eventPerformers.performanceStart, perfStart)
        )
      )
      .limit(1);
    if (existing.length > 0)
      return NextResponse.json({ created: false, appearance: appearanceOut(existing[0]) });

    const now = new Date();
    const rows = await db
      .insert(eventPerformers)
      .values({
        eventId,
        performerId,
        eventDayId,
        performanceStart: perfStart,
        performanceEnd: perfEnd,
        stage,
        billing: billing as never,
        status: status as never,
        sourceUrl,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    // OPE-115 — a CONFIRMED appearance makes the performer page indexable.
    if (status === "CONFIRMED")
      await nudgePerformerIndexNow(db, performerId, "performer-appearance-confirmed");
    return NextResponse.json({ created: true, appearance: appearanceOut(rows[0]) });
  } catch (error) {
    await logError(db, {
      source: "api/admin/event-performers",
      message: "add performer failed",
      error,
    });
    return NextResponse.json({ error: "add_failed" }, { status: 500 });
  }
});

// PATCH — update one appearance.
export const PATCH = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ request, db }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const apprId = typeof body.event_performer_id === "string" ? body.event_performer_id : "";
  if (!apprId) return NextResponse.json({ error: "event_performer_id required" }, { status: 400 });

  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.status === "string") {
    if (!STATUS.has(body.status))
      return NextResponse.json({ error: "bad status" }, { status: 400 });
    values.status = body.status;
  }
  if (typeof body.billing === "string") {
    if (!BILLING.has(body.billing))
      return NextResponse.json({ error: "bad billing" }, { status: 400 });
    values.billing = body.billing;
  }
  if (body.event_day_id !== undefined) values.eventDayId = body.event_day_id ?? null;
  if (body.performance_start !== undefined)
    values.performanceStart = toDate(body.performance_start);
  if (body.performance_end !== undefined) values.performanceEnd = toDate(body.performance_end);
  if (body.stage !== undefined) values.stage = typeof body.stage === "string" ? body.stage : null;

  const rows = await db
    .update(eventPerformers)
    .set(values)
    .where(eq(eventPerformers.id, apprId))
    .returning();
  if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // OPE-115 — a set flipped to CONFIRMED makes the performer page indexable.
  if (values.status === "CONFIRMED")
    await nudgePerformerIndexNow(db, rows[0].performerId, "performer-status-confirmed");
  return NextResponse.json({ appearance: appearanceOut(rows[0]) });
});

// DELETE — remove one appearance (?event_performer_id=...).
export const DELETE = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ request, db }) => {
  const apprId = new URL(request.url).searchParams.get("event_performer_id") ?? "";
  if (!apprId) return NextResponse.json({ error: "event_performer_id required" }, { status: 400 });
  const rows = await db.delete(eventPerformers).where(eq(eventPerformers.id, apprId)).returning();
  if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ removed: true });
});
