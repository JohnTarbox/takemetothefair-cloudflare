/**
 * Public contact form for Enhanced Profile vendors. The vendor's email
 * never enters the DOM — sender submits a form, server-side this endpoint
 * forwards the message to the vendor's contactEmail via the existing
 * sendEmail() helper.
 *
 * Defense in depth:
 * - Rate-limited per IP (and per user when authenticated) via existing
 *   RATE_LIMIT_KV infra.
 * - Rejects with 400 when the target vendor's enhanced_profile flag is 0.
 *   The frontend only renders the form for Enhanced vendors, but a direct
 *   POST should also be rejected so this endpoint can't be used as a
 *   universal vendor-email scraper.
 * - Response never echoes the recipient address.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/send";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const bodySchema = z.object({
  senderName: z.string().min(1).max(100),
  senderEmail: z.string().email().max(255),
  message: z.string().min(1).max(2000),
});

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const rl = await checkRateLimit(request, "vendor-contact");
  if (!rl.allowed) return rateLimitResponse(rl);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", detail: parsed.error.issues[0]?.message ?? "validation failed" },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();

  try {
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        contactEmail: vendors.contactEmail,
        enhancedProfile: vendors.enhancedProfile,
      })
      .from(vendors)
      .where(eq(vendors.slug, slug))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const v = rows[0];

    if (!v.enhancedProfile) {
      // Don't leak whether or not the vendor has a contact email.
      return NextResponse.json({ error: "contact_not_available" }, { status: 400 });
    }

    if (!v.contactEmail) {
      return NextResponse.json({ error: "contact_not_available" }, { status: 400 });
    }

    const subject = `[MMATF] Inquiry from ${parsed.data.senderName}`;
    const text = `From: ${parsed.data.senderName} <${parsed.data.senderEmail}>

${parsed.data.message}

---
This message was sent through the contact form on https://meetmeatthefair.com/vendors/${slug}
Reply directly to ${parsed.data.senderEmail} to respond.`;

    // Minimal HTML mirror of the text body — the sendEmail helper requires
    // both. We escape the user-supplied fields to prevent HTML injection.
    const escapeHtml = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const html = `<p><strong>From:</strong> ${escapeHtml(parsed.data.senderName)} &lt;${escapeHtml(parsed.data.senderEmail)}&gt;</p>
<p style="white-space: pre-wrap;">${escapeHtml(parsed.data.message)}</p>
<hr/>
<p style="color: #666; font-size: 12px;">Sent through the contact form on
<a href="https://meetmeatthefair.com/vendors/${escapeHtml(slug)}">your MMATF profile</a>.
Reply directly to ${escapeHtml(parsed.data.senderEmail)} to respond.</p>`;

    const result = await sendEmail(db, {
      to: v.contactEmail,
      subject,
      text,
      html,
    });

    if (!result.ok) {
      // sendEmail logs internally; return generic error so we don't leak
      // anything about provider/config.
      return NextResponse.json({ error: "send_failed" }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    await logError(db, {
      message: "Vendor contact form failed",
      error,
      source: "api/vendors/[slug]/contact",
      request,
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
