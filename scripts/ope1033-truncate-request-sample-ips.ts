/**
 * OPE-1033 — ONE-OFF. Shorten the full visitor IPs left in `request_samples`
 * by rows written before OPE-971 (2026-09-13 20:23Z) to the same /24 and /48
 * prefixes new writes store. `ip` column only; no row is deleted.
 *
 * STATUS: NOT YET RUN AGAINST PRODUCTION. Update this line with the run date
 * and totals once it has been.
 *
 * Dry run green 2026-09-15 (48-row CASE path): 1,067 seeded full addresses
 * detected before, 0 after, 1,200 rows in and 1,200 out, maxParams 98, second
 * pass a no-op. Production census the same day, 23:35Z: 109,203 rows total,
 * 6,968 already prefixed, 102,235 still full, 0 NULL — of which 62,979 v4,
 * 29,453 full v6, 9,803 compressed v6 and ZERO v4-mapped or unparseable, so
 * the expected NULL count from this run is 0.
 *
 * The prefix comes from the live `truncateIp`, imported rather than
 * re-implemented in SQL, so old and new rows are byte-identical. A value it
 * cannot parse is set to NULL (never kept) and counted separately.
 *
 * Statement shape: each write is a single
 * `UPDATE … SET ip = CASE id WHEN ? THEN ? … ELSE ip END
 *  WHERE id BETWEEN ? AND ? AND ip NOT LIKE '%/%'`
 * carrying 48 rows — 96 id/prefix params plus the 2 range bounds = 98, under
 * D1's 100-bind-parameter cap.
 *
 * Why CASE and not one statement per prefix (the ticket offers both): prod holds
 * 37,495 distinct IPs across 102,235 rows, ~2.7 rows per IP, so prefixes barely
 * repeat inside a batch. Per-prefix writes cost ~400 REST calls per 500-row
 * batch — ~80,000 sequential round-trips overall. CASE is ~2,130 statements.
 *
 * The `BETWEEN` bound is safe despite `id` being a random UUID: rows written
 * after OPE-971 always carry a prefix, so `NOT LIKE '%/%'` excludes anything
 * that lands mid-range while the loop runs. That clause also makes a re-run a
 * no-op.
 *
 * Usage:
 *   npx tsx scripts/ope1033-truncate-request-sample-ips.ts --dry-run
 *     Seeds an in-memory SQLite copy with real-shaped values and runs the
 *     same loop against it. Prints before/after pairs (documentation-range
 *     addresses only).
 *   npx tsx scripts/ope1033-truncate-request-sample-ips.ts --apply-production
 *     Runs against prod D1 over the REST API using CLOUDFLARE_API_TOKEN from
 *     .env. Requires John's direct approval (OPE-1033).
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { truncateIp } from "../src/lib/request-sampling";

const ACCOUNT_ID = "e6011e48b7014ef83c77e3c767dac6cf";
const DATABASE_ID = "d449e416-3814-48a6-b9e8-b676333b2cdc";
const BATCH = 2000; // read page size; reads are cheap, writes are what cost
const ROWS_PER_STATEMENT = 48; // 48*2 id/prefix params + 2 range bounds = 98, under D1's 100 cap

export interface Executor {
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<number>; // rows changed
}

const REMAINING_SQL =
  "SELECT COUNT(*) AS n FROM request_samples WHERE ip IS NOT NULL AND ip NOT LIKE '%/%'";

export async function truncateAll(
  exec: Executor,
  log: (s: string) => void = console.log
): Promise<{ updated: number; nulled: number; batches: number; maxParams: number }> {
  let cursor = "";
  let updated = 0;
  let nulled = 0;
  let batches = 0;
  let maxParams = 0;
  for (;;) {
    const rows = (await exec.all(
      "SELECT id, ip FROM request_samples WHERE ip IS NOT NULL AND ip NOT LIKE '%/%' AND id > ? ORDER BY id LIMIT ?",
      [cursor, BATCH]
    )) as { id: string; ip: string }[];
    if (rows.length === 0) break;
    batches++;
    cursor = rows[rows.length - 1].id;

    const resolved = rows.map((r) => ({ id: r.id, prefix: truncateIp(r.ip) }));
    let batchChanged = 0;
    for (let i = 0; i < resolved.length; i += ROWS_PER_STATEMENT) {
      const chunk = resolved.slice(i, i + ROWS_PER_STATEMENT);
      // rows arrive ORDER BY id, so the chunk's own ends are its range bounds
      const lo = chunk[0].id;
      const hi = chunk[chunk.length - 1].id;
      const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
      const params: (string | null)[] = [];
      for (const c of chunk) params.push(c.id, c.prefix);
      params.push(lo, hi);
      maxParams = Math.max(maxParams, params.length);
      const changed = await exec.run(
        `UPDATE request_samples SET ip = CASE id ${cases} ELSE ip END WHERE id BETWEEN ? AND ? AND ip NOT LIKE '%/%'`,
        params
      );
      batchChanged += changed;
      // counted from what we WROTE, not from `changes`, so the two stay
      // independent of the end-of-run re-query that checks them
      for (const c of chunk) {
        if (c.prefix === null) nulled++;
        else updated++;
      }
      if (changed !== chunk.length) {
        log(`  ⚠️ statement matched ${changed} rows, chunk held ${chunk.length}`);
      }
    }
    if (batchChanged === 0) {
      throw new Error(`batch ${batches} selected ${rows.length} rows but changed none — aborting`);
    }
    log(`batch ${batches}: selected ${rows.length}, changed ${batchChanged}`);
  }
  return { updated, nulled, batches, maxParams };
}

function sqliteExecutor(db: Database.Database): Executor {
  return {
    all: async (sql, params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    run: async (sql, params) => db.prepare(sql).run(...params).changes,
  };
}

function d1RestExecutor(token: string): Executor {
  const call = async (sql: string, params: unknown[]) => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
      }
    );
    const body = (await res.json()) as {
      success: boolean;
      errors?: unknown[];
      result?: { results: Record<string, unknown>[]; meta: { changes: number } }[];
    };
    if (!res.ok || !body.success || !body.result?.[0]) {
      throw new Error(`D1 ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
    }
    return body.result[0];
  };
  return {
    all: async (sql, params) => (await call(sql, params)).results,
    run: async (sql, params) => (await call(sql, params)).meta.changes,
  };
}

async function dryRun() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE request_samples (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, ip TEXT, user_agent TEXT)"
  );
  // Documentation ranges only (RFC 5737 / RFC 3849), one of every shape prod holds
  // plus the shapes the ticket names that prod does not (mapped, garbage).
  const shapes: [string, string][] = [
    ["v4", "192.0.2.123"],
    ["v4", "198.51.100.7"],
    ["v6 full", "2001:0db8:85a3:0000:0000:8a2e:0370:7334"],
    ["v6 full", "2001:db8:abcd:12:1:2:3:4"],
    ["v6 compressed", "2001:db8::1"],
    ["v6 compressed", "2001:db8:abcd::42"],
    ["v4-mapped v6", "::ffff:192.0.2.9"],
    ["unparseable", "not-an-ip"],
    ["already prefix", "203.0.113.0/24"],
  ];
  const insert = db.prepare(
    "INSERT INTO request_samples (id, timestamp, ip, user_agent) VALUES (?, 0, ?, 'ua')"
  );
  let n = 0;
  // 1,200 rows so the loop crosses batch and 99-id chunk boundaries.
  for (let i = 0; i < 1200; i++) {
    const [, ip] = shapes[i % shapes.length];
    insert.run(`row-${String(n++).padStart(5, "0")}`, ip);
  }
  const exec = sqliteExecutor(db);
  const totalBefore = (db.prepare("SELECT COUNT(*) n FROM request_samples").get() as { n: number })
    .n;
  const before = (db.prepare(REMAINING_SQL).get() as { n: number }).n;
  console.log(`[driven to failure] remaining-full-IP query BEFORE the run: ${before}`);
  const originals = new Map(
    shapes.map(([, ip]) => [
      ip,
      (db.prepare("SELECT id FROM request_samples WHERE ip = ? LIMIT 1").get(ip) as { id: string })
        .id,
    ])
  );
  const res = await truncateAll(exec, () => {});
  const after = (db.prepare(REMAINING_SQL).get() as { n: number }).n;
  const totalAfter = (db.prepare("SELECT COUNT(*) n FROM request_samples").get() as { n: number })
    .n;
  console.log(`result: ${JSON.stringify(res)}`);
  console.log(
    `remaining-full-IP query AFTER: ${after} · total rows ${totalBefore} → ${totalAfter}`
  );
  console.log("before → after (documentation ranges):");
  for (const [label, ip] of shapes) {
    const row = db
      .prepare("SELECT ip FROM request_samples WHERE id = ?")
      .get(originals.get(ip)) as { ip: string | null };
    const live = truncateIp(ip);
    console.log(
      `  ${label.padEnd(15)} ${ip.padEnd(42)} → ${String(row.ip).padEnd(22)} ${label === "already prefix" || row.ip === live ? "" : "≠ truncateIp!"}`
    );
  }
  // Idempotency: a second pass changes nothing.
  const again = await truncateAll(exec, () => {});
  console.log(`second pass: ${JSON.stringify(again)}`);
  if (after !== 0 || again.batches !== 0 || res.maxParams > 100 || totalAfter !== totalBefore) {
    throw new Error("dry run failed an invariant");
  }
}

async function applyProduction() {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const token = env.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]?.trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN not found in .env");
  const exec = d1RestExecutor(token);
  const before = await exec.all(
    `SELECT COUNT(*) total, SUM(ip LIKE '%/%') cidr, SUM(ip IS NOT NULL AND ip NOT LIKE '%/%') full_ip, SUM(ip IS NULL) null_ip FROM request_samples`,
    []
  );
  console.log(`before ${new Date().toISOString()}: ${JSON.stringify(before[0])}`);
  const res = await truncateAll(exec);
  const after = await exec.all(
    `SELECT COUNT(*) total, SUM(ip LIKE '%/%') cidr, SUM(ip IS NOT NULL AND ip NOT LIKE '%/%') full_ip, SUM(ip IS NULL) null_ip FROM request_samples`,
    []
  );
  console.log(`result: ${JSON.stringify(res)}`);
  console.log(`after ${new Date().toISOString()}: ${JSON.stringify(after[0])}`);
}

const mode = process.argv[2];
if (mode === "--dry-run") {
  await dryRun();
} else if (mode === "--apply-production") {
  await applyProduction();
} else {
  console.error("usage: --dry-run | --apply-production");
  process.exit(2);
}
