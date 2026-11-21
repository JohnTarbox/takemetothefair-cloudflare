/**
 * OPE-1596 — nightly expiry of elapsed PENDING submissions (John, 2026-11-16,
 * option 1): end date (start when end is null) more than 3 days past →
 * REJECTED `elapsed_unreviewed`, skipping rows a person touched in 7 days.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  runElapsedPendingExpiry,
  EXPIRY_HEARTBEAT_CODE,
} from "../src/events/elapsed-pending-expiry.js";
import { readOperatorQueues } from "../src/operator-queue-notice.js";

const NOW = new Date("2026-11-17T06:00:00Z");
const DAY = 86400;
const nowSecs = Math.floor(NOW.getTime() / 1000);
const PROMOTER_ID = "p-test";

let db: TestDb;
let raw: {
  exec: (s: string) => void;
  prepare: (s: string) => {
    all: (...a: unknown[]) => unknown[];
    get: (...a: unknown[]) => unknown;
  };
};

function seed(o: {
  id: string;
  status?: string;
  endDaysAgo: number | null;
  startOnly?: boolean;
  updatedDaysAgo?: number | null;
}) {
  const end = o.endDaysAgo == null ? "NULL" : String(nowSecs - o.endDaysAgo * DAY);
  const start = o.endDaysAgo == null ? "NULL" : String(nowSecs - (o.endDaysAgo + 1) * DAY);
  const startVal = o.startOnly ? end : start;
  const endVal = o.startOnly ? "NULL" : end;
  const updated =
    o.updatedDaysAgo === undefined
      ? nowSecs - 30 * DAY
      : o.updatedDaysAgo === null
        ? null
        : nowSecs - o.updatedDaysAgo * DAY;
  raw.exec(`
    INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, view_count, updated_at)
    VALUES ('${o.id}', '${o.id}', '${o.id}', '${PROMOTER_ID}', ${startVal}, ${endVal},
            '${o.status ?? "PENDING"}', 0, ${updated ?? "NULL"})
  `);
}

const status = (id: string) =>
  (raw.prepare(`SELECT status AS s FROM events WHERE id = ?`).get(id) as { s: string }).s;

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as typeof raw;
  raw.exec(
    `INSERT INTO promoters (id, company_name, slug) VALUES ('${PROMOTER_ID}', 'Test Promoter', 'test-promoter')`
  );
});

describe("runElapsedPendingExpiry", () => {
  it("expires only PENDING rows more than 3 days past, and audits each", async () => {
    seed({ id: "air-show-2025", endDaysAgo: 400 });
    seed({ id: "four-days", endDaysAgo: 4 });
    seed({ id: "start-only", endDaysAgo: 10, startOnly: true });
    seed({ id: "two-days", endDaysAgo: 2 }); // inside the 3-day grace
    seed({ id: "upcoming", endDaysAgo: -5 });
    seed({ id: "no-date", endDaysAgo: null });
    seed({ id: "approved-past", endDaysAgo: 400, status: "APPROVED" });
    seed({ id: "never-updated", endDaysAgo: 20, updatedDaysAgo: null });

    const r = await runElapsedPendingExpiry(db as never, { now: NOW });

    expect(r.expired.map((e) => e.slug).sort()).toEqual(
      ["air-show-2025", "four-days", "never-updated", "start-only"].sort()
    );
    // Positive landmark beside the negatives: 4 candidates examined, 4 expired.
    expect(r.elapsed).toBe(4);
    expect(status("air-show-2025")).toBe("REJECTED");
    expect(status("two-days")).toBe("PENDING");
    expect(status("upcoming")).toBe("PENDING");
    expect(status("no-date")).toBe("PENDING");
    expect(status("approved-past")).toBe("APPROVED");

    const audit = raw
      .prepare(
        `SELECT target_id, payload_json, actor_user_id FROM admin_actions WHERE action = 'event.expire_elapsed'`
      )
      .all() as { target_id: string; payload_json: string; actor_user_id: string | null }[];
    expect(audit.map((a) => a.target_id).sort()).toEqual(
      ["air-show-2025", "four-days", "never-updated", "start-only"].sort()
    );
    for (const a of audit) {
      expect(a.actor_user_id).toBeNull();
      expect(JSON.parse(a.payload_json)).toMatchObject({
        reason: "elapsed_unreviewed",
        from: "PENDING",
        to: "REJECTED",
        via: "elapsed-pending-expiry",
      });
    }
  });

  it("skips rows a person touched in the last 7 days (updated_at or an admin action)", async () => {
    seed({ id: "edited-yesterday", endDaysAgo: 30, updatedDaysAgo: 1 });
    seed({ id: "admin-acted", endDaysAgo: 30 });
    seed({ id: "cron-acted", endDaysAgo: 30 });
    seed({ id: "edited-long-ago", endDaysAgo: 30, updatedDaysAgo: 8 });
    raw.exec(`
      INSERT INTO admin_actions (action, actor_user_id, target_type, target_id, payload_json, created_at)
      VALUES ('event.note', 'user-1', 'event', 'admin-acted', '{}', ${nowSecs - 2 * DAY}),
             ('event.sync', NULL, 'event', 'cron-acted', '{}', ${nowSecs - 2 * DAY})
    `);

    const r = await runElapsedPendingExpiry(db as never, { now: NOW });

    expect(r.expired.map((e) => e.slug).sort()).toEqual(["cron-acted", "edited-long-ago"]);
    expect(r.skippedTouched).toBe(2);
    expect(status("edited-yesterday")).toBe("PENDING");
    expect(status("admin-acted")).toBe("PENDING");
    expect(r.summary).toBe(
      "expired 2 elapsed PENDING rows (4 past end+3d; 2 skipped, touched in the last 7d)"
    );
  });

  it("stamps the heartbeat and run row even when nothing expires, and the digest prints one line", async () => {
    seed({ id: "upcoming", endDaysAgo: -5 });
    const r = await runElapsedPendingExpiry(db as never, { now: NOW });
    expect(r.expired).toEqual([]);

    const hb = raw
      .prepare(`SELECT note FROM agent_heartbeats WHERE agent_code = ?`)
      .get(EXPIRY_HEARTBEAT_CODE) as { note: string } | undefined;
    expect(hb?.note).toBe("elapsed=0 expired=0 skipped=0 errors=0");

    const q = await readOperatorQueues(db as never, new Date(NOW.getTime() + 60_000), {});
    const line = q.lines.filter((l: string) => l.startsWith("Elapsed PENDING expiry (OPE-1596)"));
    expect(line).toEqual([
      "Elapsed PENDING expiry (OPE-1596): expired 0 elapsed PENDING rows (0 past end+3d; 0 skipped, touched in the last 7d)",
    ]);
  });
});
