/**
 * Unit tests for notifyApprovalIfNeeded.
 *
 * The helper is a pure orchestrator over (a) one SELECT, (b) one Queue.send,
 * and (c) one UPDATE. We exercise each gate condition + the happy path with
 * a fake Drizzle chain and a fake Queue.
 *
 * Pattern matches src/lib/__tests__/indexnow.test.ts — light hand-rolled
 * chainable stub, no real D1 spin-up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifyApprovalIfNeeded } from "../approval-notification";

interface FakeEventRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  suggesterEmail: string | null;
  approvalNotifiedAt: Date | null;
}

function makeDb(row: FakeEventRow | null) {
  const updateSpy = vi.fn(async () => undefined);
  const setSpy = vi.fn(() => ({ where: updateSpy }));
  const updateRoot = vi.fn(() => ({ set: setSpy }));

  const limitSpy = vi.fn(async () => (row ? [row] : []));
  const whereSpy = vi.fn(() => ({ limit: limitSpy }));
  const fromSpy = vi.fn(() => ({ where: whereSpy }));
  const selectSpy = vi.fn(() => ({ from: fromSpy }));

  return {
    db: { select: selectSpy, update: updateRoot } as never,
    spies: { selectSpy, updateRoot, setSpy, updateWhere: updateSpy },
  };
}

function makeQueue() {
  const send = vi.fn(async () => undefined);
  return { queue: { send } as unknown as Queue<unknown>, send };
}

const baseRow: FakeEventRow = {
  id: "evt_123",
  name: "Fryeburg Fair 2026",
  slug: "fryeburg-fair-2026",
  status: "APPROVED",
  suggesterEmail: "alice@example.com",
  approvalNotifiedAt: null,
};

describe("notifyApprovalIfNeeded — gate conditions", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("skips with 'not-found' when the event row doesn't exist", async () => {
    const { db } = makeDb(null);
    const { queue, send } = makeQueue();
    const result = await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "missing");
    expect(result.outcome).toBe("skipped:not-found");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips with 'no-suggester-email' for admin-created events (no attribution)", async () => {
    const { db } = makeDb({ ...baseRow, suggesterEmail: null });
    const { queue, send } = makeQueue();
    const result = await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "evt_123");
    expect(result.outcome).toBe("skipped:no-suggester-email");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips with 'not-approved' if a caller fires the hook on a non-APPROVED row", async () => {
    // Defends against a future bug where a caller forgets the
    // transition guard. The helper's own status read is the source
    // of truth — re-approves of an un-approved event proceed via the
    // approval_notified_at gate below, not by status.
    const { db } = makeDb({ ...baseRow, status: "PENDING" });
    const { queue, send } = makeQueue();
    const result = await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "evt_123");
    expect(result.outcome).toBe("skipped:not-approved");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips with 'already-notified' when approval_notified_at is set (idempotency)", async () => {
    // This is the un-approve → re-approve guard. Even if status returns
    // to APPROVED a second time, we don't re-send.
    const { db } = makeDb({ ...baseRow, approvalNotifiedAt: new Date("2026-05-01T00:00:00Z") });
    const { queue, send } = makeQueue();
    const result = await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "evt_123");
    expect(result.outcome).toBe("skipped:already-notified");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns 'error:queue-missing' if EMAIL_JOBS binding is absent (dev/misconfig)", async () => {
    const { db } = makeDb(baseRow);
    const result = await notifyApprovalIfNeeded(db, { EMAIL_JOBS: undefined }, "evt_123");
    expect(result.outcome).toBe("error:queue-missing");
    warnSpy.mockRestore();
  });
});

describe("notifyApprovalIfNeeded — happy path", () => {
  it("pushes an email-job message and writes approval_notified_at", async () => {
    const { db, spies } = makeDb(baseRow);
    const { queue, send } = makeQueue();
    const result = await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "evt_123");

    expect(result.outcome).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(spies.updateRoot).toHaveBeenCalledTimes(1);

    const msg = send.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
      html: string;
      source: string;
    };
    expect(msg.to).toBe("alice@example.com");
    expect(msg.source).toBe("email:submission-approved");
    expect(msg.subject).toContain("Your submission is live:");
    expect(msg.subject).toContain("Fryeburg Fair 2026");
    // Body must point at the live URL and invite corrections — same
    // contract the reply-builder branch enforces. Mirrored here so a
    // template-side regression shows up locally.
    expect(msg.text).toContain("https://meetmeatthefair.com/events/fryeburg-fair-2026");
    expect(msg.text).toMatch(/some details may have been adjusted|reply to this thread/i);
  });

  it("clamps subject to 200 chars even with a long event name", async () => {
    const longName = "A".repeat(500);
    const { db } = makeDb({ ...baseRow, name: longName });
    const { queue, send } = makeQueue();
    await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "evt_123");
    const msg = send.mock.calls[0][0] as { subject: string };
    expect(msg.subject.length).toBeLessThanOrEqual(200);
  });

  it("HTML body escapes special chars in the event name (no raw injection)", async () => {
    const { db } = makeDb({ ...baseRow, name: "<script>alert(1)</script>" });
    const { queue, send } = makeQueue();
    await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "evt_123");
    const msg = send.mock.calls[0][0] as { html: string };
    expect(msg.html).not.toContain("<script>alert(1)</script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });

  it("queue push happens BEFORE the approval_notified_at UPDATE", async () => {
    // Sequencing matters: if we set the marker first and then the queue
    // push fails, idempotency is burned and the submitter never gets
    // notified. Helper enforces send → update order; this test pins it.
    const { db, spies } = makeDb(baseRow);
    const callOrder: string[] = [];
    const queue = {
      send: vi.fn(async () => {
        callOrder.push("queue");
      }),
    } as unknown as Queue<unknown>;
    spies.updateRoot.mockImplementation(() => {
      callOrder.push("update");
      return { set: spies.setSpy };
    });
    await notifyApprovalIfNeeded(db, { EMAIL_JOBS: queue }, "evt_123");
    expect(callOrder).toEqual(["queue", "update"]);
  });
});
