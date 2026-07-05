/**
 * OPE-106 — server-side ingest burst dedup for POST /api/client-errors.
 *
 * ── Why a SECOND dedup layer ──────────────────────────────────────────────────
 * The client already dedups in `report-client-error.ts` (5s, in-memory), but that
 * layer structurally misses the storm this ticket is about:
 *   - its Map resets on every page reload, so an error in a reload loop starts a
 *     fresh deduper each load (one client → dozens of rows across reloads);
 *   - it keys on the RAW `errorType + message + stack`, so per-occurrence stack
 *     jitter (line/column, async frames) slips through as distinct keys.
 * Observed in prod 2026-07-05: 58 identical `unhandledrejection` rows in 5s from
 * ONE url. Those inflate `error_logs`, and thus the render-fault ledger's `count`.
 *
 * This layer dedups on `computeSignature(...)` — the EXACT normalized key the
 * reconcile later groups on (volatile tokens stripped) — keyed per client IP (the
 * best session proxy on an anon beacon) and persisted in KV across reloads for a
 * short window. Different users hitting the same fault use different keys, so
 * distinct-session signal is preserved; only a single client's storm is collapsed.
 * First sight of a (client, signature) is always recorded and written; only
 * repeats inside the window are suppressed.
 *
 * PURE key derivation + a thin KV gate; fail-open on any KV error so an infra blip
 * never silently swallows a real error report.
 */

/** A repeat of the same (client, signature) within this window is suppressed. */
export const CLIENT_ERROR_DEDUP_WINDOW_SEC = 60;

/** Minimal KV surface used here — Cloudflare's KVNamespace is compatible. */
export interface DedupKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * A short, KV-safe key: a stable 32-bit FNV-1a hash of `ip` + `signature`.
 * Hashing keeps the key bounded and free of any characters/length a raw signature
 * (an arbitrary error message + route) could carry. Deterministic — the same
 * (ip, signature) always maps to the same key.
 */
export function clientErrorDedupKey(ip: string, signature: string): string {
  let h = 0x811c9dc5;
  const s = `${ip} ${signature}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `cerr-dedup:${(h >>> 0).toString(16)}`;
}

/**
 * True when an identical (client, signature) error was already ingested within
 * the dedup window — the caller should DROP the occurrence (return 204, don't
 * write to error_logs). On first sight, records the key with a TTL and returns
 * false. Fail-open: a null binding or ANY KV error → returns false.
 */
export async function isDuplicateClientError(
  kv: DedupKv | null,
  ip: string,
  signature: string,
  windowSec: number = CLIENT_ERROR_DEDUP_WINDOW_SEC
): Promise<boolean> {
  if (!kv) return false;
  const key = clientErrorDedupKey(ip, signature);
  try {
    const seen = await kv.get(key);
    if (seen) return true;
    await kv.put(key, "1", { expirationTtl: windowSec });
    return false;
  } catch {
    // Fail open — never suppress a report because KV is unavailable.
    return false;
  }
}
