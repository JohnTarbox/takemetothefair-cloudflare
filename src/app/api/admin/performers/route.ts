export const dynamic = "force-dynamic";
/**
 * OPE-113 PR#2 — admin performers list/search + create.
 * GET  ?q=<name>&limit=  → search live performers by name substring
 * POST { name, performer_type?, act_category?, website?, ... } → create
 * Admin-only.
 */
import { NextResponse } from "next/server";
import { and, desc, isNull, like } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { performers } from "@/lib/db/schema";
import { createSlug, appendSlugSegment, unsafeSlug } from "@takemetothefair/utils";
import { eq } from "drizzle-orm";

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

function esc(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 25) || 25, 100);
  const conds = [isNull(performers.deletedAt)];
  if (q) conds.push(like(performers.name, `%${esc(q)}%`));
  const rows = await db
    .select({
      id: performers.id,
      name: performers.name,
      slug: performers.slug,
      verified: performers.verified,
    })
    .from(performers)
    .where(and(...conds))
    .orderBy(desc(performers.createdAt))
    .limit(limit);
  return NextResponse.json({ performers: rows });
});

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const actCategory =
    typeof body.act_category === "string" && ACT_CATEGORY.has(body.act_category)
      ? (body.act_category as string)
      : null;
  const base = createSlug(name);
  const clash = await db
    .select({ id: performers.id })
    .from(performers)
    .where(eq(performers.slug, base))
    .limit(1);
  const slug = clash.length === 0 ? base : appendSlugSegment(base, crypto.randomUUID().slice(0, 8));
  const now = new Date();
  const rows = await db
    .insert(performers)
    .values({
      name,
      slug: unsafeSlug(slug),
      performerType:
        body.performer_type === "PERSON" || body.performer_type === "GROUP"
          ? body.performer_type
          : null,
      actCategory,
      description: typeof body.description === "string" ? body.description : null,
      website: typeof body.website === "string" ? body.website : null,
      homeBaseCity: typeof body.home_base_city === "string" ? body.home_base_city : null,
      homeBaseState: typeof body.home_base_state === "string" ? body.home_base_state : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: performers.id, slug: performers.slug });
  return NextResponse.json({ performer: rows[0] });
});
