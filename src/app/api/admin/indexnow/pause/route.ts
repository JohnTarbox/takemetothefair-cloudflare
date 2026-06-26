export const dynamic = "force-dynamic";
/**
 * Admin control for the REL4 IndexNow kill-switch (the `indexnow:paused` key in
 * RATE_LIMIT_KV that `pingIndexNow`'s circuit breaker honors).
 *
 * GET  → current pause state ({ paused, note }).
 * POST → body { paused: boolean, note?: string } sets/clears it.
 *
 * While paused, NO path contacts Bing (deferred enqueues still queue normally);
 * see src/lib/indexnow-breaker.ts. Admin-session only. Every flip writes an
 * admin_actions audit row so the operational pause/resume is traceable.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { adminActions } from "@/lib/db/schema";
import { getIndexNowPauseState, setIndexNowPaused } from "@/lib/indexnow-breaker";

export const GET = withAuth({ role: "ADMIN" }, async () => {
  const kv = getCloudflareRateLimitKv();
  if (!kv) {
    // No KV binding → breaker fails open (never blocks). Report unpaused so the
    // toggle reflects real behavior rather than a phantom "paused".
    return NextResponse.json({ paused: false, note: null, kvAvailable: false });
  }
  const state = await getIndexNowPauseState(kv);
  return NextResponse.json({ ...state, kvAvailable: true });
});

const bodySchema = z.object({
  paused: z.boolean(),
  note: z.string().max(200).optional(),
});

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const kv = getCloudflareRateLimitKv();
  if (!kv) {
    return NextResponse.json(
      { error: "kv_unavailable", message: "RATE_LIMIT_KV not bound — cannot set the kill-switch." },
      { status: 503 }
    );
  }

  const note =
    parsed.data.note ??
    `${parsed.data.paused ? "paused" : "resumed"} via admin/analytics by ${session.user.email ?? session.user.id} ${new Date().toISOString()}`;

  const ok = await setIndexNowPaused(kv, parsed.data.paused, note);
  if (!ok) {
    return NextResponse.json({ error: "kv_write_failed" }, { status: 502 });
  }

  // Audit trail — fire-and-forget; a logging failure must not fail the toggle.
  try {
    await db.insert(adminActions).values({
      action: parsed.data.paused ? "indexnow.pause" : "indexnow.resume",
      actorUserId: session.user.id ?? null,
      targetType: "indexnow",
      targetId: "kill-switch",
      payloadJson: JSON.stringify({ paused: parsed.data.paused, note }),
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("[indexnow/pause] failed to write admin_actions audit row:", err);
  }

  const state = await getIndexNowPauseState(kv);
  return NextResponse.json({ ...state, kvAvailable: true });
});
