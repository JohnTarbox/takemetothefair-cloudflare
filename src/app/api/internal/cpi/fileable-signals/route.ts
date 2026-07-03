export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { getLatestKpiStates } from "@/lib/kpi-states";
import { loadActionQueue } from "@/lib/analytics-overview/activity";
import { cpiSignalFilings } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import {
  DEFAULT_RATE_CAP_PER_RUN,
  isFileable,
  reconcileFilings,
  type FilingStatus,
  type LedgerRow,
} from "@/lib/cpi/auto-file";

/**
 * POST /api/internal/cpi/fileable-signals  (OPE-76 — CPI Move 2)
 *
 * The read+reconcile half of the auto-file rail. Rebuilds the §6.3 action queue
 * via the same path the overview page uses (latest KPI states → loadActionQueue),
 * keeps only the fileable signals (P0 always; P1 aged past the Move-1 72h
 * threshold), loads the cpi_signal_filings ledger, runs the pure reconcile core,
 * APPLIES the resulting upserts (insert/reopen 'proposed' rows, bump last_seen,
 * mark resolved), and returns the sorted buckets a scheduled agent consumes:
 *
 *   { ok, toFile, existing, resolved, deferred }
 *
 * Each signal carries fingerprint + priority + title + href + firstDetectedAt +
 * agentCode (the routing bracket). Auth: X-Internal-Key. See auto-file.ts for
 * the full agent handoff. Defensive by contract — wrapped so it never 500s; a
 * broken scan returns an empty, well-formed result rather than an outage.
 */

/** Signals filed per run — the flap guard. Constant (default 5/run). */
const RATE_CAP_PER_RUN = DEFAULT_RATE_CAP_PER_RUN;

const toMs = (d: Date | null): number | null => (d ? d.getTime() : null);
const toDate = (ms: number | null): Date | null => (ms != null ? new Date(ms) : null);

export const POST = withInternalKey({ source: "cpi:fileable-signals" }, async ({ db }) => {
  try {
    const now = new Date();

    const kpiStates = await getLatestKpiStates(db);
    const actionQueue = await loadActionQueue(db, kpiStates);
    const fileable = actionQueue.filter((e) => isFileable(e, now));

    const rows = await db.select().from(cpiSignalFilings);
    const ledger: LedgerRow[] = rows.map((r) => ({
      fingerprint: r.fingerprint,
      priority: r.priority,
      title: r.title,
      href: r.href,
      firstDetectedAt: toMs(r.firstDetectedAt),
      lastSeenAt: r.lastSeenAt.getTime(),
      status: r.status as FilingStatus,
      opeId: r.opeId,
      filedAt: toMs(r.filedAt),
      resolvedAt: toMs(r.resolvedAt),
      createdAt: r.createdAt.getTime(),
    }));

    const result = reconcileFilings(fileable, ledger, now, { rateCapPerRun: RATE_CAP_PER_RUN });

    // Apply the ledger mutations. Sequential + defensive: a single row failure
    // must not abort the scan or drop the response.
    for (const up of result.upserts) {
      try {
        if (up.op === "propose") {
          await db
            .insert(cpiSignalFilings)
            .values({
              fingerprint: up.fingerprint,
              priority: up.priority,
              title: up.title,
              href: up.href,
              firstDetectedAt: toDate(up.firstDetectedAt),
              lastSeenAt: new Date(up.lastSeenAt),
              status: "proposed",
              opeId: null,
              filedAt: null,
              resolvedAt: null,
              createdAt: new Date(up.createdAt),
            })
            // Reopen a returned 'resolved' row (or refresh a racing insert):
            // flip back to 'proposed' and clear prior filing state. createdAt is
            // intentionally NOT in the update set, so the original is preserved.
            .onConflictDoUpdate({
              target: cpiSignalFilings.fingerprint,
              set: {
                priority: up.priority,
                title: up.title,
                href: up.href,
                firstDetectedAt: toDate(up.firstDetectedAt),
                lastSeenAt: new Date(up.lastSeenAt),
                status: "proposed",
                opeId: null,
                filedAt: null,
                resolvedAt: null,
              },
            });
        } else if (up.op === "touch") {
          await db
            .update(cpiSignalFilings)
            .set({
              priority: up.priority,
              title: up.title,
              href: up.href,
              firstDetectedAt: toDate(up.firstDetectedAt),
              lastSeenAt: new Date(up.lastSeenAt),
            })
            .where(eq(cpiSignalFilings.fingerprint, up.fingerprint));
        } else {
          await db
            .update(cpiSignalFilings)
            .set({
              status: "resolved",
              resolvedAt: new Date(up.resolvedAt),
              lastSeenAt: new Date(up.lastSeenAt),
            })
            .where(eq(cpiSignalFilings.fingerprint, up.fingerprint));
        }
      } catch (err) {
        await logError(db, {
          level: "warn",
          source: "cpi:fileable-signals",
          message: "ledger upsert failed; scan continues",
          error: err,
          context: { op: up.op, fingerprint: up.fingerprint },
        });
      }
    }

    return NextResponse.json({
      ok: true,
      rateCapPerRun: RATE_CAP_PER_RUN,
      toFile: result.toFile,
      existing: result.existing,
      deferred: result.deferred,
      // The agent closes/comments these — enough to find + annotate the OPE.
      resolved: result.resolved.map((r) => ({
        fingerprint: r.fingerprint,
        priority: r.priority,
        title: r.title,
        href: r.href,
        opeId: r.opeId,
        firstDetectedAt: r.firstDetectedAt,
      })),
    });
  } catch (error) {
    // Never throw / never 500 — a broken scan should be quiet, not an outage.
    await logError(db, {
      source: "cpi:fileable-signals",
      message: "fileable-signals scan failed",
      error,
    });
    return NextResponse.json({
      ok: true,
      rateCapPerRun: RATE_CAP_PER_RUN,
      toFile: [],
      existing: [],
      deferred: [],
      resolved: [],
    });
  }
});
