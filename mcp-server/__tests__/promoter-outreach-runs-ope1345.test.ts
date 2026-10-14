/**
 * OPE-1345 — `record_promoter_outreach_run` writes the weekly lane's run stamp.
 *
 * The heartbeat reads this row so a research-first week that sends nothing still
 * counts as the lane running. The tool must write exactly one row per call,
 * with the counts as given, and must never touch the attempts table (which
 * feeds the response-rate metrics).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPromoterOutreachLifecycleTools } from "../src/tools/admin-promoter-outreach-lifecycle.js";
import { promoterOutreachRuns, promoterOutreachAttempts } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerPromoterOutreachLifecycleTools(server as never, db, ADMIN_AUTH as never);
});

describe("record_promoter_outreach_run (OPE-1345)", () => {
  it("writes one run row with the counts given, and no attempt row", async () => {
    const res = (await server.invoke("record_promoter_outreach_run", {
      events_reviewed: 5,
      resolved_from_web: 4,
      drafts_for_approval: 1,
      emails_sent: 0,
      note: "week of 2026-10-20",
    })) as { content: Array<{ text: string }> };
    const json = JSON.parse(res.content[0].text) as { success: boolean; run_id: string };
    expect(json.success).toBe(true);

    const runs = db.select().from(promoterOutreachRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: json.run_id,
      eventsReviewed: 5,
      resolvedFromWeb: 4,
      draftsForApproval: 1,
      emailsSent: 0,
      recordedBy: "u-admin",
      note: "week of 2026-10-20",
    });
    expect(runs[0].ranAt).toBeInstanceOf(Date);
    expect(db.select().from(promoterOutreachAttempts).all()).toHaveLength(0);
  });

  it("a run that reviewed nothing is still recorded — 'I ran' is the evidence", async () => {
    await server.invoke("record_promoter_outreach_run", {
      events_reviewed: 0,
      resolved_from_web: 0,
      drafts_for_approval: 0,
      emails_sent: 0,
    });
    expect(db.select().from(promoterOutreachRuns).all()).toHaveLength(1);
  });
});
