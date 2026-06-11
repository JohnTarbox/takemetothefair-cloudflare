export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { newsletterSubscribers } from "@/lib/db/schema";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { logError } from "@/lib/logger";
import { issueNewsletterConfirmationToken } from "@/lib/email/newsletter-confirm-token";
import { newsletterConfirmTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/email/send";
import { enqueueEmail } from "@/lib/queues/producers";

const schema = z.object({
  email: z.string().email(),
  source: z.string().max(40).optional(),
});

/**
 * Double opt-in newsletter signup. Three paths:
 *
 *  1. Brand-new email: insert row with `confirmed=false`, issue token,
 *     send confirmation email. User must click link → `confirmed=true`.
 *  2. Existing UNCONFIRMED email: re-issue token (overwriting any prior
 *     outstanding token), re-send confirmation email. Handles the
 *     "lost the email, tried again" case.
 *  3. Existing CONFIRMED email: no-op. If they were unsubscribed, flip
 *     unsubscribed=false so they're re-subscribed without a fresh
 *     confirm round-trip (they've already proven email control once).
 *
 * The response is the same `{ ok: true }` shape in all paths so the
 * form doesn't leak whether an email is on the list (enumeration-safe).
 */
export async function POST(request: NextRequest) {
  const rl = await checkRateLimit(request, "newsletter-subscribe");
  if (!rl.allowed) return rateLimitResponse(rl);

  const db = getCloudflareDb();
  const GENERIC_OK = NextResponse.json({ ok: true });

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) return GENERIC_OK;

    const email = parsed.data.email.toLowerCase().trim();
    const source = parsed.data.source?.slice(0, 40) ?? "footer";

    const existing = await db.query.newsletterSubscribers.findFirst({
      where: eq(newsletterSubscribers.email, email),
    });

    let shouldSendConfirm = false;
    if (existing) {
      if (existing.confirmed) {
        // Already confirmed: this is a re-subscribe attempt. If they
        // were unsubscribed, flip them back on — they've already proven
        // email control via the prior confirmation. Don't re-confirm.
        if (existing.unsubscribed) {
          await db
            .update(newsletterSubscribers)
            .set({ unsubscribed: false })
            .where(eq(newsletterSubscribers.email, email));
        }
      } else {
        // Existing but unconfirmed: re-issue the confirmation token.
        // This covers two cases: (a) the prior email got lost, (b) the
        // user is grandfathered from the pre-double-opt-in era and is
        // re-submitting to actually get on the list. In both cases the
        // right action is to send a fresh confirm.
        shouldSendConfirm = true;
      }
    } else {
      // Brand-new signup. Insert + send confirmation.
      await db.insert(newsletterSubscribers).values({
        email,
        source,
      });
      shouldSendConfirm = true;
    }

    if (shouldSendConfirm) {
      try {
        const { rawToken } = await issueNewsletterConfirmationToken(db, email);
        const confirmUrl = `${getSiteUrl()}/api/newsletter/confirm?token=${rawToken}`;
        const tpl = newsletterConfirmTemplate({ confirmUrl });
        await enqueueEmail({
          to: email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          source: "newsletter.subscribe-confirm",
        });
      } catch (mailErr) {
        // Don't block signup on email-dispatch failure — the row is
        // already in the DB; the user can re-submit to retry. Log so
        // the email-stub sweep catches systematic failures.
        await logError(db, {
          level: "warn",
          message: "Failed to enqueue newsletter confirmation email",
          error: mailErr,
          source: "api/newsletter/subscribe:confirm-email",
          context: { email },
        });
      }
    }

    return GENERIC_OK;
  } catch (error) {
    await logError(db, {
      message: "Newsletter signup error",
      error,
      source: "api/newsletter/subscribe",
      request,
    });
    return GENERIC_OK;
  }
}
