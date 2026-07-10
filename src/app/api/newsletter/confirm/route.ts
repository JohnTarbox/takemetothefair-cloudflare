export const dynamic = "force-dynamic";
/**
 * Newsletter double opt-in confirmation endpoint. The link in the
 * confirmation email points here as a GET so it works from any mail
 * client (no form submission required). On success, we 303-redirect to
 * /newsletter/confirmed (a simple Next.js page); on failure, we
 * redirect to the same page with a query string carrying the reason,
 * so the page can show a tailored message.
 *
 * Token semantics are in src/lib/email/newsletter-confirm-token.ts —
 * single-use, 14-day TTL (OPE-168), race-safe on the consume update.
 *
 * Auth: none. The raw token IS the authorization — anyone holding it
 * implicitly proves email control because it was emailed to that
 * address. Mirrors the vendor-claim/confirm pattern.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { consumeNewsletterConfirmationToken } from "@/lib/email/newsletter-confirm-token";
import { getSiteUrl } from "@/lib/email/send";
import { logError } from "@/lib/logger";

function redirectTo(request: NextRequest, query: string) {
  return NextResponse.redirect(`${getSiteUrl()}/newsletter/confirmed${query}`, {
    status: 303,
  });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  if (!token) {
    return redirectTo(request, "?status=missing_token");
  }

  const db = getCloudflareDb();
  try {
    const result = await consumeNewsletterConfirmationToken(db, token);
    if (result.ok) {
      return redirectTo(request, "?status=ok");
    }
    return redirectTo(request, `?status=${encodeURIComponent(result.reason)}`);
  } catch (e) {
    await logError(db, {
      message: "Newsletter confirm endpoint threw",
      error: e,
      source: "api/newsletter/confirm",
    });
    return redirectTo(request, "?status=server_error");
  }
}
