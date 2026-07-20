/**
 * OPE-225 PR 2/2 — URL rot detection (scope §4's measured half).
 *
 * Fetches stored image URLs and marks the dead ones `UNREACHABLE`. This is the
 * only code that may produce that verdict; everything else derives health from
 * the URL string (see ./model.ts).
 *
 * ## Budget
 *
 * Cloudflare gives a Worker invocation ~30s of wall-clock for outbound loops
 * (and a 100s edge timeout on the request). A full sweep of every imaged
 * entity would blow through that, so this is a ROUND-ROBIN: each run checks the
 * `limit` least-recently-checked URLs, NULL (never checked) first. Coverage is
 * achieved over days, not in one run, which is also gentler on the third-party
 * hosts we hotlink from.
 *
 * ## Why HEAD, with a GET fallback
 *
 * HEAD is the cheap correct request for "does this still exist" — no body
 * transfer. But some CDNs and WordPress hosts return 403/405 for HEAD while
 * serving GET perfectly well, and marking a live image dead is worse than
 * missing a dead one: it would put a healthy entity into the sourcing queue and
 * erode trust in the flag. So a HEAD that fails with a method-ish status is
 * retried once as a ranged GET before any UNREACHABLE verdict is recorded.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { imageCoverageState } from "@/lib/db/schema";
import { classifyImageUrlHealth, type ImageUrlHealth } from "./model";

type Db = DrizzleD1Database<Record<string, unknown>>;

/** URLs checked per run. Round-robin, so full coverage accrues over days. */
export const ROT_SWEEP_LIMIT = 60;

/** Per-request timeout. A slow host is not a dead host, but we can't wait. */
export const ROT_FETCH_TIMEOUT_MS = 5_000;

/** How many requests are in flight at once. Kept low to stay polite. */
export const ROT_CONCURRENCY = 6;

/**
 * Statuses that mean "this server dislikes HEAD", not "this image is gone".
 * Each gets one ranged-GET retry before we call the URL dead.
 */
const HEAD_UNSUPPORTED = new Set([400, 403, 405, 501]);

export interface UrlProbeResult {
  ok: boolean;
  status: number | null;
}

/**
 * Probe a single URL. Never throws — a network error is a result, not an
 * exception, because one dead host must not abort the sweep.
 */
export async function probeImageUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = ROT_FETCH_TIMEOUT_MS
): Promise<UrlProbeResult> {
  const attempt = async (method: "HEAD" | "GET"): Promise<UrlProbeResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        // Ask for a single byte on the fallback so a large JPEG isn't pulled
        // just to learn the URL resolves.
        headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      });
      return { ok: res.ok || res.status === 206, status: res.status };
    } catch {
      // Timeout, DNS failure, TLS failure, connection refused.
      return { ok: false, status: null };
    } finally {
      clearTimeout(timer);
    }
  };

  const head = await attempt("HEAD");
  if (head.ok) return head;
  // A host that refuses HEAD is common; don't condemn a live image for it.
  if (head.status != null && HEAD_UNSUPPORTED.has(head.status)) return attempt("GET");
  return head;
}

/** Run `tasks` with bounded concurrency, preserving input order. */
async function pooled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface RotSweepResult {
  checked: number;
  reachable: number;
  unreachable: number;
  recovered: number;
}

/**
 * Check the least-recently-checked image URLs and record the verdicts.
 *
 * Recovery is deliberate and symmetric: a URL previously marked UNREACHABLE
 * that now answers is restored to its derived health. Without that, one
 * transient outage would brand an entity dead forever and quietly inflate the
 * imageless queue.
 */
export async function sweepImageUrlHealth(
  db: Db,
  opts: {
    now?: Date;
    limit?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
): Promise<RotSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? ROT_SWEEP_LIMIT;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Oldest-checked first, never-checked (NULL) ahead of those. `asc` puts NULL
  // first in SQLite, which is exactly the order we want.
  const due = await db
    .select({
      entityType: imageCoverageState.entityType,
      entityId: imageCoverageState.entityId,
      imageUrl: imageCoverageState.imageUrl,
      urlHealth: imageCoverageState.urlHealth,
    })
    .from(imageCoverageState)
    .where(eq(imageCoverageState.hasImage, true))
    .orderBy(asc(imageCoverageState.urlCheckedAt))
    .limit(limit);

  const targets = due.filter((r) => (r.imageUrl ?? "").trim() !== "");
  const result: RotSweepResult = { checked: 0, reachable: 0, unreachable: 0, recovered: 0 };
  if (targets.length === 0) return result;

  const probes = await pooled(targets, ROT_CONCURRENCY, (r) =>
    probeImageUrl(r.imageUrl as string, fetchImpl, opts.timeoutMs)
  );

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const probe = probes[i];
    const derived = classifyImageUrlHealth(row.imageUrl);
    const nextHealth: ImageUrlHealth = probe.ok ? derived : "UNREACHABLE";

    result.checked += 1;
    if (probe.ok) {
      result.reachable += 1;
      if (row.urlHealth === "UNREACHABLE") result.recovered += 1;
    } else {
      result.unreachable += 1;
    }

    await db
      .update(imageCoverageState)
      .set({
        urlHealth: nextHealth,
        urlCheckedAt: now,
        urlStatusCode: probe.status,
      })
      .where(
        and(
          eq(imageCoverageState.entityType, row.entityType),
          eq(imageCoverageState.entityId, row.entityId)
        )
      );
  }

  return result;
}
