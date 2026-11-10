/**
 * OPE-1601 — the grouped view of `error_logs` behind /admin/logs.
 *
 * Replaces the "Recent errors grouped" table that lived on /admin/diagnostics.
 * That table read 2,000 rows and truncated each message to 80 characters, so a
 * busy week was undercounted and "69 fileable signature(s)…" and "70 fileable
 * signature(s)…" were separate groups.
 *
 * The work is split in two on purpose. SQL collapses exact repeats, which leaves
 * a few hundred buckets however many rows the window holds, and JS merges the
 * buckets whose messages differ only in volatile tokens. Reading every row into
 * the Worker instead is how the fault-signature route ran out of memory
 * (OPE-1600).
 */
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { containsCI } from "@/lib/db/contains-ci";
import { errorLogs } from "@/lib/db/schema";
import { normalizeErrorClass } from "@/lib/faults/signature";

/** The stored message is compared on this prefix; long tails are query params. */
const MESSAGE_PREFIX_CHARS = 200;
/** Far above the ~700 distinct messages a real week holds; reported if reached. */
const BUCKET_CAP = 5_000;
/** How many groups one response returns. */
export const GROUP_RESPONSE_CAP = 200;

export type ErrorLogBucket = {
  source: string | null;
  level: string;
  message: string;
  count: number;
  firstSeenSec: number;
  lastSeenSec: number;
};

export type ErrorLogGroup = {
  source: string;
  level: string;
  /** The message of the group's largest bucket, as stored. */
  example: string;
  count: number;
  firstSeenSec: number;
  lastSeenSec: number;
  /** Text that finds this group's rows in the raw view; "" when none is usable. */
  searchHint: string;
};

/**
 * The longest digit-free run in the start of a message, which is what survives
 * from one occurrence to the next.
 */
export function logSearchHint(message: string): string {
  const runs = message.slice(0, 80).split(/[\d\n]+/);
  const longest = runs.reduce(
    (best, run) => (run.trim().length > best.length ? run.trim() : best),
    ""
  );
  return longest.length >= 8 ? longest : "";
}

/** Merge SQL's exact-message buckets on the normalized message. Pure. */
export function mergeLogBuckets(buckets: readonly ErrorLogBucket[]): ErrorLogGroup[] {
  const groups = new Map<string, ErrorLogGroup & { exampleCount: number }>();
  for (const bucket of buckets) {
    const source = bucket.source ?? "(unknown)";
    // normalizeErrorClass keeps bare counts, because the fault ledger keys on it.
    // A count is what changes between repeats of a warning, so it goes here.
    const normalized = normalizeErrorClass(bucket.message).replace(/\d+/g, "#");
    const key = `${bucket.level}\u0000${source}\u0000${normalized}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        source,
        level: bucket.level,
        example: bucket.message,
        exampleCount: bucket.count,
        count: bucket.count,
        firstSeenSec: bucket.firstSeenSec,
        lastSeenSec: bucket.lastSeenSec,
        searchHint: logSearchHint(bucket.message),
      });
      continue;
    }
    group.count += bucket.count;
    group.firstSeenSec = Math.min(group.firstSeenSec, bucket.firstSeenSec);
    group.lastSeenSec = Math.max(group.lastSeenSec, bucket.lastSeenSec);
    if (bucket.count > group.exampleCount) {
      group.example = bucket.message;
      group.exampleCount = bucket.count;
      group.searchHint = logSearchHint(bucket.message);
    }
  }
  return Array.from(groups.values(), ({ exampleCount: _exampleCount, ...group }) => group).sort(
    (a, b) => b.count - a.count || b.lastSeenSec - a.lastSeenSec
  );
}

export type LoadErrorLogGroupsOptions = {
  since: Date;
  /** An exact level. Omitted means errors and warnings, never info. */
  level?: string | null;
  source?: string | null;
  q?: string | null;
};

export type ErrorLogGroupsResult = {
  groups: ErrorLogGroup[];
  /** Before the response cap. */
  totalGroups: number;
  /** Every row the window matched, so the page can state what it examined. */
  totalRows: number;
  /** True when more distinct messages existed than were read. */
  truncated: boolean;
};

export async function loadErrorLogGroups(
  // Both the withAuth db and the diagnostics-typed db are passed here.
  db: DrizzleD1Database<Record<string, unknown>> | never,
  options: LoadErrorLogGroupsOptions
): Promise<ErrorLogGroupsResult> {
  const { since, level, source, q } = options;
  const conditions = [
    gte(errorLogs.timestamp, since),
    level ? eq(errorLogs.level, level) : ne(errorLogs.level, "info"),
  ];
  if (source) conditions.push(containsCI(errorLogs.source, source));
  if (q) conditions.push(containsCI(errorLogs.message, q));

  const rows = await (db as DrizzleD1Database<Record<string, unknown>>)
    .select({
      source: errorLogs.source,
      level: errorLogs.level,
      message:
        sql<string>`substr(${errorLogs.message}, 1, ${sql.raw(String(MESSAGE_PREFIX_CHARS))})`.as(
          "msg_prefix"
        ),
      count: sql<number>`count(*)`.as("bucket_count"),
      firstSeenSec: sql<number>`min(${errorLogs.timestamp})`.as("first_seen"),
      lastSeenSec: sql<number>`max(${errorLogs.timestamp})`.as("last_seen"),
    })
    .from(errorLogs)
    .where(and(...conditions))
    .groupBy(errorLogs.source, errorLogs.level, sql`msg_prefix`)
    .orderBy(desc(sql`bucket_count`))
    .limit(BUCKET_CAP);

  const merged = mergeLogBuckets(rows);
  return {
    groups: merged.slice(0, GROUP_RESPONSE_CAP),
    totalGroups: merged.length,
    totalRows: rows.reduce((sum, row) => sum + row.count, 0),
    truncated: rows.length === BUCKET_CAP,
  };
}
