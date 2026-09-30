/**
 * OPE-1105 — the only way a table NAME may reach raw SQL in this app.
 *
 * SQLite cannot bind an identifier as a parameter (`SELECT … FROM ?` is a
 * syntax error), so a table name has to be interpolated. That is safe exactly
 * as long as the name came from `sqlite_master` and nowhere else — true in the
 * two admin database routes today, and one `?table=` parameter away from an
 * injection. This makes the invariant a check instead of a coincidence:
 *
 *   - the name must be in the set `sqlite_master` returned, or it is refused;
 *   - it is emitted as a quoted identifier with embedded quotes doubled, so
 *     even an allow-listed name with a `"` in it cannot break out.
 */
export class UnknownTableError extends Error {
  constructor(public readonly tableName: string) {
    super(`Refusing unknown table name: ${JSON.stringify(tableName)}`);
    this.name = "UnknownTableError";
  }
}

export function quoteKnownTable(name: string, known: ReadonlySet<string>): string {
  if (!known.has(name)) throw new UnknownTableError(name);
  return `"${name.replace(/"/g, '""')}"`;
}
