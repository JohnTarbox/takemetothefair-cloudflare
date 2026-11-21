export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { faultSignatures, type FaultSignatureRow } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { reconcileFaults, type FaultLedgerRow, type FaultStatus } from "@/lib/faults/reconcile";
import { buildRailHealth } from "@/lib/faults/status";
import { classifyFault } from "@/lib/faults/family-registry";
import { scanErrorLogPages } from "@/lib/faults/scan-error-logs";
import { createFaultRowGrouper } from "@/lib/faults/group-rows";
import {
  groupPlatformIncidents,
  isPlatformSignature,
  reconcilePlatformIncidents,
} from "@/lib/faults/platform-incidents";

/**
 * POST /api/internal/faults/candidates  (OPE-81 — render-fault rail)
 *
 * The read+group+reconcile half of the detect→group→dedup→emit rail. Reads
 * `error_logs` within a window (default last 7 days, capped at the newest 5000
 * rows, read in pages), DROPS un-actionable noise (isNoise), GROUPS the remainder by
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
/**
 * OPE-93: this is the RENDER-fault pipeline — only user-facing render errors
 * belong here. `server-render` = the onRequestError capture (OPE-80); `client` =
 * the React error-boundary reports (OPE-25). Without this filter the emitter
 * grouped EVERY error_logs row (API errors, cron logs, IndexNow failures, the
 * heartbeat below), so it would have filed "render-fault" OPEs for arbitrary
 * backend errors — and re-ingested its own heartbeat. Scope it to render sources.
 */
