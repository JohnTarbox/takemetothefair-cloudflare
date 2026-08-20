/**
 * Case-insensitive substring match that cannot trip D1's LIKE-pattern cap.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `LOWER(col) LIKE '%needle%'` throws `D1_ERROR: LIKE or GLOB pattern too
 * complex: SQLITE_ERROR` once the PATTERN exceeds **50 characters**. Measured
 * on prod for OPE-404: 50 passes, 52 throws.
 *
 * That number is the whole problem, because local SQLite's cap is **50,000**.
 * Every test passes, and production fails on any search longer than ~48
 * characters. Two live endpoints carried the bug for weeks:
 *
 *   api/vendor/self-reported-events   280 errors  (no length cap at all)
 *   api/search  + app/search/page      13 errors  (cap set to 100)
 *
 * `/api/search` even documented the wrong limit at its cap —
 * *"SQLite's LIKE-pattern complexity counter (limit ~50k)"* — and set
 * `MAX_QUERY_LENGTH = 100` on that basis, i.e. twice what D1 actually allows.
 * The neighbouring SEARCH1 note blames the size of the searched COLUMN; the
 * column is irrelevant, it is the pattern that is measured.
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
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

export function containsCI(col: AnyColumn | SQL, needle: string): SQL {
  return sql`instr(lower(${col}), ${needle.toLowerCase()}) > 0`;
}
