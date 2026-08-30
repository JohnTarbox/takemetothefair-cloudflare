export const dynamic = "force-dynamic";
/**
 * OPE-637 constraint 3 — self-tune the verification staleness window.
 *
 * Reads the observed `email_verified − created_at` distribution for REAL
 * registrations and moves `verification_alert_threshold_hours` to its p90,
 * clamped to [12, 168].
 *
 * Bounded on both sides on purpose: this value governs a live operator alert.
 * Below the floor the queue indicts people who signed up an hour ago; above the
 * ceiling a genuine drop-off problem stays invisible for over a week. It also
 * refuses to move on thin evidence — under 20 samples one unusual week could
 * swing the window across its whole range, which is worse than leaving it where
 * a human put it.
 *
 * Placeholder accounts are excluded (`origin = 'registration'`): `pending+…@`
 * owner rows are not registrations and never verify (OPE-292), so including
 * them would drag the distribution toward the ceiling and hide everything.
 *
 * Logs what it changed and why, per the acceptance criterion — a tuner that
 * silently rewrites an alert threshold is the same class of problem as the
 * hardcoded constant it replaces.
 */
import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { users, tunableThresholds } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import {
  VERIFICATION_GRACE_KEY,
  VERIFICATION_TUNE_MIN_SAMPLES,
  VERIFICATION_TUNE_PERCENTILE,
  VERIFICATION_GRACE_FLOOR_HOURS,
  VERIFICATION_GRACE_CEILING_HOURS,
  computeTunedGraceHours,
  loadVerificationGraceHours,
} from "@/lib/verification-threshold";

/** Days of confirm history the tuner learns from. */
const LOOKBACK_DAYS = 90;

export async function POST(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const db = getCloudflareDb();
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const previous = await loadVerificationGraceHours(db);

  const rows = await db
    .select({
      delayHours: sql<number>`(${users.emailVerified} - ${users.createdAt}) / 3600.0`,
    })
    .from(users)
    .where(
      and(
        eq(users.origin, "registration"),
        isNotNull(users.emailVerified),
        gte(users.createdAt, since)
      )
    );

  const samples = rows.map((r) => Number(r.delayHours)).filter((h) => Number.isFinite(h) && h >= 0);
  const tuned = computeTunedGraceHours(samples);

  if (tuned === null) {
    // Not an error — the honest outcome when there is not enough evidence.
    await logError(db, {
      level: "info",
      source: "app/api/admin/thresholds/tune-verification",
      message: `verification threshold unchanged at ${previous}h — ${samples.length} samples, need ${VERIFICATION_TUNE_MIN_SAMPLES}`,
      context: { previous, samples: samples.length, lookbackDays: LOOKBACK_DAYS },
    });
    return NextResponse.json({
      ok: true,
      changed: false,
      reason: "insufficient_samples",
      previous,
      samples: samples.length,
      minSamples: VERIFICATION_TUNE_MIN_SAMPLES,
    });
  }

  if (tuned !== previous) {
    await db
      .insert(tunableThresholds)
      .values({
        key: VERIFICATION_GRACE_KEY,
        value: tuned,
        unit: "hours",
        note: `Self-tuned ${now.toISOString().slice(0, 10)}: p${VERIFICATION_TUNE_PERCENTILE * 100} of ${samples.length} observed confirm delays over ${LOOKBACK_DAYS}d, clamped to [${VERIFICATION_GRACE_FLOOR_HOURS},${VERIFICATION_GRACE_CEILING_HOURS}]. OPE-637.`,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tunableThresholds.key,
        set: { value: tuned, unit: "hours", updatedAt: now },
      });
  }

  await logError(db, {
    level: "info",
    source: "app/api/admin/thresholds/tune-verification",
    message:
      tuned === previous
        ? `verification threshold held at ${previous}h (p90 of ${samples.length} samples agrees)`
        : `verification threshold ${previous}h -> ${tuned}h (p90 of ${samples.length} samples)`,
    context: { previous, tuned, samples: samples.length, lookbackDays: LOOKBACK_DAYS },
  });

  return NextResponse.json({
    ok: true,
    changed: tuned !== previous,
    previous,
    tuned,
    samples: samples.length,
    percentile: VERIFICATION_TUNE_PERCENTILE,
    floor: VERIFICATION_GRACE_FLOOR_HOURS,
    ceiling: VERIFICATION_GRACE_CEILING_HOURS,
  });
}
