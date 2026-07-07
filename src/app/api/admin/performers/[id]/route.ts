export const dynamic = "force-dynamic";
/**
 * OPE-113 PR#2 — admin performer detail / edit / verify / alias / merge.
 * GET    → performer + its appearances (joined with event name)
 * PATCH  { ...fields, verified? } → update
 * POST   { action: "alias", canonical_performer_id } | { action: "merge", duplicate_performer_id }
 * Admin-only.
 */
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { performers, eventPerformers, events } from "@/lib/db/schema";
import { aliasPerformer, mergePerformer } from "@/lib/performers/manage";

const ACT_CATEGORY = new Set([
  "MUSIC",
  "ANIMAL_SHOW",
  "MAGIC",
  "COMEDY",
  "CIRCUS",
  "DANCE",
  "THEATER",
  "EDUCATIONAL",
  "CHILDRENS",
  "DEMONSTRATION",
  "OTHER",
]);
const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

export const GET = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ db, params }) => {
  const [p] = await db.select().from(performers).where(eq(performers.id, params.id)).limit(1);
  if (!p) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const appearances = await db
    .select({ a: eventPerformers, eventName: events.name, eventSlug: events.slug })
    .from(eventPerformers)
    .innerJoin(events, eq(eventPerformers.eventId, events.id))
    .where(eq(eventPerformers.performerId, params.id))
    .orderBy(desc(eventPerformers.performanceStart));
  return NextResponse.json({
    performer: p,
    appearances: appearances.map((r) => ({
      id: r.a.id,
      event_id: r.a.eventId,
      event_name: r.eventName,
      event_slug: r.eventSlug,
      billing: r.a.billing,
      status: r.a.status,
      performance_start: toSec(r.a.performanceStart),
    })),
  });
});

export const PATCH = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, params }) => {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.name === "string") values.name = body.name;
    if (typeof body.description === "string") values.description = body.description;
    if (typeof body.website === "string") values.website = body.website;
    if (typeof body.social_links === "string") values.socialLinks = body.social_links;
    if (typeof body.image_url === "string") values.imageUrl = body.image_url;
    if (typeof body.home_base_city === "string") values.homeBaseCity = body.home_base_city;
    if (typeof body.home_base_state === "string") values.homeBaseState = body.home_base_state;
    if (body.performer_type === "PERSON" || body.performer_type === "GROUP")
      values.performerType = body.performer_type;
    if (typeof body.act_category === "string" && ACT_CATEGORY.has(body.act_category))
      values.actCategory = body.act_category;
    if (typeof body.verified === "boolean") {
      values.verified = body.verified;
    }
    const rows = await db
      .update(performers)
      .set(values)
      .where(eq(performers.id, params.id))
      .returning();
    if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ performer: rows[0] });
  }
);

export const POST = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, params, session }) => {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const changedBy = session?.user?.id ?? null;
    if (body.action === "alias") {
      const canonicalId =
        typeof body.canonical_performer_id === "string" ? body.canonical_performer_id : "";
      if (!canonicalId)
        return NextResponse.json({ error: "canonical_performer_id required" }, { status: 400 });
      const r = await aliasPerformer(db, params.id, canonicalId, changedBy);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true, alias_of: canonicalId });
    }
    if (body.action === "merge") {
      const dupId =
        typeof body.duplicate_performer_id === "string" ? body.duplicate_performer_id : "";
      if (!dupId)
        return NextResponse.json({ error: "duplicate_performer_id required" }, { status: 400 });
      // params.id is the KEEPER; the duplicate merges into it.
      const r = await mergePerformer(db, params.id, dupId, changedBy);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true, moved: r.moved, dropped: r.dropped });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
);
