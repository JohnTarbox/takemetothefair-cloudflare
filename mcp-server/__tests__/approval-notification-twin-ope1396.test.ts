/**
 * OPE-1396 — the MCP approval-notification twin (used by `update_event_status`)
 * now does what the app copy does:
 *   DUP7  records the classifier's workflow-outcome signal on approval
 *         (`recordWorkflowOutcome`, shared via @takemetothefair/db-schema).
 *         Before, MCP approvals never fed the classifier.
 *   DUP8  skips a suggester on `email_suppression_list` (same check as the
 *         receipt ack), leaving approval_notified_at NULL.
 *
 * In-memory SQLite (setup-db.ts); every assertion reads rows back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type TestDb } from "./setup-db.js";
import { notifyApprovalIfNeeded } from "../src/approval-notification.js";
import {
  emailSuppressionList,
  events,
  inboundEmailIntentFeedback,
  inboundEmails,
  promoters,
  users,
} from "../src/schema.js";

let db: TestDb;
let send: ReturnType<typeof vi.fn>;
const env = () => ({ EMAIL_JOBS: { send } as unknown as Queue<unknown> });

beforeEach(() => {
  ({ db } = createTestDb());
  send = vi.fn(async () => undefined);
  db.insert(users).values({ id: "u-p", email: "p@test", role: "PROMOTER" }).run();
  db.insert(promoters)
    .values({ id: "p1", userId: "u-p", companyName: "P", slug: "p" as never })
    .run();
  db.insert(events)
    .values({
      id: "e1",
      name: "Harvest Fair",
      slug: "harvest-fair" as never,
      promoterId: "p1",
      status: "APPROVED",
      suggesterEmail: "Submitter@Example.com",
    } as never)
    .run();
  db.insert(inboundEmails)
    .values({
      id: "ie1",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "submitter@example.com",
      toAddress: "events@meetmeatthefair.com",
      intent: "new_event",
      resultingEventId: "e1",
      classifiedIntent: "new_event",
      classifierVersion: "v-test",
    } as never)
    .run();
});

const feedbackRows = () =>
  db
    .select()
    .from(inboundEmailIntentFeedback)
    .where(eq(inboundEmailIntentFeedback.inboundEmailId, "ie1"))
    .all();

const notifiedAt = () =>
  db.select({ at: events.approvalNotifiedAt }).from(events).where(eq(events.id, "e1")).get()?.at;

describe("DUP7 — MCP approval feeds the classifier", () => {
  it("writes one workflow_outcome row confirming the classified intent", async () => {
    const r = await notifyApprovalIfNeeded(db as never, env(), "e1");
    expect(r.outcome).toBe("sent");
    const rows = feedbackRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feedbackSource: "workflow_outcome",
      originalIntent: "new_event",
      correctedIntent: "new_event",
      classifierVersion: "v-test",
    });
  });
});

describe("DUP8 — suppression list", () => {
  it("does not send to a suppressed address (case-insensitive) and leaves the marker NULL", async () => {
    db.insert(emailSuppressionList)
      .values({ email: "submitter@example.com", reason: "unsubscribe", createdAt: new Date() })
      .run();
    const r = await notifyApprovalIfNeeded(db as never, env(), "e1");
    expect(r.outcome).toBe("skipped:suppressed");
    expect(send).not.toHaveBeenCalled();
    expect(notifiedAt()).toBeNull();
    // The approval still happened, so the classifier still hears about it.
    expect(feedbackRows()).toHaveLength(1);
  });

  it("sends when the address is not suppressed", async () => {
    const r = await notifyApprovalIfNeeded(db as never, env(), "e1");
    expect(r.outcome).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notifiedAt()).not.toBeNull();
  });
});

describe("twin parity — both copies call the shared writers", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
  for (const p of ["src/lib/approval-notification.ts", "mcp-server/src/approval-notification.ts"]) {
    it(`${p} calls recordWorkflowOutcome( and isEmailSuppressed(`, () => {
      const src = read(p);
      expect(src).toMatch(/await recordWorkflowOutcome\(db,/);
      expect(src).toMatch(/await isEmailSuppressed\(db,/);
    });
  }
});
