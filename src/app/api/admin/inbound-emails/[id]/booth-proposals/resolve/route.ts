export const dynamic = "force-dynamic";
/**
 * OPE-205 §2 (write half) — approve or reject a staged booth identification.
 *
 * OPE-204's vision pipeline STAGES each booth as an `admin_actions`
 * (`vendor.photo_proposed`) row; #743 surfaced them read-only in the review
 * queue. This is the one-action fix path: approve creates/links the vendor via
 * the SHARED write tail (`@takemetothefair/vendor-linking`, extracted so the app
 * and MCP share one copy — no duplicated vendor rules), optionally promotes the
 * booth photo to the vendor's hero, and marks the proposal resolved so it leaves
 * the queue. Reject just resolves it.
 *
 * Resolution is itself an `admin_actions` row (`vendor.photo_resolved`) keyed to
 * the proposal id — no migration, and the audit trail stays append-only.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, vendors } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createOrLinkVendor } from "@takemetothefair/vendor-linking";
import { recomputeVendorCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
import { runUploadPipeline } from "@/lib/upload-image-pipeline";
import { logError } from "@/lib/logger";

const BOOTH_PROPOSED_ACTION = "vendor.photo_proposed";
const BOOTH_RESOLVED_ACTION = "vendor.photo_resolved";

interface Body {
  proposal_id?: string;
  action?: "approve" | "reject";
  /** Overrides the model-read business name (the "couldn't identify" fix). */
  corrected_name?: string;
}

interface ProposalPayload {
  event_id?: string;
  photo_key?: string;
  business_name?: string | null;
  website?: string | null;
  products?: string[] | null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: emailId } = await params;
  const body = (await request.json().catch(() => ({}))) as Body;

  if (!body.proposal_id || (body.action !== "approve" && body.action !== "reject")) {
    return NextResponse.json(
      { error: "Provide proposal_id and action ('approve' | 'reject')." },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();
  const actorId = session.user.id ?? null;

  // Load the specific proposal, scoped to this email so an id from another
  // email can't be resolved here.
  const [proposal] = await db
    .select({ id: adminActions.id, payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.id, body.proposal_id),
        eq(adminActions.action, BOOTH_PROPOSED_ACTION),
        eq(adminActions.targetType, "inbound_email"),
        eq(adminActions.targetId, emailId)
      )
    )
    .limit(1);
  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found for this email." }, { status: 404 });
  }

  // Already resolved? Idempotent — report the prior resolution rather than
  // creating a duplicate vendor on a double-click.
  const [existing] = await db
    .select({ payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, BOOTH_RESOLVED_ACTION),
        eq(adminActions.targetId, body.proposal_id)
      )
    )
    .limit(1);
  if (existing) {
    return NextResponse.json(
      { error: "Proposal already resolved.", already_resolved: true },
      {
        status: 409,
      }
    );
  }

  let payload: ProposalPayload = {};
  try {
    payload = JSON.parse(proposal.payloadJson ?? "{}") as ProposalPayload;
  } catch {
    /* malformed payload → fields stay undefined, handled below */
  }

  // ── Reject ────────────────────────────────────────────────────────────────
  if (body.action === "reject") {
    await db.insert(adminActions).values({
      action: BOOTH_RESOLVED_ACTION,
      actorUserId: actorId,
      targetType: "admin_action",
      targetId: body.proposal_id,
      payloadJson: JSON.stringify({ resolution: "rejected", email_id: emailId }),
      createdAt: new Date(),
    });
    return NextResponse.json({ ok: true, resolution: "rejected" });
  }

  // ── Approve ─────────────────────────────────────────────────────────────
  const businessName = (body.corrected_name?.trim() || payload.business_name || "").trim();
  if (!businessName) {
    // The vision model couldn't identify it and no correction was supplied —
    // there's no vendor to create. The operator must type a name.
    return NextResponse.json(
      { error: "No business name — pass corrected_name to approve an unidentified photo." },
      { status: 400 }
    );
  }
  if (!payload.event_id) {
    return NextResponse.json({ error: "Proposal has no resolved event." }, { status: 422 });
  }

  // The shared write tail. Closures capture the concrete app `db` (it carries
  // `$client`, which the core's dep type intentionally strips).
  const result = await createOrLinkVendor(
    db,
    {
      eventId: payload.event_id,
      businessName,
      website: payload.website ?? null,
      products: payload.products ?? null,
      status: "CONFIRMED",
      participationType: "EXHIBITOR",
    },
    {
      actorUserId: actorId,
      recomputeVendorCompleteness: (_db, vendorId) => recomputeVendorCompleteness(db, vendorId),
      logEnrichment: (_db, entry) => logEnrichment(db, entry),
    }
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  // Hero-if-blank — promote the booth photo to the vendor's logo when it has
  // none. Best-effort: the vendor is already created/linked, so a photo hiccup
  // must not fail the approval. Reuses the upload pipeline (EXIF strip → WebP →
  // R2 → logo_url), never storing the raw inbound original on the public CDN.
  let heroSet = false;
  if (payload.photo_key) {
    try {
      const [v] = await db
        .select({ logoUrl: vendors.logoUrl })
        .from(vendors)
        .where(eq(vendors.id, result.vendorId))
        .limit(1);
      if (v && !v.logoUrl) {
        // VENDOR_ASSETS isn't on the generated CloudflareEnv type; the
        // upload-image-bytes route casts the same way.
        const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };
        const obj = await env.VENDOR_ASSETS?.get(payload.photo_key);
        if (obj) {
          const bytes = new Uint8Array(await obj.arrayBuffer());
          const declaredType = obj.httpMetadata?.contentType ?? "image/jpeg";
          const pipe = await runUploadPipeline({
            bytes,
            declaredType,
            fileName: `booth-${result.vendorId}`,
            targetType: "vendor",
            targetId: result.vendorId,
            imageRole: "logo",
            caption: null,
            actorId: actorId ?? "system",
            uploadSource: "booth-photo-approve",
            db,
            env: { VENDOR_ASSETS: env.VENDOR_ASSETS },
          });
          heroSet = pipe.ok;
        }
      }
    } catch (e) {
      await logError(db, {
        message: "booth approve: hero-if-blank failed (vendor already linked)",
        error: e,
        source: "api/admin/inbound-emails/booth-proposals/resolve",
        request,
      });
    }
  }

  // Mark resolved so the proposal leaves the review queue.
  await db.insert(adminActions).values({
    action: BOOTH_RESOLVED_ACTION,
    actorUserId: actorId,
    targetType: "admin_action",
    targetId: body.proposal_id,
    payloadJson: JSON.stringify({
      resolution: "approved",
      email_id: emailId,
      vendor_id: result.vendorId,
      business_name: businessName,
      was_created: result.wasCreated,
      hero_set: heroSet,
    }),
    createdAt: new Date(),
  });

  return NextResponse.json({
    ok: true,
    resolution: "approved",
    vendor_id: result.vendorId,
    vendor_slug: result.vendorSlug,
    was_created: result.wasCreated,
    was_linked: result.wasLinked,
    was_already_linked: result.wasAlreadyLinked,
    matched_existing: result.matchedExisting,
    hero_set: heroSet,
  });
}
