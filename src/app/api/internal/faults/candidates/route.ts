export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, notInArray } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { errorLogs, faultSignatures } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { classifyNoise, computeSignature, normalizeErrorClass } from "@/lib/faults/signature";
import {
  reconcileFaults,
  type FaultLedgerRow,
  type FaultStatus,
  type GroupedFault,
} from "@/lib/faults/reconcile";
import { buildRailHealth } from "@/lib/faults/status";
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

/** OPE-93 heartbeat source name, hoisted so the never-ingest list can name it. */
const EMIT_HEARTBEAT_SOURCE_NAME = "mcp:fault-signatures-emit";

/** Scan window: occurrences newer than this are considered. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on rows scanned per run (newest first) — bounds the query. */
const MAX_ROWS = 5000;
/**
 * OPE-93: this is the RENDER-fault pipeline — only user-facing render errors
 * belong here. `server-render` = the onRequestError capture (OPE-80); `client` =
 * the React error-boundary reports (OPE-25). Without this filter the emitter
 * grouped EVERY error_logs row (API errors, cron logs, IndexNow failures, the
 * heartbeat below), so it would have filed "render-fault" OPEs for arbitrary
 * backend errors — and re-ingested its own heartbeat. Scope it to render sources.
 */
const RENDER_FAULT_SOURCES = ["server-render", "client"];

/**
 * OPE-615 — sources that must NEVER be ingested, now that the scan is no longer
 * limited to the render lane.
 *
 * OPE-93's warning is the reason this list exists and not a reason to stay
 * narrow: without a filter the emitter grouped EVERY `error_logs` row including
 * its own heartbeat, and re-ingested itself. The answer is to exclude the
 * self-referential sources by name, not to exclude the whole server side.
 */
const NEVER_INGEST_SOURCES = [
  // The emitter's own "I ran" stamp (OPE-93).
  EMIT_HEARTBEAT_SOURCE_NAME,
  // This route's own failures — ingesting them would make a broken emitter
  // file OPEs about itself, forever.
  "faults:candidates",
];
/** Heartbeat source — the operator's "when did the emitter last run" signal
 *  (OPE-93). Excluded from RENDER_FAULT_SOURCES so it's never re-ingested. */
const EMIT_HEARTBEAT_SOURCE = EMIT_HEARTBEAT_SOURCE_NAME;

const toMs = (d: Date | null): number | null => (d ? d.getTime() : null);

/**
 * Best-effort session key for distinct-session counting. Null when the row
 * carries nothing that actually identifies a SESSION.
 *
 * OPE-488 — this deliberately no longer falls back to `pathname` / `path` /
 * `url`. Those are ROUTE identity, and the signature is already route-scoped
 * (`route#errorClass`), so every row in a group shared one value and
 * `distinctSessions` was structurally 1 for the entire client-error lane.
 *
 * That silently killed the escape hatch it feeds. `reconcileFaults` gates on
 * `count >= minCount || distinctSessions >= minSessions`; the second clause
 * exists to catch a fault that is LOW-VOLUME PER ROUTE BUT WIDESPREAD — which is
 * precisely the shape of a chunk/bundle fault hitting 49 routes once each. A
 * constant 1 meant it could never fire, so eligibility silently collapsed to the
 * count gate alone.
 *
 * Returning null is the honest answer: the caller already degrades to the
 * occurrence count when a group has no usable session key, which is the
 * documented intent. Client rows in prod carry only `errorType` / `pathname` /
 * `reportedUrl`, so today this returns null for that lane — a real measurement
 * of "we cannot distinguish sessions", not a fabricated 1.
 */
function sessionKeyFor(contextJson: string | null, url: string | null): string | null {
  if (contextJson) {
    try {
      const ctx = JSON.parse(contextJson) as Record<string, unknown>;
      const candidate = ctx.sessionId ?? ctx.session ?? ctx.sid;
      if (typeof candidate === "string" && candidate) return candidate;
    } catch {
      // Malformed context JSON → no session key.
    }
  }
  // `url` is the INGEST endpoint for client reports (every row reads
  // ".../api/client-errors"), so it never distinguished sessions either.
  void url;
  return null;
}

interface Accum {
  route: string | null;
  errorClass: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  sessions: Set<string>;
}

