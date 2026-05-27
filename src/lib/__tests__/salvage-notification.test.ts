/**
 * Unit tests for notifySalvageIfNeeded.
 *
 * Same pattern as approval-notification.test.ts — light hand-rolled
 * chainable stub, no real D1. Covers each gate condition + the happy
 * path with a 4-event "K1LX hamfest" scenario from the analyst's spec.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifySalvageIfNeeded } from "../salvage-notification";

interface FakeInboundRow {
  id: string;
  fromAddress: string | null;
  subject: string | null;
  salvageNotifiedAt: Date | null;
}

interface FakeEventRow {
  id: string;
  name: string;
  slug: string;
}

function makeDb(inbound: FakeInboundRow | null, events: FakeEventRow[]) {
  const updateSpy = vi.fn(async () => undefined);
  const setSpy = vi.fn(() => ({ where: updateSpy }));
  const updateRoot = vi.fn(() => ({ set: setSpy }));

  // Two SELECTs in sequence: first the inbound row, then the events list.
  // The mock returns each on successive .limit / await terminations.
  let selectCallCount = 0;
  const selectSpy = vi.fn(() => {
    selectCallCount += 1;
    const isInboundCall = selectCallCount === 1;
    if (isInboundCall) {
      const limitSpy = vi.fn(async () => (inbound ? [inbound] : []));
      const whereSpy = vi.fn(() => ({ limit: limitSpy }));
      const fromSpy = vi.fn(() => ({ where: whereSpy }));
      return { from: fromSpy };
    }
    // Events lookup — no .limit, just terminal await
    const whereSpy = vi.fn(async () => events);
    const fromSpy = vi.fn(() => ({ where: whereSpy }));
    return { from: fromSpy };
  });

  return {
    db: { select: selectSpy, update: updateRoot } as never,
    spies: { selectSpy, updateRoot, setSpy, updateWhere: updateSpy },
  };
}

function makeQueue() {
  const send = vi.fn(async () => undefined);
  return { queue: { send } as unknown as Queue<unknown>, send };
}

const baseInbound: FakeInboundRow = {
  id: "ie_k1lx",
  fromAddress: "submitter@example.com",
  subject: "K1LX hamfest list",
  salvageNotifiedAt: null,
};

const k1lxEvents: FakeEventRow[] = [
  { id: "evt_1", name: "K1LX Hamfest Spring", slug: "k1lx-hamfest-spring" },
  { id: "evt_2", name: "K1LX Hamfest Summer", slug: "k1lx-hamfest-summer" },
  { id: "evt_3", name: "K1LX Hamfest Fall", slug: "k1lx-hamfest-fall" },
  { id: "evt_4", name: "K1LX Hamfest Winter", slug: "k1lx-hamfest-winter" },
];

describe("notifySalvageIfNeeded — gate conditions", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("skips with 'no-events' when event_ids is empty", async () => {
    const { db } = makeDb(baseInbound, k1lxEvents);
    const { queue, send } = makeQueue();
    const r = await notifySalvageIfNeeded(db, { EMAIL_JOBS: queue }, "ie_k1lx", []);
    expect(r.outcome).toBe("skipped:no-events");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips with 'not-found' when the inbound row doesn't exist", async () => {
    const { db } = makeDb(null, []);
    const { queue, send } = makeQueue();
    const r = await notifySalvageIfNeeded(db, { EMAIL_JOBS: queue }, "missing", ["evt_1"]);
    expect(r.outcome).toBe("skipped:not-found");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips with 'no-from-address' when the inbound row has no sender", async () => {
    const { db } = makeDb({ ...baseInbound, fromAddress: null }, k1lxEvents);
    const { queue, send } = makeQueue();
    const r = await notifySalvageIfNeeded(db, { EMAIL_JOBS: queue }, "ie_k1lx", ["evt_1"]);
    expect(r.outcome).toBe("skipped:no-from-address");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips with 'already-notified' when salvage_notified_at is set", async () => {
    const { db } = makeDb(
      { ...baseInbound, salvageNotifiedAt: new Date("2026-05-25T00:00:00Z") },
      k1lxEvents
    );
    const { queue, send } = makeQueue();
    const r = await notifySalvageIfNeeded(db, { EMAIL_JOBS: queue }, "ie_k1lx", ["evt_1"]);
    expect(r.outcome).toBe("skipped:already-notified");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns 'event-not-found' when supplied IDs include any unknown event", async () => {
    const { db } = makeDb(baseInbound, [k1lxEvents[0], k1lxEvents[1]]); // only 2 of 4
    const { queue, send } = makeQueue();
    const r = await notifySalvageIfNeeded(db, { EMAIL_JOBS: queue }, "ie_k1lx", [
      "evt_1",
      "evt_2",
      "evt_3",
      "evt_99",
    ]);
    expect(r.outcome).toBe("error:event-not-found");
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns 'queue-missing' when EMAIL_JOBS binding is absent", async () => {
    // Mock returns 4 events; supply 4 IDs so the event-not-found gate
    // passes and we reach the queue check.
    const { db } = makeDb(baseInbound, k1lxEvents);
    const r = await notifySalvageIfNeeded(db, {}, "ie_k1lx", ["evt_1", "evt_2", "evt_3", "evt_4"]);
    expect(r.outcome).toBe("error:queue-missing");
    warnSpy.mockRestore();
  });
});

describe("notifySalvageIfNeeded — happy path", () => {
  it("sends one email listing all 4 K1LX events in caller-supplied order", async () => {
    const { db, spies } = makeDb(baseInbound, k1lxEvents);
    const { queue, send } = makeQueue();
    const r = await notifySalvageIfNeeded(db, { EMAIL_JOBS: queue }, "ie_k1lx", [
      "evt_2",
      "evt_4",
      "evt_1",
      "evt_3",
    ]);
    expect(r.outcome).toBe("sent");
    expect(r.eventsListed).toBe(4);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
      source: string;
    };
    expect(msg.to).toBe("submitter@example.com");
    expect(msg.source).toBe("email:submission-salvaged");
    expect(msg.text).toContain("created 4 events");
    // Order: caller asked for 2, 4, 1, 3 — check that's how they appear.
    const positions = [
      msg.text.indexOf("K1LX Hamfest Summer"),
      msg.text.indexOf("K1LX Hamfest Winter"),
      msg.text.indexOf("K1LX Hamfest Spring"),
      msg.text.indexOf("K1LX Hamfest Fall"),
    ];
    expect(positions.every((p) => p > -1)).toBe(true);
    expect(positions[0] < positions[1]).toBe(true);
    expect(positions[1] < positions[2]).toBe(true);
    expect(positions[2] < positions[3]).toBe(true);
    // Marker write happened.
    expect(spies.updateRoot).toHaveBeenCalled();
  });

  it("uses singular 'event' for 1-event salvage", async () => {
    const { db } = makeDb(baseInbound, [k1lxEvents[0]]);
    const { queue, send } = makeQueue();
    const r = await notifySalvageIfNeeded(db, { EMAIL_JOBS: queue }, "ie_k1lx", ["evt_1"]);
    expect(r.outcome).toBe("sent");
    const msg = send.mock.calls[0][0] as { text: string };
    expect(msg.text).toContain("created 1 event from it");
    expect(msg.text).not.toContain("1 events");
  });
});
