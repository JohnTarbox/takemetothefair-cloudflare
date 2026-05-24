/**
 * Regression sweep for the email-stub silent-failure mode discovered
 * 2026-05-24 (30 days of `email:stub` rows in error_logs, level=info,
 * silently absorbed because no transactional-email delivery monitor
 * existed). Returns a non-2xx status when any stub rows were written
 * in the trailing window so the user (or an external scheduler) can
 * page on it.
 *
 *   GET  /api/admin/email-stub-check        — defaults to last 24h
 *   GET  /api/admin/email-stub-check?hours=1
 *
 * Auth: admin session OR X-Internal-Key (matches the other admin
 * sweep endpoints). Status codes:
 *
 *   200 — zero stubs in the window. Healthy.
 *   503 — one or more stubs detected. Includes a sample so the user
 *         can identify the calling endpoint via the new `callerSource`
 *         field added in this same PR.
 *   401 — unauthorized.
 *   400 — bad query param.
 *
 * The 503 is intentional: it lets curl-based smoke tests and external
 * uptime monitors trip on a non-2xx without parsing JSON.
 */
import { NextResponse } from "next/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { errorLogs } from "@/lib/db/schema";

export const runtime = "edge";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 168; // one week — anything wider should query directly
const SAMPLE_LIMIT = 10;

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const hoursRaw = url.searchParams.get("hours");
  let hours = DEFAULT_WINDOW_HOURS;
  if (hoursRaw !== null) {
    const parsed = Number(hoursRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_WINDOW_HOURS) {
      return NextResponse.json(
        { error: `hours must be a positive number <= ${MAX_WINDOW_HOURS}` },
        { status: 400 }
      );
    }
    hours = parsed;
  }

  const db = getCloudflareDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);

  // Drizzle's timestamp_ms vs seconds inference: error_logs.timestamp is
  // declared as integer-seconds (unixepoch() default), so compare against
  // a seconds-epoch cutoff directly. The schema column is plain integer;
  // we lift via sql to avoid Drizzle re-interpreting as ms.
  const where = and(eq(errorLogs.source, "email:stub"), gte(sql`${errorLogs.timestamp}`, cutoff));

  const [{ stubs }] = await db
    .select({ stubs: sql<number>`count(*)` })
    .from(errorLogs)
    .where(where);

  const sample =
    stubs > 0
      ? await db
          .select({
            id: errorLogs.id,
            message: errorLogs.message,
            timestamp: errorLogs.timestamp,
            context: errorLogs.context,
          })
          .from(errorLogs)
          .where(where)
          .orderBy(sql`${errorLogs.timestamp} DESC`)
          .limit(SAMPLE_LIMIT)
      : [];

  const body = {
    ok: stubs === 0,
    window_hours: hours,
    cutoff_unix_seconds: cutoff,
    stubs_in_window: Number(stubs ?? 0),
    sample,
  };

  return NextResponse.json(body, { status: stubs === 0 ? 200 : 503 });
}