export const POST = withInternalKey({ source: "faults:candidates" }, async ({ db, request }) => {
  try {
    const now = new Date();
    // OPE-615 scope 3 — the backfill is THIS emitter run over a longer window,
    // not a hand-inserted set of rows. The ticket says "do not hand-insert",
    // and it is right: a backfill written by hand proves nothing about whether
    // the emitter would have produced those rows itself.
    //
    // Capped at 30 days, which is also D1's Time Travel horizon — beyond it
    // there is nothing to reconcile against anyway.
    let windowMs = WINDOW_MS;
    try {
      const body = (await request.clone().json()) as { window_days?: number } | null;
      const d = Number(body?.window_days);
      if (Number.isFinite(d) && d > 0) windowMs = Math.min(d, 30) * 24 * 60 * 60 * 1000;
    } catch {
      // No body, or not JSON — the default 7-day window is the normal case.
    }
    const since = new Date(now.getTime() - windowMs);

    // OPE-615 — the emitter is no longer limited to the render lane.
    //
    // It scanned `source IN ('server-render','client')`. Everything else —
    // route handlers, scheduled jobs, workflows, queue consumers — could recur
    // for weeks and never mint a signature. Measured over 7 days on prod:
    // 209 rows in scope against 134 rows across 16 EXCLUDED sources, and the
    // two largest excluded ones were the two live defects
    // (`app/events/page.tsx:getEvents` 88, `api/admin/import-url/extract` 26).
    //
    // The consequence is self-certifying: four consecutive OPE-84 runs found
    // every fileable fault in the out-of-ledger sweep and none in the ledger,
    // and a clean ledger reads to a human as a clean production.
    //
    // Now an exclusion list rather than an allow-list, so a NEW source is
    // watched by default. That is the direction that fails safe — the old shape
    // silently ignored every source nobody remembered to add.
    const rows = await db
      .select({
        message: errorLogs.message,
        route: errorLogs.route,
        source: errorLogs.source,
        digest: errorLogs.digest,
        url: errorLogs.url,
        context: errorLogs.context,
        // OPE-577 — needed for extension-injection stack-shape detection.
        stackTrace: errorLogs.stackTrace,
        timestamp: errorLogs.timestamp,
      })
      .from(errorLogs)
      .where(
        and(
          gte(errorLogs.timestamp, since),
          eq(errorLogs.level, "error"),
          notInArray(errorLogs.source, NEVER_INGEST_SOURCES)
        )
      )
      .orderBy(desc(errorLogs.timestamp))
      .limit(MAX_ROWS);

    // Group the non-noise rows by signature.
    //
    // OPE-251: noise classification is now ROUTE-AWARE. Third-party embed
    // shapes are suppressed on ordinary routes but stay full candidates on
    // conversion/auth routes — `/register#script error.` was the CORS-masked
    // registration-blocking Turnstile throw (OPE-173), not noise.
    //
    // Suppressed hits are COUNTED, never silently dropped: a denylist that
    // hides a volume anomaly just moves the blindness somewhere else. The
    // per-reason tallies ride out in the response and are logged once per run.
    const groups = new Map<string, Accum>();
    const suppressed: Record<string, number> = {};
    let suppressedTotal = 0;
    for (const r of rows) {
      // OPE-577 — classify on PROVENANCE (where the code came from) as well as
      // message text. `context.thirdParty` is set by the client reporter and
      // the stack shape identifies extension injection; neither can be defeated
      // by a third party changing its wording.
      const verdict = classifyNoise({
        message: r.message,
        route: r.route,
        context: r.context,
        stackTrace: r.stackTrace,
      });
      if (verdict.noise) {
        const key = `${verdict.reason}:${verdict.matched}`;
        suppressed[key] = (suppressed[key] ?? 0) + 1;
        suppressedTotal += 1;
        continue;
      }
      // OPE-615 — server rows key on `source`, not on `route`.
      //
      // `computeSignature` falls back to the literal "unknown" when route is
      // null, and route IS null on every server row — so widening the scan
      // without this would collapse every backend fault in the system into one
      // signature per error class. `source` is a stable, high-quality grouping
      // key and is strictly better than the route key the render lane uses.
      const isRenderLane = RENDER_FAULT_SOURCES.includes(r.source ?? "");
      const groupKey = isRenderLane ? r.route : (r.source ?? r.route);
      const signature = computeSignature({
        route: groupKey,
        message: r.message,
        digest: r.digest,
      });
      const tsMs = r.timestamp ? r.timestamp.getTime() : now.getTime();
      // OPE-615 scope 2 — for a server fault, a distinct DAY is the analogue of
      // a distinct session.
      //
      // The `minSessions` gate was tuned against burst-prone browser noise, and
      // on server rows there is no session key at all, so `distinctSessions`
      // degrades to the raw count — which ranks a 3-second loop-burst ABOVE a
      // cron that fails once a day. That is backwards: the burst is one event,
      // the cron is a standing fault.
      //
      // Keying the session dimension on the UTC day inverts it with no new
      // threshold: five errors inside one burst count as ONE, and three days of
      // a failing cron count as THREE.
      const sessionKey = isRenderLane
        ? sessionKeyFor(r.context, r.url)
        : new Date(tsMs).toISOString().slice(0, 10);
      const acc = groups.get(signature);
      if (!acc) {
        groups.set(signature, {
          route: groupKey ?? null,
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

    // OPE-93 — emitter heartbeat. One info row per run so the operator (and the
    // OPE-83 dashboard) can answer "when did the emitter last run, and what did it
    // do?" — the empty-ledger ambiguity that prompted this audit. Best-effort;
    // its own source is excluded from RENDER_FAULT_SOURCES so it's never
    // re-ingested as a fault.
    await logError(db, {
      level: "info",
      source: EMIT_HEARTBEAT_SOURCE,
      // OPE-488 — `suppressed` and `subThreshold` are in the message because the
      // old line accounted for only a fraction of what it scanned: "70 rows → 15
      // signatures; toEmit=0 ... existing=1" left 14 signatures unaccounted for,
      // and read as a dead emitter to two separate readers. Every scanned row now
      // lands in a named bucket.
      message:
        `fault emit: scanned ${rows.length} render rows → ${grouped.length} signatures ` +
        `(noise-suppressed ${suppressedTotal}); toEmit=${result.toEmit.length} ` +
        `regressions=${result.regressions.length} existing=${result.existing.length} ` +
        `deferred=${result.deferred.length} subThreshold=${result.subThreshold.length}`,
      context: {
        scanned: rows.length,
        signatures: grouped.length,
        suppressed: suppressedTotal,
        toEmit: result.toEmit.length,
        regressions: result.regressions.length,
        existing: result.existing.length,
        deferred: result.deferred.length,
        subThreshold: result.subThreshold.length,
      },
    });

    // OPE-85 — Tier-0 tag each emitted/regression candidate with its bug-family
    // classification so known fault shapes arrive pre-diagnosed. Pure + never
    // throws, so it can't break the response; kept at the endpoint boundary (the
    // reconcile core stays classification-agnostic).
    // OPE-251 §4 — one info-level audit line per run (not per occurrence: a
    // per-hit log would itself become the noise this ticket is removing).
    if (suppressedTotal > 0) {
      await logError(db, {
        level: "info",
        source: "faults:noise-denylist",
        message: `auto-classified ${suppressedTotal} occurrence(s) as noise`,
        context: { suppressedTotal, byPattern: suppressed },
      });
    }

    return NextResponse.json({
      ok: true,
      // Visible in the response so a volume anomaly in SUPPRESSED traffic is
      // still observable — suppression must not mean invisibility.
      suppressed: { total: suppressedTotal, byPattern: suppressed },
      toEmit: result.toEmit.map((c) => ({
        ...c,
        classification: classifyFault({ errorClass: c.errorClass, route: c.route }),
      })),
      regressions: result.regressions.map((c) => ({
        ...c,
        classification: classifyFault({ errorClass: c.errorClass, route: c.route }),
      })),
      // OPE-811 — ledger rows that are fileable and were never filed. The rail
      // files these exactly as it files `toEmit`; they are the same work,
      // arriving late. Before this they were folded into `existing`, which the
      // rail ignores by design, so 19 of them sat unrouted for up to 15 days.
      backlog: result.backlog.map((c) => ({
        ...c,
        classification: classifyFault({ errorClass: c.errorClass, route: c.route }),
      })),
      // OPE-811 scope 2 — assert on the POPULATION, not on this query's return.
      // A run that files nothing is only healthy if there was nothing to file,
      // and the pipeline could not tell those apart: the 2026-09-01 weekly run
      // reported SUCCEEDED with 19 unrouted candidates in the ledger.
      health: buildRailHealth(ledger, result),
      deferred: result.deferred,
      // OPE-488 — the discarded-but-real groups, so a consumer can tell "quiet
      // traffic" from "everything fell just under the gate". Capped: this is a
      // diagnostic tally, not a work queue.
      subThreshold: {
        total: result.subThreshold.length,
        top: [...result.subThreshold]
          .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
          .slice(0, 10),
      },
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
