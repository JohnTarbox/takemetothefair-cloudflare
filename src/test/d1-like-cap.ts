/**
 * OPE-1376 — make a better-sqlite3 test db reject LIKE patterns the way D1 does.
 *
 * D1 throws `LIKE or GLOB pattern too complex` once a pattern passes 50
 * characters (measured on prod: 48 passes, 52 throws — see
 * packages/db-schema/src/contains-ci.ts). Local SQLite's cap is 50,000, so a
 * behavioural test of a `like(col, \`%${longInput}%\`)` site passes locally and
 * fails in production. Overriding SQLite's `like()` function brings the
 * production ceiling into the test: `X LIKE Y` is evaluated as `like(Y, X)`,
 * so the PATTERN is the first argument.
 *
 * The replacement keeps SQLite's semantics for what tests use: `%`, `_`,
 * ASCII-case-insensitive, optional ESCAPE char.
 */
import type Database from "better-sqlite3";

export const D1_LIKE_PATTERN_MAX = 50;

function likeToRegExp(pattern: string, escape: string | null): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (escape && c === escape && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export function emulateD1LikeCap(raw: Database.Database): void {
  raw.function(
    "like",
    { deterministic: true, varargs: true },
    (pattern: unknown, value: unknown, escape?: unknown) => {
      if (pattern == null || value == null) return null;
      const p = String(pattern);
      if (p.length > D1_LIKE_PATTERN_MAX) {
        throw new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR");
      }
      return likeToRegExp(p, escape == null ? null : String(escape)).test(String(value)) ? 1 : 0;
    }
  );
}
