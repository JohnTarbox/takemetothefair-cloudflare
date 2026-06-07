// Regression tests for the routing fix that addresses the upstream MCP TS
// SDK #1186 / agents/mcp concurrent-response misrouting bug. The bug, in
// brief: when two MCP requests share a JSON-RPC id across concurrent
// connections, transport.send() picks the first matching connection via
// Array.prototype.find(), routing the response to the wrong client.
//
// These tests exercise the building blocks in
// src/transport-collision-fix.ts in isolation — both the routing-decision
// logic and the direct-write replacement for the response branch of send.

import { describe, expect, it, vi } from "vitest";

import {
  decideSendRouting,
  sendViaConnection,
  type ConnectionLike,
  type TransportPrivates,
} from "../src/transport-collision-fix.js";

function conn(id: string, requestIds: unknown[]): ConnectionLike {
  return { id, state: { requestIds } };
}

describe("decideSendRouting", () => {
  it("passes through when requestId is undefined", () => {
    const result = decideSendRouting([], undefined, {});
    expect(result).toEqual({ kind: "passthrough", matched: undefined });
  });

  it("passes through when requestId is null", () => {
    const c = conn("c1", [1]);
    const result = decideSendRouting([c], null, { sendTimeConnectionId: "c1" });
    expect(result).toEqual({ kind: "passthrough", matched: undefined });
  });

  it("passes through when no connection matches the requestId", () => {
    const c = conn("c1", [99]);
    const result = decideSendRouting([c], 42, {});
    expect(result).toEqual({ kind: "passthrough", matched: undefined });
  });

  it("passes through when exactly one connection matches (matched surfaced for intake cleanup)", () => {
    const c = conn("c1", [42]);
    const result = decideSendRouting([c], 42, {});
    expect(result).toEqual({ kind: "passthrough", matched: c });
  });

  it("returns fixed via intakeIntersection when multiple match and exactly one intake-recorded connection is among them", () => {
    // Reproduces the analyst-reported bug shape: two parallel MCP calls
    // both have id=42 in their state. The intake set recorded only one
    // (the other connection hasn't fired intake yet, or its intake was
    // already consumed by an earlier send). Without disambiguation the
    // original transport's find() would arbitrarily route to c1.
    const c1 = conn("c1", [42]);
    const c2 = conn("c2", [42]);
    const result = decideSendRouting([c1, c2], 42, {
      intakeConnectionIds: new Set(["c2"]),
    });
    expect(result).toEqual({ kind: "fixed", connection: c2, via: "intakeIntersection" });
  });

  it("returns fixed via sendTimeContext when ALS pinpoints the originating connection", () => {
    // K19 case: two concurrent subagents both have id=42 in flight. The
    // intake set holds BOTH connection ids (the pre-K19 code would have
    // overwritten — this multi-value set is the fix). Send-time ALS
    // identifies which response we're processing right now. sendTime
    // wins because it's the response's own context identity.
    const c1 = conn("c1", [42]);
    const c2 = conn("c2", [42]);
    const result = decideSendRouting([c1, c2], 42, {
      sendTimeConnectionId: "c1",
      intakeConnectionIds: new Set(["c1", "c2"]),
    });
    expect(result).toEqual({ kind: "fixed", connection: c1, via: "sendTimeContext" });
  });

  it("falls back from sendTime to intakeIntersection when sendTimeConnectionId is not in matches", () => {
    // Defensive fallback — ALS may have leaked context from an unrelated
    // path (e.g. a different connection's tick). If sendTime points
    // outside the match set, we ignore it and try the intake-set.
    const c1 = conn("c1", [42]);
    const c2 = conn("c2", [42]);
    const result = decideSendRouting([c1, c2], 42, {
      sendTimeConnectionId: "c-vanished",
      intakeConnectionIds: new Set(["c1"]),
    });
    expect(result).toEqual({ kind: "fixed", connection: c1, via: "intakeIntersection" });
  });

  it("ambiguous when multiple connections match and no signals disambiguate", () => {
    const c1 = conn("c1", [42]);
    const c2 = conn("c2", [42]);
    const result = decideSendRouting([c1, c2], 42, {});
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matchedIds).toEqual(["c1", "c2"]);
    }
  });

  it("ambiguous when intake set intersects matches in more than one place and no sendTime signal", () => {
    // This is the case the pre-K19 single-valued map could NOT detect:
    // both concurrent intakes recorded, both connections still in
    // matches, and ALS broke (no sendTime). We refuse rather than guess.
    const c1 = conn("c1", [42]);
    const c2 = conn("c2", [42]);
    const result = decideSendRouting([c1, c2], 42, {
      intakeConnectionIds: new Set(["c1", "c2"]),
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("ambiguous when tracked connection no longer matches any current connection", () => {
    // All signals point to vanished connections — refuse to send rather
    // than route arbitrarily.
    const c1 = conn("c1", [42]);
    const c2 = conn("c2", [42]);
    const result = decideSendRouting([c1, c2], 42, {
      sendTimeConnectionId: "vanished-a",
      intakeConnectionIds: new Set(["vanished-b"]),
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("handles string requestIds (some clients send strings)", () => {
    const c1 = conn("c1", ["req-1"]);
    const c2 = conn("c2", ["req-1"]);
    const result = decideSendRouting([c1, c2], "req-1", {
      sendTimeConnectionId: "c1",
    });
    expect(result).toEqual({ kind: "fixed", connection: c1, via: "sendTimeContext" });
  });

  it("ignores connections with missing or non-array state.requestIds", () => {
    const partial: ConnectionLike = { id: "c-broken" };
    const good = conn("c-good", [42]);
    const result = decideSendRouting([partial, good], 42, {});
    expect(result).toEqual({ kind: "passthrough", matched: good });
  });

  it("returns the same connection reference (not a copy) on fixed", () => {
    // Identity matters — sendViaConnection uses the connection ref to
    // call writeSSEEvent and read its state.
    const c1 = conn("c1", [42]);
    const c2 = conn("c2", [42]);
    const result = decideSendRouting([c1, c2], 42, {
      sendTimeConnectionId: "c1",
    });
    expect(result.kind).toBe("fixed");
    if (result.kind === "fixed") {
      expect(result.connection).toBe(c1);
    }
  });
});

describe("sendViaConnection", () => {
  function makeTransport(opts: { eventStore?: boolean } = {}) {
    const writeSSEEvent = vi.fn();
    const requestResponseMap = new Map<unknown, unknown>();
    const transport: TransportPrivates = {
      writeSSEEvent,
      _requestResponseMap: requestResponseMap,
    };
    if (opts.eventStore) {
      transport._eventStore = {
        storeEvent: vi.fn(async (_cid: string, _m: unknown) => "event-1"),
      };
    }
    return { transport, writeSSEEvent, requestResponseMap };
  }

  it("writes a response to the supplied connection", async () => {
    const { transport, writeSSEEvent } = makeTransport();
    const c = conn("c-target", [42]);
    const msg = { jsonrpc: "2.0", id: 42, result: { ok: true } };

    await sendViaConnection(transport, c, msg, 42);

    expect(writeSSEEvent).toHaveBeenCalledTimes(1);
    const [calledConn, calledMessage, calledEventId, calledClose] = writeSSEEvent.mock.calls[0];
    expect(calledConn).toBe(c);
    expect(calledMessage).toBe(msg);
    expect(calledEventId).toBeUndefined();
    // shouldClose is true: the connection has one inflight id, and we just
    // recorded its response, so all responses are now ready.
    expect(calledClose).toBe(true);
  });

  it("does not close when other requestIds on the connection are still inflight", async () => {
    const { transport, writeSSEEvent, requestResponseMap } = makeTransport();
    // Connection has 42 AND 43 inflight; only 42 is being responded to.
    const c = conn("c-target", [42, 43]);
    const msg = { jsonrpc: "2.0", id: 42, result: { ok: true } };

    await sendViaConnection(transport, c, msg, 42);

    expect(writeSSEEvent).toHaveBeenCalledTimes(1);
    expect(writeSSEEvent.mock.calls[0][3]).toBe(false);
    // 42 is recorded in the map; 43 is still pending.
    expect(requestResponseMap.has(42)).toBe(true);
    expect(requestResponseMap.has(43)).toBe(false);
  });

  it("clears all requestIds from the response map when closing", async () => {
    const { transport, requestResponseMap } = makeTransport();
    // Simulate the prior response for id=43 already landed.
    requestResponseMap.set(43, { jsonrpc: "2.0", id: 43, result: { x: 1 } });
    const c = conn("c-target", [42, 43]);
    const msg = { jsonrpc: "2.0", id: 42, result: { ok: true } };

    await sendViaConnection(transport, c, msg, 42);

    // Once both responses are present, the close branch deletes BOTH.
    expect(requestResponseMap.has(42)).toBe(false);
    expect(requestResponseMap.has(43)).toBe(false);
  });

  it("uses _eventStore to obtain the event id when present", async () => {
    const { transport, writeSSEEvent } = makeTransport({ eventStore: true });
    const c = conn("c-target", [42]);
    const msg = { jsonrpc: "2.0", id: 42, result: { ok: true } };

    await sendViaConnection(transport, c, msg, 42);

    expect(transport._eventStore!.storeEvent).toHaveBeenCalledWith("c-target", msg);
    expect(writeSSEEvent.mock.calls[0][2]).toBe("event-1");
  });

  it("does not touch _requestResponseMap for non-response messages", async () => {
    // Notifications (no `result` / no `error`) shouldn't enter the
    // response-close bookkeeping path even if they happen to be routed
    // by this helper.
    const { transport, requestResponseMap } = makeTransport();
    const c = conn("c-target", [42]);
    const notification = { jsonrpc: "2.0", method: "x", params: {} };
    await sendViaConnection(transport, c, notification, undefined);
    expect(requestResponseMap.size).toBe(0);
  });
});

describe("end-to-end concurrent-response regression", () => {
  // Simulates the analyst's reported scenario: two MCP requests, both
  // assigned JSON-RPC id=1 by the client (or one client across two
  // sessions), are in flight at the same time. Without the fix, the
  // response for connection B would be routed to connection A via the
  // find() ambiguity. With the fix, each response is routed to the
  // connection that originally received the request.

  function makeFakeTransport() {
    const writeSSEEvent = vi.fn();
    const transport: TransportPrivates = {
      writeSSEEvent,
      _requestResponseMap: new Map(),
    };
    return { transport, writeSSEEvent };
  }

  it("interleaved intake/send: each response routes to its originating connection", async () => {
    // The original (pre-K19) scenario: intake A, send A, intake B, send B.
    // No concurrent intake collision because send A clears the entry before
    // B's intake records. The single-valued and multi-valued maps both
    // handle this identically.
    const { transport, writeSSEEvent } = makeFakeTransport();
    const cA = conn("cA", [1]);
    const cB = conn("cB", [1]);
    const allConnections: ConnectionLike[] = [cA, cB];

    const intake = new Map<unknown, Set<string>>();

    const recordIntake = (id: unknown, connectionId: string) => {
      let set = intake.get(id);
      if (!set) {
        set = new Set();
        intake.set(id, set);
      }
      set.add(connectionId);
    };

    // T=0: A's intake.
    recordIntake(1, "cA");
    let result = decideSendRouting(allConnections, 1, {
      intakeConnectionIds: intake.get(1),
    });
    intake.delete(1);
    expect(result.kind).toBe("fixed");
    if (result.kind === "fixed") {
      expect(result.connection.id).toBe("cA");
      expect(result.via).toBe("intakeIntersection");
    }
    await sendViaConnection(
      transport,
      (result as { kind: "fixed"; connection: ConnectionLike }).connection,
      { jsonrpc: "2.0", id: 1, result: { from: "A" } },
      1
    );

    // T=1: B's intake.
    recordIntake(1, "cB");
    result = decideSendRouting(allConnections, 1, {
      intakeConnectionIds: intake.get(1),
    });
    intake.delete(1);
    expect(result.kind).toBe("fixed");
    if (result.kind === "fixed") expect(result.connection.id).toBe("cB");
    await sendViaConnection(
      transport,
      (result as { kind: "fixed"; connection: ConnectionLike }).connection,
      { jsonrpc: "2.0", id: 1, result: { from: "B" } },
      1
    );

    expect(writeSSEEvent).toHaveBeenCalledTimes(2);
    const [connFirst, msgFirst] = writeSSEEvent.mock.calls[0];
    const [connSecond, msgSecond] = writeSSEEvent.mock.calls[1];
    expect((connFirst as ConnectionLike).id).toBe("cA");
    expect((msgFirst as { result: { from: string } }).result.from).toBe("A");
    expect((connSecond as ConnectionLike).id).toBe("cB");
    expect((msgSecond as { result: { from: string } }).result.from).toBe("B");
  });

  it("K19 regression: concurrent intakes with same id, both pending at first send, route correctly via send-time ALS", async () => {
    // The K19 scenario surfaced 2026-06-04 during the NH Farm, Forest &
    // Garden Expo roster build. Three parallel subagents each issued
    // create_vendor with overlapping JSON-RPC ids. The pre-K19 wrap's
    // single-valued intake map clobbered on each new intake — so when
    // A's send fired, the intake entry already belonged to whichever
    // intake arrived last, and A's response was routed to the wrong
    // socket. The test file at the time (lines 213-251) explicitly
    // documented this as an unfixed limitation.
    //
    // The K19 fix: intake map is now Map<id, Set<connectionId>>, AND
    // send time reads getCurrentAgent().connection?.id as a direct
    // signal. When both signals are present, send-time ALS wins.
    const { transport, writeSSEEvent } = makeFakeTransport();
    const cA = conn("cA", [1]);
    const cB = conn("cB", [1]);
    const allConnections: ConnectionLike[] = [cA, cB];

    // T=0: A's intake records cA into the set for id=1.
    // T=1: B's intake records cB into the same set BEFORE either send fires.
    //      Pre-K19 this clobbered; now both coexist.
    const intake = new Map<unknown, Set<string>>();
    intake.set(1, new Set(["cA", "cB"]));

    // T=2: A's tool callback completes; transport.send is called for id=1
    //      with getCurrentAgent().connection.id === "cA" (ALS held).
    let result = decideSendRouting(allConnections, 1, {
      sendTimeConnectionId: "cA",
      intakeConnectionIds: intake.get(1),
    });
    expect(result.kind).toBe("fixed");
    if (result.kind === "fixed") {
      expect(result.connection.id).toBe("cA");
      expect(result.via).toBe("sendTimeContext");
    }
    // Send consumes only A's entry; B's stays for B's eventual send.
    intake.get(1)!.delete("cA");
    await sendViaConnection(
      transport,
      (result as { kind: "fixed"; connection: ConnectionLike }).connection,
      { jsonrpc: "2.0", id: 1, result: { from: "A" } },
      1
    );

    // T=3: B's send fires with ALS pointing at cB.
    result = decideSendRouting(allConnections, 1, {
      sendTimeConnectionId: "cB",
      intakeConnectionIds: intake.get(1),
    });
    expect(result.kind).toBe("fixed");
    if (result.kind === "fixed") {
      expect(result.connection.id).toBe("cB");
      expect(result.via).toBe("sendTimeContext");
    }
    await sendViaConnection(
      transport,
      (result as { kind: "fixed"; connection: ConnectionLike }).connection,
      { jsonrpc: "2.0", id: 1, result: { from: "B" } },
      1
    );

    // Each response went to its own connection — no cross-routing.
    expect(writeSSEEvent).toHaveBeenCalledTimes(2);
    const [connFirst, msgFirst] = writeSSEEvent.mock.calls[0];
    const [connSecond, msgSecond] = writeSSEEvent.mock.calls[1];
    expect((connFirst as ConnectionLike).id).toBe("cA");
    expect((msgFirst as { result: { from: string } }).result.from).toBe("A");
    expect((connSecond as ConnectionLike).id).toBe("cB");
    expect((msgSecond as { result: { from: string } }).result.from).toBe("B");
  });

  it("K19 fallback: concurrent intakes survive ALS loss when sends interleave with intake consumption", async () => {
    // ALS may be lost on some SDK paths (queued / buffered onmessage).
    // In that case sendTimeConnectionId is undefined and we rely solely
    // on the intake set. The set's intersection with the current matches
    // disambiguates ONLY when the other concurrent intake has already
    // been consumed by its own send. Realistic interleaving:
    //
    //   T=0: intake A — set = {cA}
    //   T=1: intake B — set = {cA, cB}
    //   T=2: send A (ALS lost) — set still {cA, cB}: ambiguous, refuse.
    //
    // This is the residual case the K19 fix doesn't fully close — it
    // remains a "refuse rather than misroute" outcome. The caller sees a
    // loud error and can retry. Importantly, the pre-K19 code would
    // silently misroute here; the K19 fix at minimum turns silent
    // corruption into a deterministic error.
    const cA = conn("cA", [1]);
    const cB = conn("cB", [1]);
    const intake = new Map<unknown, Set<string>>();
    intake.set(1, new Set(["cA", "cB"]));

    const result = decideSendRouting([cA, cB], 1, {
      intakeConnectionIds: intake.get(1),
    });
    expect(result.kind).toBe("ambiguous");

    // Now the alternate timeline where B's send fires first (its intake
    // consumed), then A's send fires alone with the set holding only cA.
    // This is now disambiguable via intakeIntersection.
    intake.get(1)!.delete("cB");
    const second = decideSendRouting([cA, cB], 1, {
      intakeConnectionIds: intake.get(1),
    });
    expect(second.kind).toBe("fixed");
    if (second.kind === "fixed") {
      expect(second.connection.id).toBe("cA");
      expect(second.via).toBe("intakeIntersection");
    }
  });

  it("refuses to send when collision is detected with no signals at all", () => {
    // The defensive-failure path. If somehow we end up at send with a
    // collision and neither signal disambiguates, the caller must see a
    // loud error rather than a silent wrong-shape response.
    const cA = conn("cA", [1]);
    const cB = conn("cB", [1]);
    const result = decideSendRouting([cA, cB], 1, {});
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matchedIds).toContain("cA");
      expect(result.matchedIds).toContain("cB");
    }
  });
});
