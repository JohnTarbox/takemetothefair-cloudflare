export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { desc, eq, gte } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { errorLogs, faultSignatures } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { computeSignature, isNoise, normalizeErrorClass } from "@/lib/faults/signature";
import {
  reconcileFaults,
  type FaultLedgerRow,
  type FaultStatus,
  type GroupedFault,
} from "@/lib/faults/reconcile";
import { classifyFault } from "@/lib/faults/family-registry";

/**
 * POST /api/internal/faults/candidates  (OPE-81 — render-fault rail)
 *
 * The read+group+reconcile half of the detect→group→dedup→emit rail. Reads
 * `error_logs` within a window (default last 7 days, capped at the newest 5000
 * rows), DROPS un-actionable noise (isNoise), GROUPS the remainder by
 * computeSignature (count + distinct sessions + first/last seen + route + class),
 * loads the fault_signatures ledger, runs the pure reconcile core, APPLIES the
 * resulting upserts (propose new, touch active, regress recurred), and returns the
 * buckets a scheduled agent consumes:
 *
 *   { ok, toEmit, existing, regressions, deferred }
 *
 * Each candidate carries signature + route + errorClass + count + firstSeen +
 * lastSeen + token (`fault-sig:<signature>` — the agent's Linear dup pre-flight) +
 * classification (OPE-85 Tier-0 tag: root-cause class / fix pattern / guard status
 * for a known fault shape, else `unclassified` → full Tier-1 RCA).
 * Auth: X-Internal-Key. See reconcile.ts for the full agent handoff. Defensive by
 * contract — wrapped so it never 500s; a broken scan returns an empty, well-formed
 * result rather than an outage.
 */

/** Scan window: occurrences newer than this are considered. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on rows scanned per run (newest first) — bounds the query. */
const MAX_ROWS = 5000;

const toMs = (d: Date | null): number | null => (d ? d.getTime() : null);

/**
 * Best-effort session-ish key for distinct-session counting: a session/pathname
 * from the row's `context` JSON, else the row `url`. Null when nothing usable.
 */
function sessionKeyFor(contextJson: string | null, url: string | null): string | null {
  if (contextJson) {
    try {
      const ctx = JSON.parse(contextJson) as Record<string, unknown>;
      const candidate =
        ctx.sessionId ?? ctx.session ?? ctx.sid ?? ctx.pathname ?? ctx.path ?? ctx.url;
      if (typeof candidate === "string" && candidate) return candidate;
    } catch {
      // Malformed context JSON → fall through to url.
    }
  }
  return url && url.length > 0 ? url : null;
}

interface Accum {
  route: string | null;
  errorClass: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  sessions: Set<string>;
}

