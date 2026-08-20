export const dynamic = "force-dynamic";
/**
 * OPE-239 — vendor self-attested event participation.
 *
 * GET  ?q=<term>  → event search for the picker (plus the vendor's current set)
 * PUT  { event_ids: string[] } → replace the vendor's asserted set
 *
 * ## Auth
 *
 * Session + ownership + email verification, matching `/api/vendor/profile`'s
 * PATCH. Writes are gated on verification because an unverified signup can mint
 * a vendor row at registration; without the gate, anyone could attach their
 * name to a real fair's page-adjacent data before proving they own an inbox.
 *
 * ## What this endpoint can NEVER do
 *
 * Write `event_vendors`. Self-attestation and organizer confirmation are
 * different facts and live in different tables — see the module docs on
 * `@/lib/vendors/self-reported-events`.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { requireVerifiedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { adminActions, events, vendors, venues } from "@/lib/db/schema";
import { containsCI } from "@/lib/db/contains-ci";
import {
  listSelfReportedEvents,
  setSelfReportedEvents,
  MAX_SELF_REPORTED_PER_VENDOR,
} from "@/lib/vendors/self-reported-events";
import { logError } from "@/lib/logger";

/** Picker result cap — enough to choose from, small enough to stay snappy. */
const SEARCH_LIMIT = 25;

async function vendorForSession(db: ReturnType<typeof getCloudflareDb>, userId: string) {
  const [vendor] = await db
    .select({ id: vendors.id, businessName: vendors.businessName })
    .from(vendors)
    .where(eq(vendors.userId, userId))
    .limit(1);
  return vendor ?? null;
}

export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const vendor = await vendorForSession(db, session.user.id);
    if (!vendor) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
    const selected = await listSelfReportedEvents(db, vendor.id);

    // No query → just the current set. The picker only searches once the
    // vendor types, so an empty box doesn't dump the whole events table.
    if (q.length < 2) {
      return NextResponse.json({ selected, results: [] });
    }

    // OPE-366 — instr(), not LIKE. This built a LIKE PATTERN from the user's
    // query with NO length cap at all, and D1 caps a pattern at 50 characters:
    // 280 logged `LIKE or GLOB pattern too complex` failures, the most of any
    // source. See src/lib/db/contains-ci.ts. Stripping `%`/`_` is also no
    // longer needed — they are literal to instr — so a business with `%` in
    // its name is now findable rather than silently mangled.
    const term = q;
    const results = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        city: venues.city,
        state: venues.state,
      })
      .from(events)
      .leftJoin(venues, eq(venues.id, events.venueId))
      // APPROVED only: a vendor should not be able to assert participation in
      // something we haven't published, and it keeps rejected/duplicate
      // tombstones out of the picker.
      .where(
        and(
          eq(events.status, "APPROVED"),
          or(containsCI(events.name, term), containsCI(venues.city, term))
        )
      )
      // Past events are the POINT here — most attestations are historical —
      // so no date floor; newest first is the useful ordering.
      .orderBy(desc(events.startDate))
      .limit(SEARCH_LIMIT);

    return NextResponse.json({ selected, results });
  } catch (error) {
    await logError(db, {
      message: "Failed to load self-reported events",
      error,
      source: "api/vendor/self-reported-events:GET",
      request,
    });
    return NextResponse.json({ error: "Failed to load events" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const db = getCloudflareDb();
  const gate = await requireVerifiedSession();
  if (!gate.ok) return gate.response;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const vendor = await vendorForSession(db, session.user.id);
    if (!vendor) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as { event_ids?: unknown } | null;
    const raw = body?.event_ids;
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
      return NextResponse.json(
        { error: "invalid_body", message: "`event_ids` must be an array of event id strings." },
        { status: 400 }
      );
    }
    if (raw.length > MAX_SELF_REPORTED_PER_VENDOR) {
      return NextResponse.json(
        {
          error: "too_many",
          message: `At most ${MAX_SELF_REPORTED_PER_VENDOR} fairs can be listed.`,
        },
        { status: 400 }
      );
    }

    const delta = await setSelfReportedEvents(db, {
      vendorId: vendor.id,
      eventIds: raw as string[],
      sourceContext: "profile",
    });

    // Audit only when something actually changed — a no-op save (the common
    // case when a vendor edits an unrelated profile field) shouldn't write a row.
    if (delta.added.length > 0 || delta.removed.length > 0) {
      await db.insert(adminActions).values({
        action: "vendor.self_reported_events",
        actorUserId: session.user.id,
        targetType: "VENDOR",
        targetId: vendor.id,
        payloadJson: JSON.stringify({
          added: delta.added,
          removed: delta.removed,
          kept: delta.kept,
        }),
        createdAt: new Date(),
      });
    }

    const selected = await listSelfReportedEvents(db, vendor.id);
    return NextResponse.json({ success: true, ...delta, selected });
  } catch (error) {
    await logError(db, {
      message: "Failed to save self-reported events",
      error,
      source: "api/vendor/self-reported-events:PUT",
      request,
    });
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
