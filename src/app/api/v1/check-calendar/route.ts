export const dynamic = "force-dynamic";
/**
 * OPE-1625 — `POST /api/v1/check-calendar` `{ "url": "…" }`: read a calendar,
 * iCal, Events Calendar REST or schema.org Event page URL and report the events
 * we would pick up, the ones we would skip and why, and the problems.
 *
 * Public and unauthenticated, so: SSRF-guarded fetches (fetch-calendar.ts), a
 * per-IP cap (20/hour, BurstCounter DO, fails closed), and NO WRITES — the
 * engine gets a read-only database handle, and failures go to the Worker log,
 * not error_logs. Used by /check-my-calendar (unlisted until OPE-1624).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  checkCalendar,
  checkCalendarRateLimit,
  clientIp,
} from "@/lib/test-submission/check-calendar";
import { CalendarFetchError } from "@/lib/test-submission/fetch-calendar";
import { readOnlyDb } from "@/lib/test-submission/read-only-db";

const bodySchema = z.strictObject({ url: z.string().trim().min(1).max(2048) });

const error = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  NextResponse.json({ error: { code, message } }, { status, headers });

export async function POST(request: Request) {
  const limit = await checkCalendarRateLimit(clientIp(request));
  if (!limit.allowed)
    return error(
      limit.status,
      limit.status === 429 ? "rate_limited" : "unavailable",
      limit.status === 429
        ? "Too many checks from your address. Try again later."
        : "Checking is unavailable right now. Try again shortly.",
      { "Retry-After": String(limit.retryAfterSeconds) }
    );

  let json: unknown;
  try {
    json = JSON.parse((await request.text()).slice(0, 8192));
  } catch {
    return error(400, "invalid_json", 'Send JSON: { "url": "https://…" }.');
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return error(422, "invalid_url", "Send the calendar's web address as url.");

  try {
    const report = await checkCalendar(readOnlyDb(getCloudflareDb()), parsed.data.url, {
      now: new Date(),
    });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof CalendarFetchError) {
      const status = e.code === "invalid_url" || e.code === "blocked_url" ? 422 : 502;
      return error(status, e.code, e.message);
    }
    // Worker log only: this route writes nothing, error_logs included.
    console.error("[check-calendar] failed", e);
    return error(500, "internal_error", "Something went wrong on our side.");
  }
}