// OPE-1161 A2 — defined once in @/lib/faults/render-sources, shared with the dashboard.

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
    // The per-row step (noise → platform cause → signature) lives in
    // src/lib/faults/group-rows.ts so tests exercise this exact code.
    const grouper = createFaultRowGrouper(now.getTime());
    let scanned = 0;
    for await (const page of scanErrorLogPages(db, since, NEVER_INGEST_SOURCES)) {
      scanned += page.length;
      for (const r of page) grouper.add(r);
    }
    const { total: suppressedTotal, byPattern: suppressed } = grouper.suppressed();
    const grouped = grouper.grouped();
    // OPE-1665 — D1 platform-cause rows, collapsed into one incident per burst.
    const platformIncidents = groupPlatformIncidents(grouper.platformHits());

    const ledgerRows = await db
      .select({
        signature: faultSignatures.signature,
        route: faultSignatures.route,
        errorClass: faultSignatures.errorClass,
        firstSeen: faultSignatures.firstSeen,
        lastSeen: faultSignatures.lastSeen,
        count: faultSignatures.count,
        status: faultSignatures.status,
        opeId: faultSignatures.opeId,
        filedAt: faultSignatures.filedAt,
        resolvedAt: faultSignatures.resolvedAt,
        createdAt: faultSignatures.createdAt,
        incidentRoutes: faultSignatures.incidentRoutes,
        incidentSources: faultSignatures.incidentSources,
      })
      .from(faultSignatures);
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
    const platformOps = reconcilePlatformIncidents(
      platformIncidents,
      ledgerRows
        .filter((r) => isPlatformSignature(r.signature))
        .map((r) => ({
          signature: r.signature,
          firstSeen: r.firstSeen.getTime(),
          lastSeen: r.lastSeen.getTime(),
          count: r.count,
          incidentRoutes: r.incidentRoutes,
          incidentSources: r.incidentSources,
        }))
    );

    // Apply the ledger mutations. Sequential + defensive: a single row failure
    // must not abort the scan or drop the response.
    //
    // OPE-1081 scope 2 — but it must not be SILENT either. A dropped `touch`
    // understates `count` and freezes `last_seen`, the two fields every
    // threshold reads, and this used to log it at `warn` and report a clean
    // scan (specimen 2026-09-18 21:01Z, `D1_ERROR: Network connection lost.`).
    // Now: one retry (the observed cause is transient), then `error`, and the
    // run answers non-2xx so the cron caller records a failure.
    let ledgerWriteFailures = 0;
    const applyUpsert = async (up: (typeof result.upserts)[number]) => {
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
      } else if (up.op === "link") {
        // OPE-613 — attach to the sibling route's live ticket. `filed` is the
        // code's own status for "carries an ope_id"; the agent-written `open`
        // on the sibling is not copied, because the agent did not rule on
        // this row.
        await db
          .insert(faultSignatures)
          .values({
            signature: up.signature,
            route: up.route,
            errorClass: up.errorClass,
            firstSeen: new Date(up.firstSeen),
            lastSeen: new Date(up.lastSeen),
            count: up.count,
            status: "filed",
            opeId: up.opeId,
            filedAt: now,
            resolvedAt: null,
            createdAt: new Date(up.createdAt),
          })
          .onConflictDoUpdate({
            target: faultSignatures.signature,
            set: { status: "filed", opeId: up.opeId, filedAt: now },
          });
      } else if (up.op === "noise") {
        // OPE-1174 — inherited ruling. On a racing insert, keep whatever the
        // row already says: a person's ruling outranks an inherited one.
        await db
          .insert(faultSignatures)
          .values({
            signature: up.signature,
            route: up.route,
            errorClass: up.errorClass,
            firstSeen: new Date(up.firstSeen),
            lastSeen: new Date(up.lastSeen),
            count: up.count,
            // The Drizzle enum names only the code's four statuses; `noise` is
            // one of the agent statuses OPE-811 kept (src/lib/faults/status.ts).
            status: "noise" as FaultSignatureRow["status"],
            opeId: null,
            filedAt: null,
            resolvedAt: null,
            createdAt: new Date(up.createdAt),
            inheritedFrom: "class",
          })
          .onConflictDoUpdate({
            target: faultSignatures.signature,
            set: { lastSeen: new Date(up.lastSeen), count: up.count },
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
    };
    for (const up of result.upserts) {
      try {
        await applyUpsert(up);
      } catch {
        try {
          await applyUpsert(up);
        } catch (err) {
          ledgerWriteFailures += 1;
          // `faults:candidates` is in NEVER_INGEST_SOURCES, so logging this at
          // `error` cannot make the emitter file a fault about itself.
          await logError(db, {
            level: "error",
            source: "faults:candidates",
            message: "ledger upsert failed after one retry; this scan is NOT a success",
            error: err,
            context: { op: up.op, signature: up.signature },
          });
        }
      }
    }

    // OPE-1665 — platform incident rows. Minted `watch` (ruled and collapsed,
    // never filed per signature); a merge widens span/counts and never touches
    // status, ope_id or resolved_at, so a person's later ruling stands.
    for (const op of platformOps) {
      const write = () =>
        op.op === "insert"
          ? db
              .insert(faultSignatures)
              .values({
                signature: op.signature,
                route: null,
                errorClass: op.errorClass,
                firstSeen: new Date(op.firstSeen),
                lastSeen: new Date(op.lastSeen),
                count: op.count,
                // `watch` is an agent status OPE-811 kept (src/lib/faults/status.ts).
                status: "watch" as FaultSignatureRow["status"],
                opeId: null,
                filedAt: null,
                resolvedAt: null,
                createdAt: now,
                incidentRoutes: op.routes,
                incidentSources: op.sources,
                // Machine-ruled, not ruled by a person (drizzle/0426).
                inheritedFrom: "platform",
              })
              .onConflictDoUpdate({
                target: faultSignatures.signature,
                set: {
                  lastSeen: new Date(op.lastSeen),
                  count: op.count,
                  incidentRoutes: op.routes,
                  incidentSources: op.sources,
                },
              })
          : db
              .update(faultSignatures)
              .set({
                firstSeen: new Date(op.firstSeen),
                lastSeen: new Date(op.lastSeen),
                count: op.count,
                incidentRoutes: op.routes,
                incidentSources: op.sources,
              })
              .where(eq(faultSignatures.signature, op.signature));
      try {
        await write();
      } catch {
        try {
          await write();
        } catch (err) {
          ledgerWriteFailures += 1;
          await logError(db, {
            level: "error",
            source: "faults:candidates",
            message: "platform incident write failed after one retry; this scan is NOT a success",
            error: err,
            context: { op: op.op, signature: op.signature },
          });
        }
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
        `fault emit: scanned ${scanned} render rows → ${grouped.length} signatures ` +
        `(noise-suppressed ${suppressedTotal}); toEmit=${result.toEmit.length} ` +
        `regressions=${result.regressions.length} existing=${result.existing.length} ` +
        `deferred=${result.deferred.length} subThreshold=${result.subThreshold.length} ` +
        `linked=${result.linked.length} heldForSibling=${result.heldForSibling.length} ` +
        `inheritedNoise=${result.inheritedNoise.length} ` +
        `platformIncidents=${platformIncidents.length} ` +
        `ledgerWriteFailures=${ledgerWriteFailures}`,
      context: {
        ledgerWriteFailures,
        scanned,
        signatures: grouped.length,
        suppressed: suppressedTotal,
        toEmit: result.toEmit.length,
        regressions: result.regressions.length,
        existing: result.existing.length,
        deferred: result.deferred.length,
        subThreshold: result.subThreshold.length,
        linked: result.linked.length,
        heldForSibling: result.heldForSibling.length,
        inheritedNoise: result.inheritedNoise.length,
        platformIncidents: platformIncidents.length,
        platformHits: grouper.platformHits().length,
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

    // OPE-1554 — the population assertion, computed once and made AUDIBLE. It
    // used to ride only in the JSON body, which the hourly cron caller never
    // read (its log line printed toEmit/regressions/existing), so an unhealthy
    // rail was indistinguishable from a healthy one everywhere a human looks.
    // One `warn` row per unhealthy run: `warn`, not `error`, because this scan
    // reads only level='error' and an error row would mint a fault signature
    // ABOUT the fault ledger inside the fault ledger.
    const health = buildRailHealth(ledger, result, { nowMs: now.getTime() });
    if (!health.healthy) {
      await logError(db, {
        level: "warn",
        source: "faults:rail-health",
        message: health.reason,
        context: {
          unfiledCandidates: health.unfiledCandidates,
          staleUnfiled: health.staleUnfiled,
          oldestUnfiledDays: health.oldestUnfiledDays,
          emittingNow: health.emittingNow,
          parked: health.parked,
        },
      });
    }

    return NextResponse.json(
      {
        // OPE-1081 scope 2 — a scan that could not write its own ledger is not a
        // success. Non-2xx (below) is what the MCP cron caller actually reads;
        // the buckets are still returned whole, because the scan itself ran.
        ok: ledgerWriteFailures === 0,
        ledgerWriteFailures,
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
        health,
        deferred: result.deferred,
        // OPE-613 — attached to a sibling route's ticket, and held behind a
        // sibling being filed this run. Neither is work for the rail.
        linked: result.linked,
        heldForSibling: result.heldForSibling,
        // OPE-1174 — minted as `noise` by class inheritance, never proposed.
        inheritedNoise: result.inheritedNoise,
        // OPE-1665 — one row per D1 platform burst, minted `watch`. Not work for
        // the rail; reported so a human sees each incident once.
        platformIncidents,
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
      },
      { status: ledgerWriteFailures > 0 ? 500 : 200 }
    );
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
