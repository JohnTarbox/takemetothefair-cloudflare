import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { urlDomainClassifications } from "@/lib/db/schema";
import { extractDomain } from "@/lib/url-classification";
import { logError } from "@/lib/logger";

export const runtime = "edge";

// Domain types kept loose-stringly here — matches the migration's free-form
// `domain_type` column. The frontend constrains the choice via radio buttons.
const DOMAIN_TYPES = ["aggregator", "promoter", "ticketing", "social", "other"] as const;

const bodySchema = z.object({
  // Accept any free-form string; we'll normalize via extractDomain() below so
  // the admin can paste a full URL or a bare hostname.
  domain: z.string().min(1).max(253),
  domain_type: z.enum(DOMAIN_TYPES),
  use_as_ticket_url: z.boolean(),
  use_as_application_url: z.boolean(),
  use_as_source: z.boolean(),
  notes: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  try {
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const normalized = extractDomain(parsed.data.domain);
    if (!normalized) {
      return NextResponse.json(
        { error: `Could not parse domain: ${parsed.data.domain}` },
        { status: 400 }
      );
    }

    const now = Math.floor(Date.now() / 1000);

    // Upsert: an admin clicking "classify" on a domain that's already in the
    // table should overwrite, not 409. Two admins racing on the same domain
    // both succeed — last-write-wins is fine here.
    await db
      .insert(urlDomainClassifications)
      .values({
        domain: normalized,
        domainType: parsed.data.domain_type,
        useAsTicketUrl: parsed.data.use_as_ticket_url,
        useAsApplicationUrl: parsed.data.use_as_application_url,
        useAsSource: parsed.data.use_as_source,
        notes: parsed.data.notes ?? null,
        createdAt: now,
        updatedAt: now,
        createdBy: session.user.id,
      })
      .onConflictDoUpdate({
        target: urlDomainClassifications.domain,
        set: {
          domainType: parsed.data.domain_type,
          useAsTicketUrl: parsed.data.use_as_ticket_url,
          useAsApplicationUrl: parsed.data.use_as_application_url,
          useAsSource: parsed.data.use_as_source,
          notes: parsed.data.notes ?? null,
          updatedAt: now,
        },
      });

    return NextResponse.json({ ok: true, domain: normalized });
  } catch (error) {
    await logError(db, {
      message: "Failed to upsert url classification",
      error,
      source: "api/admin/url-classifications",
      request,
    });
    return NextResponse.json({ error: "Failed to save classification" }, { status: 500 });
  }
}

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  try {
    const rows = await db
      .select()
      .from(urlDomainClassifications)
      .orderBy(
        sql`${urlDomainClassifications.domainType}`,
        sql`${urlDomainClassifications.domain}`
      );
    return NextResponse.json({ classifications: rows });
  } catch (error) {
    await logError(db, {
      message: "Failed to list url classifications",
      error,
      source: "api/admin/url-classifications",
    });
    return NextResponse.json({ error: "Failed to list classifications" }, { status: 500 });
  }
}
