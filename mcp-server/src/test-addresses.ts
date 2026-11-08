/**
 * OPE-1583 — addresses that are ours or synthetic, so a health check about real
 * people can leave them out. Shared: add a pattern here rather than teaching
 * one check about one address.
 *
 * `+` is a literal in SQL LIKE; only `%` and `_` are wildcards.
 */
import { sql, type SQL } from "drizzle-orm";

export const TEST_ADDRESS_LIKE_PATTERNS = [
  // The operator's plus-addresses (ope1145v, ope1107, …). His bare address is
  // deliberately NOT here: it is a real subscription and can really orphan.
  "jtarboxme+%@gmail.com",
  // RFC 2606 reserved domains cannot receive mail, so nobody real is on them.
  "%@example.com",
  "%@example.org",
  "%@example.net",
] as const;

/** SQL predicate: true when `email` is NOT a test address. Case-insensitive. */
export function isRealAddressSql(email: SQL): SQL {
  return sql.join(
    TEST_ADDRESS_LIKE_PATTERNS.map((p) => sql`lower(${email}) NOT LIKE ${p}`),
    sql` AND `
  );
}
