/**
 * OPE-1664 — a KV fallback for `error_logs` rows whose D1 insert failed.
 *
 * `logError` and `captureServerRenderError` write `error_logs` on the same D1
 * database whose overload they are usually reporting. During the 2026-11-13
 * 01:04Z burst, Workers Logs showed 25+ failed public renders while
 * `error_logs` kept 4, so every reader of that table (the OPE-84 triage scan, the
 * page-error canary, the fault-signature emitter) under-counted the overload.
 *
 * On a failed insert the fully built row goes to KV (`RATE_LIMIT_KV`, already
 * bound to the main app) instead of being dropped. The MCP Worker's `*\/10` cron
 * calls `/api/internal/error-log-buffer/replay`, which drains the buffer
 * into `error_logs` once D1 accepts writes again:
 *
 *   - the ORIGINAL `id` and `timestamp` are kept, and the insert is
 *     `ON CONFLICT(id) DO NOTHING`, so a drain that dies between the insert and
 *     the KV delete re-runs harmlessly instead of duplicating the row;
 *   - `context.replayedFromBuffer = true` (+ `bufferedAt`) marks the row, so a
 *     reader can tell a replayed row from a live one;
 *   - the drain stops at the first failed insert: D1 is still unwell, and the
 *     rest wait for the next run.
 *
 * Bounded (ask 3): at most BUFFER_CAP_PER_HOUR rows are buffered per UTC hour,
 * and every row expires after BUFFER_TTL_SECONDS. Beyond the cap a row is DROPPED,
 * counted in a per-hour KV counter, and the running count is logged. The cap is
 * enforced with a read-then-write counter. KV has no atomic increment and
 * rate-limits writes to one key (~1/s), so concurrent isolates and bursts can
 * overshoot it. It is a bound on growth, not an exact quota; the TTL is the
 * hard backstop.
 *
 * Nothing here throws. A logging fallback that can fail the request it is
 * logging would compound the failure it exists to record.
 */

export const BUFFER_ROW_PREFIX = "errlog-buf:row:";
/** The agent_heartbeats stamp the `error-log-buffer-replay` probe watches. */
export const REPLAY_HEARTBEAT_CODE = "watchdog:error-log-buffer-replay";
const COUNT_PREFIX = "errlog-buf:count:";
const DROP_PREFIX = "errlog-buf:drops:";

/** Rows buffered per UTC hour before new ones are dropped (counted). */
export const BUFFER_CAP_PER_HOUR = 500;
/** A buffered row waits at most this long for D1 to recover. */
export const BUFFER_TTL_SECONDS = 3 * 24 * 3600;
/** Hour counters outlive their hour so the drain can report recent drops. */
const COUNTER_TTL_SECONDS = 2 * 24 * 3600;
/** Rows replayed per drain call. KV list pages hold up to 1000 keys. */
export const REPLAY_BATCH = 200;

/** The minimal KV surface used here (a real `KVNamespace` satisfies it). */
export interface BufferKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
}

/**
 * An `error_logs` row as the writers build it. `timestamp` is a Date at the call
 * site and is serialised as epoch ms in KV.
 */
export interface ErrorLogRow {
  id: string;
  timestamp: Date;
  level: string;
  message: string;
  context: string | null;
  url?: string | null;
  method?: string | null;
  statusCode?: number | null;
  stackTrace?: string | null;
  userAgent?: string | null;
  source?: string | null;
  route?: string | null;
  digest?: string | null;
}

interface StoredRow extends Omit<ErrorLogRow, "timestamp"> {
  timestampMs: number;
  bufferedAtMs: number;
}

const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13); // 2026-11-17T21

/** Keys sort by original time, so a partial drain replays oldest first. */
function rowKey(row: ErrorLogRow): string {
  return `${BUFFER_ROW_PREFIX}${String(row.timestamp.getTime()).padStart(15, "0")}:${row.id}`;
}

export type BufferOutcome = "buffered" | "dropped" | "no-kv" | "kv-failed" | "read-only";

/**
 * Put a row whose D1 insert failed into the KV buffer. Never throws.
 *
 * `kv` may be a resolver (e.g. `getCloudflareRateLimitKv`) so that resolving
 * the binding happens inside the never-throw guard too.
 */
