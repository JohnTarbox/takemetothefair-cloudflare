/**
 * The emitter's per-row step — noise suppression, D1 platform-cause collapsing
 * (OPE-1665) and signature grouping — moved out of
 * `src/app/api/internal/faults/candidates/route.ts` so tests run the code the
 * route runs instead of a copy of it. The comments on each decision are the
 * route's own, carried over with the code.
 *
 * PURE: no db, no I/O.
 */
import {
  classifyNoise,
  computeSignature,
  normalizeErrorClass,
  normalizeFaultRoute,
} from "./signature";
import type { GroupedFault } from "./reconcile";
import { RENDER_FAULT_SOURCES } from "./render-sources";
import { platformCause, type PlatformHit } from "./platform-incidents";
import type { ScanRow } from "./scan-error-logs";

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
export function sessionKeyFor(contextJson: string | null, url: string | null): string | null {
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

export type FaultRowInput = Pick<
  ScanRow,
  "message" | "route" | "source" | "digest" | "url" | "context" | "stackTrace" | "userAgent"
> & { timestamp: Date | null };

export function createFaultRowGrouper(nowMs: number) {
  const groups = new Map<string, Accum>();
  const suppressed: Record<string, number> = {};
  let suppressedTotal = 0;
  const platformHits: PlatformHit[] = [];

  function add(r: FaultRowInput): void {
    // OPE-577 — classify on PROVENANCE (where the code came from) as well as
    // message text. `context.thirdParty` is set by the client reporter and
    // the stack shape identifies extension injection; neither can be defeated
    // by a third party changing its wording.
    const verdict = classifyNoise({
      message: r.message,
      route: r.route,
      context: r.context,
      stackTrace: r.stackTrace,
      userAgent: r.userAgent,
    });
    if (verdict.noise) {
      const key = `${verdict.reason}:${verdict.matched}`;
      suppressed[key] = (suppressed[key] ?? 0) + 1;
      suppressedTotal += 1;
      return;
    }
    // OPE-615 — server rows key on `source`, not on `route`.
    //
    // `computeSignature` falls back to the literal "unknown" when route is
    // null, and route IS null on every server row — so widening the scan
    // without this would collapse every backend fault in the system into one
    // signature per error class. `source` is a stable, high-quality grouping
    // key and is strictly better than the route key the render lane uses.
    const isRenderLane = RENDER_FAULT_SOURCES.includes(r.source ?? "");
    // OPE-1081 — normalized HERE as well as inside computeSignature, because
    // this value is also what the ledger stores as `route`: a key built from
    // the path beside a `route` column still holding the attacker's payload
    // would keep echoing it into tickets and dashboards.
    const groupKey = normalizeFaultRoute(isRenderLane ? r.route : (r.source ?? r.route));
    const tsMs = r.timestamp ? r.timestamp.getTime() : nowMs;

    // OPE-1665 — a D1 platform cause is keyed on the CAUSE, never on the
    // statement or the route: collected here and collapsed into one incident
    // row per burst by `groupPlatformIncidents`. The raw row stays in error_logs.
    const cause = platformCause(r.message);
    if (cause) {
      // `route` only for render-lane rows: a server row's group key is its
      // source, which is already counted under `sources`.
      platformHits.push({ cause, tsMs, route: isRenderLane ? groupKey : null, source: r.source });
      return;
    }

    const signature = computeSignature({
      route: groupKey,
      message: r.message,
      digest: r.digest,
    });
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

  function grouped(): GroupedFault[] {
    return Array.from(groups.entries()).map(([signature, a]) => ({
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
  }

  return {
    add,
    grouped,
    platformHits: () => platformHits,
    suppressed: () => ({ total: suppressedTotal, byPattern: suppressed }),
  };
}
