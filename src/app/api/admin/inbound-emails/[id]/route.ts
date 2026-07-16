export const dynamic = "force-dynamic";
/**
 * OPE-156 — GET /api/admin/inbound-emails/[id]: full detail of one received
 * email, including the full parsed body_text / body_html (OPE-156) captured at
 * ingest. Split from the list endpoint so the list stays lean (bodies fetched
 * on demand when a row is expanded). Admin-gated (PII: full message body at
 * rest). Rows predating OPE-156 have null body_text/body_html and the caller
 * falls back to body_text_excerpt with an "excerpt only" indicator.
 *
 * OPE-205 §2 — also returns the booth identifications OPE-204's vision pipeline
 * STAGED for this email (`admin_actions` rows, action `vendor.photo_proposed`).
 * They were written to be reviewed and, until now, nothing displayed them: an
 * identification John can't see is one he can't correct, which is the whole
 * point of staging instead of auto-writing.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails, adminActions, events } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";

/** Must match mcp-server/src/photo/booth-pipeline.ts:BOOTH_PROPOSED_ACTION. */
const BOOTH_PROPOSED_ACTION = "vendor.photo_proposed";

/**
 * `website` is whatever the VISION MODEL read off a booth sign — untrusted text,
 * not a validated URL. Rendered straight into an href it's a stored-XSS vector:
 * a sign (or a sticker planted to be photographed) reading `javascript:…` would
 * become a clickable link that executes in an ADMIN session. Scheme-check it
 * here, at the boundary where model output enters the response, so no consumer
 * has to remember to.
 */
function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : null;
  } catch {
    // Not a parseable absolute URL — the model guessed at a bare domain or worse.
    return null;
  }
}

/** Payload shape written by the booth pipeline. All fields are best-effort. */
interface BoothProposalPayload {
  event_id?: string;
  photo_key?: string;
  photo_name?: string;
  business_name?: string | null;
  website?: string | null;
  products?: string[] | null;
  confidence?: number | null;
  rationale?: string | null;
  would_auto_write?: boolean;
  stage_reason?: string | null;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const db = getCloudflareDb();
  const [row] = await db
    .select({
      id: inboundEmails.id,
      receivedAt: inboundEmails.receivedAt,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      bodyText: inboundEmails.bodyText,
      bodyHtml: inboundEmails.bodyHtml,
      bodyTextExcerpt: inboundEmails.bodyTextExcerpt,
      rawSize: inboundEmails.rawSize,
      // OPE-187 — JSON [{key,name,mimeType,size}] so the detail panel can render
      // each poster/flyer (previewed + downloaded via the authed attachments route).
      attachmentRefs: inboundEmails.attachmentRefs,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, id))
    .limit(1);

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // OPE-205 §2 — the staged booth identifications for this email, oldest first
  // so they read in the order the photos were examined.
  const proposalRows = await db
    .select({
      id: adminActions.id,
      createdAt: adminActions.createdAt,
      payloadJson: adminActions.payloadJson,
    })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, BOOTH_PROPOSED_ACTION),
        eq(adminActions.targetType, "inbound_email"),
        eq(adminActions.targetId, id)
      )
    )
    .orderBy(asc(adminActions.createdAt));

  const boothProposals = proposalRows.map((p) => {
    let payload: BoothProposalPayload = {};
    try {
      payload = JSON.parse(p.payloadJson ?? "{}") as BoothProposalPayload;
    } catch {
      // A malformed payload must still list — showing the row with nothing
      // parsed beats hiding the fact that an identification exists.
    }
    return {
      id: p.id,
      createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
      eventId: payload.event_id ?? null,
      photoKey: payload.photo_key ?? null,
      photoName: payload.photo_name ?? null,
      businessName: payload.business_name ?? null,
      // Only ever emit an http(s) URL — see safeHttpUrl.
      website: safeHttpUrl(payload.website),
      products: payload.products ?? [],
      confidence: payload.confidence ?? null,
      rationale: payload.rationale ?? null,
      // "would have been auto-written at Milestone B" vs "held for a reason".
      wouldAutoWrite: payload.would_auto_write === true,
      stageReason: payload.stage_reason ?? null,
    };
  });

  // Name the fair once rather than making the reviewer resolve an id by eye.
  const eventId = boothProposals.find((p) => p.eventId)?.eventId ?? null;
  let proposalEvent: { id: string; name: string; slug: string } | null = null;
  if (eventId) {
    const [e] = await db
      .select({ id: events.id, name: events.name, slug: events.slug })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    proposalEvent = e ?? null;
  }

  return NextResponse.json({
    ...row,
    receivedAt: row.receivedAt instanceof Date ? row.receivedAt.toISOString() : row.receivedAt,
    boothProposals,
    proposalEvent,
  });
}
