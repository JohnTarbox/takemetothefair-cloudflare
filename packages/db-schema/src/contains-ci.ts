/**
 * Case-insensitive substring match that cannot trip D1's LIKE-pattern cap.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `LOWER(col) LIKE '%needle%'` throws `D1_ERROR: LIKE or GLOB pattern too
 * complex: SQLITE_ERROR` once the PATTERN exceeds **50 characters**. Measured
 * on prod for OPE-404 (50 passes, 52 throws) and re-measured on prod for
 * OPE-630 on 2026-08-30 against the live `events` table: a 48-char pattern
 * returns rows, a 52-char pattern throws.
 *
 * That number is the whole problem, because local SQLite's cap is **50,000**.
 * Every test passes, and production fails on any search longer than ~48
 * characters.
 *
 * `instr(lower(col), lower(needle)) > 0` is exactly equivalent for a plain
 * substring test and has **no pattern-length limit**. It also needs no
 * metacharacter escaping — `%` and `_` are literal to `instr`, so a search for
 * `100%_off` matches the text `100%_off` instead of behaving as wildcards.
 *
 * Neither form can use an index for a leading-wildcard match, so this is not a
 * performance change.
 *
 * Do NOT "restore" the LIKE form, and do not fix a recurrence by lowering a
 * character cap — that trades a 500 for silently empty results on any query
 * a user would reasonably type.
 *
 * ── Why it lives in this package (OPE-630) ───────────────────────────────
 *
 * It used to live only at `src/lib/db/contains-ci.ts`, i.e. inside the Next.js
 * app. The MCP Worker is a SEPARATE deploy artifact that cannot import from
 * `src/`, so the OPE-565 sweep converted every app call site and left all ten
 * MCP search sites on raw `LIKE`. `search_events` — the tool the discovery
 * dedup passes call — was still throwing on any query over 48 characters on
 * 2026-08-30, six weeks into a family we had "fixed" twice.
 *
 * Both artifacts already depend on this package, so this is the one place
 * neither of them can miss. `src/lib/db/contains-ci.ts` re-exports it; do not
 * fork a second copy into either build.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

export function containsCI(col: AnyColumn | SQL, needle: string): SQL {
  return sql`instr(lower(${col}), ${needle.toLowerCase()}) > 0`;
}