export async function bufferFailedErrorLog(
  kvOrResolver: BufferKv | null | (() => BufferKv | null),
  row: ErrorLogRow,
  now: number = Date.now()
): Promise<BufferOutcome> {
  let kv: BufferKv | null;
  try {
    kv = typeof kvOrResolver === "function" ? kvOrResolver() : kvOrResolver;
  } catch (e) {
    console.error("[error-log-buffer] could not resolve the KV binding:", e);
    return "no-kv";
  }
  if (!kv) return "no-kv";
  try {
    const hour = hourKey(now);
    const count = Number((await kv.get(COUNT_PREFIX + hour)) ?? 0);
    if (count >= BUFFER_CAP_PER_HOUR) {
      const drops = Number((await kv.get(DROP_PREFIX + hour)) ?? 0) + 1;
      await kv.put(DROP_PREFIX + hour, String(drops), { expirationTtl: COUNTER_TTL_SECONDS });
      console.error(
        `[error-log-buffer] buffer full for ${hour}Z (cap ${BUFFER_CAP_PER_HOUR}/h): dropped ${drops} row(s) this hour`
      );
      return "dropped";
    }
    const { timestamp, ...rest } = row;
    const stored: StoredRow = { ...rest, timestampMs: timestamp.getTime(), bufferedAtMs: now };
    await kv.put(rowKey(row), JSON.stringify(stored), { expirationTtl: BUFFER_TTL_SECONDS });
    // The row is safe; the counter is best-effort. KV allows ~1 write/s to ONE
    // key, so in a burst (25+ failures in a second on 11-13) most counter writes
    // are rate-limited. That loosens the cap during the burst; it must not
    // report a buffered row as failed.
    try {
      await kv.put(COUNT_PREFIX + hour, String(count + 1), { expirationTtl: COUNTER_TTL_SECONDS });
    } catch (e) {
      console.error("[error-log-buffer] hour counter write failed (row kept):", e);
    }
    return "buffered";
  } catch (e) {
    console.error("[error-log-buffer] could not buffer a failed error_logs row:", e);
    return "kv-failed";
  }
}

/** Add the replay marker to a row's JSON `context`, keeping what was there. */
export function markReplayed(context: string | null, bufferedAtMs: number): string {
  let parsed: unknown = {};
  try {
    parsed = context ? JSON.parse(context) : {};
  } catch {
    parsed = { originalContext: context };
  }
  const base =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { originalContext: parsed };
  return JSON.stringify({
    ...base,
    replayedFromBuffer: true,
    bufferedAt: new Date(bufferedAtMs).toISOString(),
  });
}

export interface ReplayResult {
  /** Rows inserted into error_logs this call. */
  replayed: number;
  /** Rows already present (a previous drain inserted them, then died before the delete). */
  alreadyPresent: number;
  /** Unparseable buffer entries, deleted. */
  discarded: number;
  /** True when an insert failed and the drain stopped with rows left. */
  stoppedOnError: boolean;
  /** Keys from this call's page still in the buffer (left by a stop). */
  remaining: number;
  /** True when the buffer held more than one page: the next run continues. */
  more: boolean;
  /** Dropped-row counts for the current and previous UTC hour. */
  recentDrops: Record<string, number>;
}

/**
 * Drain up to `limit` buffered rows into error_logs. `insert` writes ONE row and
 * resolves true when it inserted, false when the id already existed (ON CONFLICT
 * DO NOTHING). It rejects when D1 refused the write, which stops the drain.
 */
export async function replayBufferedErrorLogs(
  kv: BufferKv,
  insert: (row: ErrorLogRow) => Promise<boolean>,
  opts: { limit?: number; now?: number } = {}
): Promise<ReplayResult> {
  const limit = opts.limit ?? REPLAY_BATCH;
  const now = opts.now ?? Date.now();
  const result: ReplayResult = {
    replayed: 0,
    alreadyPresent: 0,
    discarded: 0,
    stoppedOnError: false,
    remaining: 0,
    more: false,
    recentDrops: {},
  };

  const page = await kv.list({ prefix: BUFFER_ROW_PREFIX, limit });
  const keys = page.keys.map((k) => k.name);
  let done = 0;
  for (const key of keys) {
    const raw = await kv.get(key);
    if (raw == null) {
      done++; // expired or deleted between list and get
      continue;
    }
    let stored: StoredRow;
    try {
      stored = JSON.parse(raw) as StoredRow;
      if (typeof stored.id !== "string" || typeof stored.timestampMs !== "number") {
        throw new Error("missing id/timestampMs");
      }
    } catch {
      await kv.delete(key);
      result.discarded++;
      done++;
      continue;
    }
    const { timestampMs, bufferedAtMs, ...rest } = stored;
    const row: ErrorLogRow = {
      ...rest,
      timestamp: new Date(timestampMs),
      context: markReplayed(stored.context ?? null, bufferedAtMs ?? now),
    };
    try {
      const inserted = await insert(row);
      if (inserted) result.replayed++;
      else result.alreadyPresent++;
    } catch (e) {
      console.error("[error-log-buffer] replay insert failed; stopping this drain:", e);
      result.stoppedOnError = true;
      break;
    }
    await kv.delete(key);
    done++;
  }
  result.remaining = keys.length - done;
  result.more = !page.list_complete;

  for (const h of [now, now - 3600_000]) {
    const hour = hourKey(h);
    const n = Number((await kv.get(DROP_PREFIX + hour)) ?? 0);
    if (n > 0) result.recentDrops[hour] = n;
  }
  return result;
}
