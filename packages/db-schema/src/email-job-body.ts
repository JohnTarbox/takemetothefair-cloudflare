/**
 * OPE-1719 — keep an `email-jobs` Queues message under Cloudflare's 128 KB
 * per-message limit by spilling a large body to D1 ("claim check").
 *
 * The failure this exists for: the Nov 27 weekend newsletter (88,126 chars of
 * stored HTML) became one Queues message per recipient carrying the rendered
 * `html` AND `text`. `EMAIL_JOBS.send()` refused it — "message length of
 * 136334 bytes exceeds limit of 128000 bytes (10204)" — and the issue never
 * went out. The same 10204 had already refused the cpi:stale-red digest
 * (249,939 and 327,577 bytes, 11-08 / 11-11).
 *
 * The rule: a producer hands its message to `spillEmailJobBody()` before
 * `send()`. Under the threshold the message is returned UNCHANGED (the common
 * case — no D1 write). Over it, `html`/`text` are written to
 * `email_job_bodies` and the message carries `bodyRef` and empty bodies. The
 * consumer calls `resolveEmailJobBody()` before it sends or ledgers, then
 * `deleteEmailJobBody()` once the ledger row (which keeps its own copy of the
 * body) is written. `pruneEmailJobBodies()` reaps anything a crash left behind.
 *
 * Why D1 and not R2/KV: every key in the `mmatf-vendor-assets` bucket is
 * publicly readable on the CDN, so an email body there is a disclosure; KV is
 * eventually consistent across colos, so the consumer could read a miss. D1
 * reads go to the primary.
 *
 * Shared by both deploy artifacts (main app `enqueueEmail`, the MCP Worker's
 * enqueue-email proxy and its consumer) so there is one size rule, not two.
 */
import { eq, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";
import { emailJobBodies } from "./index";

type Db = DrizzleD1Database<typeof schema>;

/** Cloudflare Queues' hard per-message limit (error 10204). */
export const QUEUE_MESSAGE_LIMIT_BYTES = 128_000;

/**
 * Spill above this estimate. Deliberately well under the limit: the estimate
 * below is an upper bound on the string payload, but the serialized envelope
 * (keys, structure, V8 header) is not modelled exactly, so the headroom is the
 * safety margin rather than a tuning knob.
 */
export const EMAIL_JOB_INLINE_LIMIT_BYTES = 100_000;

export type SpillableEmailJob = {
  html?: string;
  text?: string;
  /** Set by spillEmailJobBody when the body lives in `email_job_bodies`. */
  bodyRef?: string;
};

export class EmailJobTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `email job is ${bytes} bytes even with its body spilled to D1 ` +
        `(limit ${QUEUE_MESSAGE_LIMIT_BYTES}); refusing to enqueue`
    );
    this.name = "EmailJobTooLargeError";
  }
}

export class EmailJobBodyMissingError extends Error {
  constructor(public readonly bodyRef: string) {
    super(`email job body ${bodyRef} not found in email_job_bodies`);
    this.name = "EmailJobBodyMissingError";
  }
}

function stringCost(s: string): number {
  // V8's serializer writes a string as one byte per char only when every char
  // is Latin-1; a single wider char makes the whole string two bytes per char.
  // Queues serializes with V8 by default, so this — not UTF-8 length, not
  // JSON length — is what the 128 KB limit measures.
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return s.length * 2;
  }
  return s.length;
}

/**
 * Upper-bound estimate of the serialized size of a queue message: every string
 * at its V8 width, every key, plus a small fixed allowance per field.
 */
export function estimateQueueMessageBytes(value: unknown): number {
  if (value == null) return 2;
  // Per string: a tag byte, a varint length (≤5 bytes) and, for a two-byte
  // string, an alignment pad — 16 covers all three with room. (Checked against
  // `v8.serialize` in route-queue-size-ope1719.test.ts; 5 undercounted.)
  if (typeof value === "string") return stringCost(value) + 16;
  if (typeof value === "number" || typeof value === "boolean") return 9;
  if (Array.isArray(value)) {
    return value.reduce<number>((n, v) => n + estimateQueueMessageBytes(v), 16);
  }
  if (typeof value === "object") {
    let n = 16;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      n += stringCost(k) + 16 + estimateQueueMessageBytes(v);
    }
    return n;
  }
  return 16;
}

/**
 * Return `msg` unchanged when it fits; otherwise store its body in D1 and
 * return a copy that references it. Throws `EmailJobTooLargeError` when even
 * the body-less message is too big (a giant recipient list or subject) — a
 * loud refusal, never a truncated send.
 */
export async function spillEmailJobBody<T extends SpillableEmailJob>(
  db: Db,
  msg: T,
  opts: { now?: Date; limitBytes?: number } = {}
): Promise<T> {
  const limit = opts.limitBytes ?? EMAIL_JOB_INLINE_LIMIT_BYTES;
  if (estimateQueueMessageBytes(msg) <= limit) return msg;

  const id = crypto.randomUUID();
  const spilled: T = { ...msg, html: "", text: "", bodyRef: id };
  const residual = estimateQueueMessageBytes(spilled);
  if (residual > limit) throw new EmailJobTooLargeError(residual);

  await db.insert(emailJobBodies).values({
    id,
    html: msg.html ?? "",
    text: msg.text ?? "",
    createdAt: opts.now ?? new Date(),
  });
  return spilled;
}

/**
 * Consumer side: return the message with its real body. A message without
 * `bodyRef` is returned as-is. Throws `EmailJobBodyMissingError` if the row is
 * gone — the caller must retry/DLQ it, never send an empty email.
 */
export async function resolveEmailJobBody<T extends SpillableEmailJob>(db: Db, msg: T): Promise<T> {
  if (!msg.bodyRef) return msg;
  const [row] = await db
    .select({ html: emailJobBodies.html, text: emailJobBodies.text })
    .from(emailJobBodies)
    .where(eq(emailJobBodies.id, msg.bodyRef))
    .limit(1);
  if (!row) throw new EmailJobBodyMissingError(msg.bodyRef);
  return { ...msg, html: row.html, text: row.text };
}

/** Drop a spilled body once its ledger row exists. Best-effort for callers. */
export async function deleteEmailJobBody(db: Db, bodyRef: string): Promise<void> {
  await db.delete(emailJobBodies).where(eq(emailJobBodies.id, bodyRef));
}

/**
 * Reap bodies older than `ttlMs`. Longer than a message can live in the queue
 * (retries + backoff), so a row still in flight is never pruned from under it.
 */
export async function pruneEmailJobBodies(db: Db, ttlMs: number, now: number): Promise<void> {
  await db.delete(emailJobBodies).where(lt(emailJobBodies.createdAt, new Date(now - ttlMs)));
}
