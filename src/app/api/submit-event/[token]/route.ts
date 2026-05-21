/**
 * POST /api/submit-event/<token> — B4 correction-form submit endpoint.
 *
 * Auth: the token IS the auth. No session check, no Turnstile (the
 * sender already authenticated themselves by clicking through the link
 * in the email we sent them).
 *
 * Atomicity: consumeCorrectionToken uses a WHERE used_at IS NULL guard
 * so concurrent POSTs from a double-click or two-tab race produce
 * exactly one successful update; the loser sees a 409.
 *
 * Validation: same shape as the main submit endpoint's editable subset.
 * Conservative — we silently drop fields the schema doesn't expect
 * (Zod's default behavior) rather than reject the whole payload, so a
 * future schema addition doesn't break old correction-form pages
 * still in users' inboxes.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { consumeCorrectionToken, lookupCorrectionToken } from "@/lib/correction-tokens";

export const runtime = "edge";

const correctionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  startDate: z.string().optional(), // YYYY-MM-DD
  endDate: z.string().optional(),
  stateCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .or(z.literal("")),
  ticketUrl: z.string().url().optional().or(z.literal("")),
  imageUrl: z.string().url().optional().or(z.literal("")),
});

interface RouteContext {
  params: Promise<{ token: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { token } = await context.params;

  const db = getCloudflareDb();

  // Look up first (cheap read) so we can distinguish "expired/used"
  // from "doesn't exist" and return a specific error code. The atomic
  // consume happens after we've validated the payload, to avoid burning
  // the token on a malformed POST.
  const lookup = await lookupCorrectionToken(db, token);
  if (lookup.status === "not-found") {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }
  if (lookup.status === "used") {
    return NextResponse.json(
      { error: "This correction link has already been used" },
      { status: 410 }
    );
  }
  if (lookup.status === "expired") {
    return NextResponse.json({ error: "This correction link has expired" }, { status: 410 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = correctionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Validation failed" },
      { status: 400 }
    );
  }

  // Atomically mark used. If false, someone else beat us — return 409
  // and DON'T write any event changes (avoid the half-applied case
  // where both POSTs partially edit the event).
  const claimed = await consumeCorrectionToken(db, token);
  if (!claimed) {
    return NextResponse.json(
      { error: "This correction link was just used in another tab" },
      { status: 409 }
    );
  }

  // Map the validated payload to the events update set. Date strings
  // get parsed as UTC midnight (matches main app's storage convention);
  // empty strings → null so the column reflects "cleared" not "literal
  // empty string".
  const data = parsed.data;
  const updateSet: Partial<typeof events.$inferInsert> = {};
  if (data.name !== undefined) updateSet.name = data.name;
  if (data.description !== undefined) updateSet.description = data.description || null;
  if (data.startDate) updateSet.startDate = parseDateUtc(data.startDate);
  if (data.endDate) updateSet.endDate = parseDateUtc(data.endDate);
  if (data.stateCode !== undefined) updateSet.stateCode = data.stateCode || null;
  if (data.ticketUrl !== undefined) updateSet.ticketUrl = data.ticketUrl || null;
  if (data.imageUrl !== undefined) updateSet.imageUrl = data.imageUrl || null;

  if (Object.keys(updateSet).length === 0) {
    // Empty submission. Token's already consumed — that's intentional
    // (the user explicitly chose to submit with no changes). Return
    // success so the form's success state renders.
    return NextResponse.json({ success: true, fieldsUpdated: 0 });
  }

  updateSet.updatedAt = new Date();
  await db.update(events).set(updateSet).where(eq(events.id, lookup.eventId));

  return NextResponse.json({
    success: true,
    fieldsUpdated: Object.keys(updateSet).length - 1, // minus updatedAt
  });
}

/**
 * Parse YYYY-MM-DD as a Date at UTC midnight. Matches the main app's
 * storage convention (event dates are stored as a UTC instant at the
 * day's midnight — see drizzle/0074 noon-UTC migration's docblock).
 * Returns null for unparseable input rather than throwing.
 */
function parseDateUtc(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}
