/**
 * OPE-1600 — reads the emitter's error_logs window a page at a time.
 *
 * One 5,000-row read held about 9 MB of message and stack text as a single D1
 * response and killed the 128 MB isolate (`exceededMemory`, a 503 with no
 * body) on 4 of the 16 hourly runs of 2026-11-09. Each page can be released
 * before the next one loads.
 */
import { and, desc, eq, gte, lt, notInArray, or, sql } from "drizzle-orm";
import { errorLogs } from "@/lib/db/schema";
import type { Database } from "@/lib/db";

export const MAX_SCAN_ROWS = 5000;
const SCAN_PAGE_ROWS = 500;
/** The noise check only reads the first stack frame. */
const STACK_PREFIX_CHARS = 2000;

export interface ScanRow {
  id: string;
  message: string;
  route: string | null;
  source: string | null;
  digest: string | null;
  url: string | null;
  context: string | null;
  stackTrace: string | null;
  userAgent: string | null;
  timestamp: Date;
}

/** Newest first. Stable across pages even when many rows share a second. */
export async function* scanErrorLogPages(
  db: Database,
  since: Date,
  excludedSources: string[],
  maxRows: number = MAX_SCAN_ROWS
): AsyncGenerator<ScanRow[]> {
  let scanned = 0;
  let cursor: { timestamp: Date; id: string } | null = null;
  while (scanned < maxRows) {
    const limit = Math.min(SCAN_PAGE_ROWS, maxRows - scanned);
    const page: ScanRow[] = await db
      .select({
        id: errorLogs.id,
        message: errorLogs.message,
        route: errorLogs.route,
        source: errorLogs.source,
        digest: errorLogs.digest,
        url: errorLogs.url,
        context: errorLogs.context,
        // OPE-577 — needed for extension-injection stack-shape detection.
        stackTrace: sql<string | null>`substr(${errorLogs.stackTrace}, 1, ${STACK_PREFIX_CHARS})`,
        // OPE-1174 — the DuckDuckGo condition on a stackless shape.
        userAgent: errorLogs.userAgent,
        timestamp: errorLogs.timestamp,
      })
      .from(errorLogs)
      .where(
        and(
          gte(errorLogs.timestamp, since),
          eq(errorLogs.level, "error"),
          notInArray(errorLogs.source, excludedSources),
          cursor
            ? or(
                lt(errorLogs.timestamp, cursor.timestamp),
                and(eq(errorLogs.timestamp, cursor.timestamp), lt(errorLogs.id, cursor.id))
              )
            : undefined
        )
      )
      .orderBy(desc(errorLogs.timestamp), desc(errorLogs.id))
      .limit(limit);
    if (page.length > 0) yield page;
    scanned += page.length;
    if (page.length < limit) return;
    const last = page[page.length - 1];
    cursor = { timestamp: last.timestamp, id: last.id };
  }
}
