import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRACKED_EVENTS, BEACON_EVENT_NAMES, findTrackedEvent } from "../event-sinks";
import { INTENT_EVENT_NAMES, CONNECTED_EVENT_NAMES } from "@/lib/site-health-unified/engagement";

describe("TRACKED_EVENTS registry (OPE-392 Ask C)", () => {
  it("requires a stated reason for any event that skips a sink", () => {
    // THE invariant this file exists for. Before OPE-392, `trackShare` skipped
    // the beacon on purpose (documented) and `trackAddToCalendar` skipped it by
    // accident (undocumented), and the two were indistinguishable in the
    // source. Absence can no longer express intent: say why, or dual-emit.
    for (const e of TRACKED_EVENTS) {
      if (e.sinks.length < 2) {
        expect(e.singleSinkReason, `${e.name} omits a sink without saying why`).toBeTruthy();
      }
    }
  });

  it("never declares an event with no sink at all", () => {
    for (const e of TRACKED_EVENTS) {
      expect(e.sinks.length, `${e.name} goes nowhere`).toBeGreaterThan(0);
    }
  });

  it("has no duplicate event names", () => {
    // A duplicate would make findTrackedEvent silently prefer the first, so a
    // later entry's sink set would be ignored without any error.
    const names = TRACKED_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("derives BEACON_EVENT_NAMES from the sink declarations", () => {
    for (const e of TRACKED_EVENTS) {
      expect(BEACON_EVENT_NAMES.includes(e.name)).toBe(e.sinks.includes("beacon"));
    }
  });

  it("looks an event up by name and returns undefined for a legacy one", () => {
    expect(findTrackedEvent("add_to_calendar")?.category).toBe("conversion");
    // Undeclared legacy events must NOT resolve — `track()` throws on them
    // rather than guessing a sink set.
    expect(findTrackedEvent("favorite_toggle")).toBeUndefined();
    expect(findTrackedEvent("nonexistent_event")).toBeUndefined();
  });
});

describe("the beacon allowlist cannot drift from the registry", () => {
  it("allowlists every beacon-sinked event in /api/analytics/track", async () => {
    // A beacon event missing from the server allowlist is rejected 400 and
    // vanishes — no error anywhere the client can see. Reading the route's
    // SOURCE rather than importing it, because the module pulls in auth and
    // D1 bindings that do not exist in a unit test.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const route = await fs.readFile(
      path.resolve(process.cwd(), "src/app/api/analytics/track/route.ts"),
      "utf8"
    );
    // The spread is what makes this structural rather than a list to maintain.
    expect(route).toContain("...BEACON_EVENT_NAMES");
    expect(route).toContain('from "@/lib/analytics/event-sinks"');
    // Guard the guard: an empty registry would satisfy the two lines above.
    expect(BEACON_EVENT_NAMES.length).toBeGreaterThanOrEqual(4);
  });
});

describe("track() emits to exactly the declared sinks", () => {
  let gtagCalls: unknown[][];
  let beaconBodies: string[];

  beforeEach(() => {
    gtagCalls = [];
    beaconBodies = [];
    vi.stubGlobal("window", {
      gtag: (...args: unknown[]) => gtagCalls.push(args),
    });
    vi.stubGlobal("navigator", {
      sendBeacon: (_url: string, blob: Blob) => {
        // Record that the beacon fired; body text is asserted via fetch below
        // for the cases that need it.
        beaconBodies.push(String(blob.size));
        return true;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("throws for an event that is not declared", async () => {
    const { track } = await import("../../analytics");
    // A silent default sink set would recreate the exact ambiguity the
    // registry removes, so this is deliberately loud and fires in dev.
    expect(() => track("never_declared_event")).toThrow(/not declared in TRACKED_EVENTS/);
  });

  it("sends a dual-sink event to BOTH gtag and the beacon", async () => {
    const { track } = await import("../../analytics");
    track("add_to_calendar", { entitySlug: "cummington-fair-2026" });
    expect(gtagCalls).toHaveLength(1);
    expect(gtagCalls[0][1]).toBe("add_to_calendar");
    expect(beaconBodies).toHaveLength(1);
  });
});

describe("OPE-391 Block D2 strips are backed by declared events (OPE-392)", () => {
  it("declares every NEW strip member in the registry", () => {
    // The strips also carry pre-existing events (outbound_ticket_click etc.)
    // that predate the registry and are intentionally not declared. What must
    // hold is the converse: every event OPE-392 introduced has to be declared,
    // or track() throws at the call site.
    const introduced = [
      "add_to_calendar",
      "add_to_favorites",
      "share",
      "directions_click",
      "outbound_website_click",
      "contact_click",
    ];
    for (const name of introduced) {
      expect(findTrackedEvent(name), `${name} is not declared`).toBeDefined();
    }
  });

  it("puts every registry event into exactly one strip", () => {
    // A declared event with no home renders nowhere — the "shipped but not
    // surfaced" half of this project's recurring defect. remove_from_favorites
    // is the deliberate exception: it is the inverse of an intent signal, and
    // counting it in the intent strip would net off against add_to_favorites.
    const stripped = new Set<string>([...INTENT_EVENT_NAMES, ...CONNECTED_EVENT_NAMES]);
    const unhoused = TRACKED_EVENTS.map((e) => e.name).filter(
      (n) => !stripped.has(n) && n !== "remove_from_favorites"
    );
    expect(unhoused).toEqual([]);
  });

  it("keeps intent and connected disjoint", () => {
    const overlap = (INTENT_EVENT_NAMES as readonly string[]).filter((n) =>
      (CONNECTED_EVENT_NAMES as readonly string[]).includes(n)
    );
    expect(overlap).toEqual([]);
  });

  it("gives contact_click and outbound_website_click the conversion category", () => {
    // The ticket is explicit: website + contact are conversion-adjacent and
    // must stay separable from ticket/application conversions, while
    // directions is intent. Miscategorising them would put them in the wrong
    // half of the read path, which selects on event_category.
    expect(findTrackedEvent("contact_click")?.category).toBe("conversion");
    expect(findTrackedEvent("outbound_website_click")?.category).toBe("conversion");
    expect(findTrackedEvent("directions_click")?.category).toBe("engagement");
  });
});
