export const dynamic = "force-dynamic";
/**
 * §10.2 admin CRUD for the competitor_domains table.
 *
 * GET   → list all domains (id, domain, notes, createdAt, createdBy)
 * POST  → add a new domain. Body: { domain: string, notes?: string }
 * DELETE → remove by id. Body: { id: string }
 *
 * Auth: admin session OR X-Internal-Key.
 */
import { NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { z } from "zod";
import { isAuthorized } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { competitorDomains } from "@/lib/db/schema";

const addSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Must be a bare hostname (e.g. example.com, not a URL)")
    .transform((s) => s.trim().toLowerCase()),
  notes: z.string().max(500).optional(),
});

const deleteSchema = z.object({ id: z.string().min(1) });

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getCloudflareDb();
  const rows = await db.select().from(competitorDomains).orderBy(asc(competitorDomains.domain));
  return NextResponse.json({ rows });
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const session = await auth().catch(() => null);
  const db = getCloudflareDb();
  try {
    const id = crypto.randomUUID();
    await db.insert(competitorDomains).values({
      id,
      domain: parsed.data.domain,
      notes: parsed.data.notes ?? null,
      createdAt: new Date(),
      createdBy: session?.user?.id ?? null,
    });
    return NextResponse.json({ ok: true, id, domain: parsed.data.domain });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE") || msg.includes("constraint")) {
      return NextResponse.json({ error: "Domain already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "internal_error", message: msg }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const db = getCloudflareDb();
  const deleted = await db
    .delete(competitorDomains)
    .where(eq(competitorDomains.id, parsed.data.id))
    .returning({ id: competitorDomains.id, domain: competitorDomains.domain });
  if (deleted.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: deleted[0] });
}
