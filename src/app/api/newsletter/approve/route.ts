export const dynamic = "force-dynamic";
/**
 * OPE-231 — one-tap "Approve & send to everyone" for the Weekend Fair Digest.
 *
 * This endpoint performs a LIVE CUSTOMER BROADCAST of a previewed issue from a
 * tokenized link in John's inbox. Its safety rests on four things, all here:
 *
 *  1. POST only. There is deliberately NO GET handler — an inbox link
 *     pre-scanner (or John's mail client prefetching the URL) issues a GET, and
 *     a GET that broadcasts would fire the list on a machine fetch. The email
 *     button points at the /newsletter/approve PAGE (read-only), which renders a
 *     confirm form that POSTs here. A send needs a human's explicit click.
 *  2. Signed, TTL-bounded token (newsletter-approve-token.ts) — unguessable and
 *     self-expiring, bound to one issue slug.
 *  3. Single-use via a race-safe latch on `newsletter_issues.sent_at`: the
 *     broadcast is claimed with a conditional UPDATE ... WHERE sent_at IS NULL.
 *     A replayed token, a double-click, or two concurrent POSTs all lose the
 *     latch and send nothing.
 *  4. The OPE-6 gate `NEWSLETTER_SEND_ENABLED` — re-checked here, not just on
 *     the page, so the API can never broadcast while sending is disabled.
 *
 * Auth is the token itself (John has no session on his phone), exactly like the
 * public unsubscribe route. No admin wrapper.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { getSiteUrl } from "@/lib/email/send";
import { resolveUnsubscribeSecret } from "@/lib/email/newsletter-unsubscribe-token";
import { resolveApproveSecret, verifyApproveToken } from "@/lib/email/newsletter-approve-token";
import {
  enqueueNewsletterDigest,
  selectBroadcastRecipients,
} from "@/lib/email/newsletter-broadcast";

/** All outcomes redirect to the confirm/result page with a status. Zero sends
 *  on every branch except the one that wins the latch. */
function redirect(status: string, extra: Record<string, string> = {}) {
  const qs = new URLSearchParams({ status, ...extra }).toString();
  return NextResponse.redirect(`${getSiteUrl()}/newsletter/approve?${qs}`, { status: 303 });
}

/** Read the token from an HTML form post (the confirm page) or a JSON body. */
async function readToken(request: NextRequest): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { token?: unknown };
      return typeof body.token === "string" ? body.token : "";
    }
    const form = await request.formData();
    const token = form.get("token");
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  try {
    const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;

    const token = await readToken(request);
    if (!token) return redirect("invalid");

    const approveSecret = resolveApproveSecret(env);
    if (!approveSecret) return redirect("server_error");

    const claims = await verifyApproveToken(token, approveSecret);
    if (!claims) return redirect("invalid"); // bad signature OR expired

    const slug = claims.slug;

    // Load the previewed issue. Its stored HTML is what gets broadcast — no
    // re-render, so subscribers receive exactly what John reviewed.
    const [issue] = await db
      .select({
        slug: newsletterIssues.slug,
        subject: newsletterIssues.subject,
        html: newsletterIssues.html,
        sentAt: newsletterIssues.sentAt,
      })
      .from(newsletterIssues)
      .where(eq(newsletterIssues.slug, slug))
      .limit(1);

    if (!issue) return redirect("not_found");
    if (issue.sentAt) return redirect("already_sent");

    // OPE-6 gate, re-checked server-side. The page shows a "disabled" state, but
    // the API must independently refuse so it can never broadcast while off.
    if (env.NEWSLETTER_SEND_ENABLED !== "true") return redirect("disabled");

    const secret = resolveUnsubscribeSecret(env);
    if (!secret) return redirect("server_error");

    // Single-use latch. Claim the issue by flipping sent_at only while it is
    // still NULL; RETURNING tells us whether THIS request won. A concurrent
    // second POST (or a replayed token) matches zero rows and sends nothing.
    const now = new Date();
    const claimed = await db
      .update(newsletterIssues)
      .set({ sentAt: now })
      .where(and(eq(newsletterIssues.slug, slug), isNull(newsletterIssues.sentAt)))
      .returning({ slug: newsletterIssues.slug });

    if (claimed.length === 0) return redirect("already_sent");

    // We own the latch — broadcast the stored issue. If enqueue throws partway,
    // sent_at is already set (the issue won't double-send); the partial failure
    // is logged, consistent with the existing broadcast path's best-effort send.
    const recipients = await selectBroadcastRecipients(db);
    const siteUrl = getSiteUrl();
    const queued = await enqueueNewsletterDigest({
      recipients,
      subject: issue.subject,
      contentHtml: issue.html,
      viewInBrowserUrl: `${siteUrl}/newsletter/${slug}`,
      siteUrl,
      secret,
      mailingAddress: env.MAILING_ADDRESS,
      // No approveUrl — a broadcast never carries the approve button.
    });

    return redirect("sent", { count: String(queued) });
  } catch (err) {
    await logError(db, {
      level: "error",
      source: "newsletter:approve",
      message: "approve broadcast failed",
      error: err,
    });
    return redirect("server_error");
  }
}
