export const dynamic = "force-dynamic";
/**
 * OPE-634 — enumerate the cohort a funnel outage blocked.
 *
 * Answers "who started registration between X and Y and never finished", which
 * before this table was unanswerable by construction: a blocked signup is
 * someone with no `users` row, so they cannot be found by querying the thing
 * they failed to create.
 *
 * ⚠️ Read-only, admin-gated, and deliberately NOT wired to any sender. Contacting
 * people who failed to sign up weeks ago is customer-facing outbound and is
 * STOP-gated on OPE-634. Build the enumeration; do not arm it.
 */
import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { listBlockedRegistrations } from "@/lib/auth/record-registration-attempt";

const DEFAULT_WINDOW_DAYS = 30;

export async function GET(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const url = new URL(request.url);
  const untilParam = url.searchParams.get("until");
  const sinceParam = url.searchParams.get("since");

  const until = untilParam ? new Date(untilParam) : new Date();
  const since = sinceParam
    ? new Date(sinceParam)
    : new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    return NextResponse.json({ error: "invalid_window" }, { status: 400 });
  }

  const rows = await listBlockedRegistrations(getCloudflareDb(), { since, until });

  return NextResponse.json({
    window: { since: since.toISOString(), until: until.toISOString() },
    count: rows.length,
    // Stated on every response so an empty result is never read as "nobody was
    // blocked" when it may mean "nothing was recorded yet". The table starts
    // empty at deploy, and for the OPE-150 / OPE-173 windows it will stay that
    // way — that data was never written and cannot be reconstructed.
    coverage_note:
      "Only attempts recorded since the OPE-634 deploy appear here. Windows before that deploy return empty because the data was never captured, NOT because nobody was blocked.",
    attempts: rows,
  });
}