export const POST = withInternalKey({ source: "faults:candidates" }, async ({ db }) => {
  try {
    const now = new Date();
    const since = new Date(now.getTime() - WINDOW_MS);

    const rows = await db
      .select({
        message: errorLogs.message,
        route: errorLogs.route,
        digest: errorLogs.digest,
        url: errorLogs.url,
        context: errorLogs.context,
        timestamp: errorLogs.timestamp,
      })
      .from(errorLogs)
      .where(gte(errorLogs.timestamp, since))
      .orderBy(desc(errorLogs.timestamp))
      .limit(MAX_ROWS);

    // Group the non-noise rows by signature.
    const groups = new Map<string, Accum>();
    for (const r of rows) {
      if (isNoise(r.message)) continue;
      const signature = computeSignature({
        route: r.route,
        message: r.message,
        digest: r.digest,
      });
      const tsMs = r.timestamp ? r.timestamp.getTime() : now.getTime();
      const sessionKey = sessionKeyFor(r.context, r.url);
      const acc = groups.get(signature);
      if (!acc) {
        groups.set(signature, {
          route: r.route ?? null,
          errorClass: normalizeErrorClass(r.message),
          count: 1,
          firstSeen: tsMs,
          lastSeen: tsMs,
          sessions: sessionKey ? new Set([sessionKey]) : new Set(),
        });
      } else {
        acc.count += 1;
        if (tsMs < acc.firstSeen) acc.firstSeen = tsMs;
        if (tsMs > acc.lastSeen) acc.lastSeen = tsMs;
        if (sessionKey) acc.sessions.add(sessionKey);
      }
    }

    const grouped: GroupedFault[] = Array.from(groups.entries()).map(([signature, a]) => ({
      signature,
      route: a.route,
      errorClass: a.errorClass,
      count: a.count,
      // No usable session key on any row → sessions can't disambiguate; fall back
      // to the occurrence count so the sessions gate degrades gracefully.
      distinctSessions: a.sessions.size > 0 ? a.sessions.size : a.count,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
    }));

    const ledgerRows = await db.select().from(faultSignatures);
    const ledger: FaultLedgerRow[] = ledgerRows.map((r) => ({
      signature: r.signature,
      route: r.route,
      errorClass: r.errorClass,
      firstSeen: r.firstSeen.getTime(),
      lastSeen: r.lastSeen.getTime(),
      count: r.count,
      status: r.status as FaultStatus,
      opeId: r.opeId,
      filedAt: toMs(r.filedAt),
      resolvedAt: toMs(r.resolvedAt),
      createdAt: r.createdAt.getTime(),
    }));

    const result = reconcileFaults(grouped, ledger, now);

    // Apply the ledger mutations. Sequential + defensive: a single row failure
    // must not abort the scan or drop the response.
    for (const up of result.upserts) {
      try {
        if (up.op === "propose") {
          await db
            .insert(faultSignatures)
            .values({
              signature: up.signature,
              route: up.route,
              errorClass: up.errorClass,
              firstSeen: new Date(up.firstSeen),
              lastSeen: new Date(up.lastSeen),
              count: up.count,
              status: "proposed",
              opeId: null,
              filedAt: null,
              resolvedAt: null,
              createdAt: new Date(up.createdAt),
            })
            // Racing insert of the same NEW signature → just bump the live values;
            // never clobber status/createdAt of an already-persisted row.
            .onConflictDoUpdate({
              target: faultSignatures.signature,
              set: {
                route: up.route,
                errorClass: up.errorClass,
                lastSeen: new Date(up.lastSeen),
                count: up.count,
              },
            });
        } else if (up.op === "touch") {
          await db
            .update(faultSignatures)
            .set({ lastSeen: new Date(up.lastSeen), count: up.count })
            .where(eq(faultSignatures.signature, up.signature));
        } else {
          await db
            .update(faultSignatures)
            .set({ status: "regressed", lastSeen: new Date(up.lastSeen), count: up.count })
            .where(eq(faultSignatures.signature, up.signature));
        }
      } catch (err) {
        await logError(db, {
          level: "warn",
          source: "faults:candidates",
          message: "ledger upsert failed; scan continues",
          error: err,
          context: { op: up.op, signature: up.signature },
        });
      }
    }

    // OPE-85 — Tier-0 tag each emitted/regression candidate with its bug-family
    // classification so known fault shapes arrive pre-diagnosed. Pure + never
    // throws, so it can't break the response; kept at the endpoint boundary (the
    // reconcile core stays classification-agnostic).
    return NextResponse.json({
      ok: true,
      toEmit: result.toEmit.map((c) => ({
        ...c,
        classification: classifyFault({ errorClass: c.errorClass, route: c.route }),
      })),
      regressions: result.regressions.map((c) => ({
        ...c,
        classification: classifyFault({ errorClass: c.errorClass, route: c.route }),
      })),
      deferred: result.deferred,
      // The agent only needs enough to recognise an already-known fault.
      existing: result.existing.map((r) => ({
        signature: r.signature,
        route: r.route,
        errorClass: r.errorClass,
        status: r.status,
        opeId: r.opeId,
        count: r.count,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
      })),
    });
  } catch (error) {
    // Never throw / never 500 — a broken scan should be quiet, not an outage.
    await logError(db, {
      source: "faults:candidates",
      message: "fault candidates scan failed",
      error,
    });
    return NextResponse.json({
      ok: true,
      toEmit: [],
      regressions: [],
      deferred: [],
      existing: [],
    });
  }
});
