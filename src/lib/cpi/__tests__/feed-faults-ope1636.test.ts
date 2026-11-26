import { describe, expect, it } from "vitest";
import {
  buildFeedFaultFamilies,
  type FeedFaultEvent,
} from "@takemetothefair/db-schema/feed-fault-families";
import { feedFaultActionEntry } from "@/lib/cpi/feed-faults";
import { fingerprintFor, isFileable, reconcileFilings, routeAgentCode } from "@/lib/cpi/auto-file";

const NOW = new Date("2026-11-26T20:00:00Z");
const ev = (family: FeedFaultEvent["family"], at: string): FeedFaultEvent => ({
  family,
  at: new Date(at),
  feedId: "f1",
  ref: at,
});

describe("feed fault families on the CPI rail (OPE-1636)", () => {
  it("no entry below the threshold", () => {
    const r = buildFeedFaultFamilies(
      [
        ev("feed-fetch-failed", "2026-11-20T00:00:00Z"),
        ev("feed-fetch-failed", "2026-11-21T00:00:00Z"),
      ],
      { now: NOW }
    );
    expect(feedFaultActionEntry(r, NOW)).toBeNull();
  });

  it("the top family at the threshold becomes one P1 feed entry, fingerprint cpi:feed:<family>", () => {
    const r = buildFeedFaultFamilies(
      ["2026-11-20", "2026-11-21", "2026-11-22"].map((d) =>
        ev("feed-false-drop", `${d}T00:00:00Z`)
      ),
      { now: NOW }
    );
    const e = feedFaultActionEntry(r, NOW)!;
    expect(e).toMatchObject({
      priority: "P1",
      source: "feed",
      refKey: "feed-false-drop",
      href: "/admin/feed-review",
    });
    expect(fingerprintFor(e)).toBe("cpi:feed:feed-false-drop");
    // First seen 6.8 days ago → past the 72h P1 age gate.
    expect(isFileable(e, NOW)).toBe(true);
    // feed-false-drop's owner is the analyst lane, and reconcile carries it through.
    expect(routeAgentCode(e)).toBe("analyst-claude-desktop");
    const res = reconcileFilings([e], [], NOW);
    expect(res.toFile.map((s) => [s.fingerprint, s.agentCode])).toEqual([
      ["cpi:feed:feed-false-drop", "analyst-claude-desktop"],
    ]);
  });

  it("a family first seen under 72h ago is not fileable yet", () => {
    const r = buildFeedFaultFamilies(
      ["2026-11-25T00:00:00Z", "2026-11-25T06:00:00Z", "2026-11-26T00:00:00Z"].map((d) =>
        ev("feed-fetch-failed", d)
      ),
      { now: NOW }
    );
    expect(isFileable(feedFaultActionEntry(r, NOW)!, NOW)).toBe(false);
  });

  it("routing is unchanged for the existing sources", () => {
    expect(routeAgentCode({ source: "kpi" })).toBe("developer-claude-code");
    expect(routeAgentCode({ source: "heartbeat" })).toBe("developer-claude-code");
    expect(routeAgentCode({ source: "recommendation" })).toBe("analyst-claude-desktop");
    expect(routeAgentCode({ source: "feed", refKey: "feed-fetch-failed" })).toBe(
      "developer-claude-code"
    );
  });
});
