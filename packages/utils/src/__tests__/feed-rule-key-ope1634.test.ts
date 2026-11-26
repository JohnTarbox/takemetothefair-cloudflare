/**
 * OPE-1634 — the rule key per-rule precision and the drop sample count by.
 * The guard that matters: every reason decideInclusion can produce maps to a
 * KNOWN key, never `other:` — measured over the real 2026-11-11 reads, so a
 * reworded reason string breaks this test instead of silently opening a new
 * bucket in the metrics.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapTecEvent, type FeedEvent } from "../feeds/feed-event";
import {
  DEFAULT_INCLUSION_RULES,
  decideInclusion,
  inclusionRuleKey,
  matchedSnippet,
} from "../feeds/inclusion";

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures/ope1629-tec-feeds-2026-11-11.json"), "utf8")
) as { feeds: Record<string, Record<string, unknown>[]> };

describe("inclusionRuleKey", () => {
  it("maps every reason the real 11-11 reads produce to a known key", () => {
    const reasons = new Set<string>();
    for (const feed of Object.values(FIXTURE.feeds))
      for (const r of feed) {
        const ev = mapTecEvent(r);
        if (!ev) continue;
        reasons.add(decideInclusion(ev, DEFAULT_INCLUSION_RULES).reason);
        reasons.add(
          decideInclusion(ev, DEFAULT_INCLUSION_RULES, { campsWorkshopsOptIn: true }).reason
        );
      }
    expect(reasons.size).toBeGreaterThan(4); // positive landmark: several distinct rules fired
    for (const r of reasons) expect(inclusionRuleKey(r), r).not.toMatch(/^other:/);
  });

  it("keys", () => {
    expect(inclusionRuleKey("title matches closure /\\[closed\\]/")).toBe("closure:\\[closed\\]");
    expect(inclusionRuleKey("title matches /market/")).toBe("include_title:market");
    expect(inclusionRuleKey("program title matches /\\bstem\\b/")).toBe("program_title:\\bstem\\b");
    expect(inclusionRuleKey("program description matches /\\bkids?\\b/ and /\\bages? \\d/")).toBe(
      "program_description:\\bkids?\\b"
    );
    expect(inclusionRuleKey("organizer education@ohtm.org is excluded")).toBe(
      "organizer:education@ohtm.org"
    );
    expect(inclusionRuleKey('camp/workshop opt-in: category "Camps"')).toBe("camp_opt_in:category");
    expect(inclusionRuleKey("multi-day event")).toBe("multi_day");
    expect(inclusionRuleKey("default include")).toBe("default_include");
    expect(inclusionRuleKey("something new")).toBe("other:something new");
    expect(inclusionRuleKey(null)).toBeNull();
  });
});

describe("matchedSnippet", () => {
  const ev = (o: Partial<FeedEvent>) =>
    ({ title: "Indoor Farmers' Market", description: "", organizerEmails: [], ...o }) as FeedEvent;
  it("clips the text around the match, title first", () => {
    const d =
      "~20 local farmers, chefs, artisans. Always free talks, live music, and kids activities. Rain or shine.";
    expect(
      matchedSnippet(
        ev({ description: d }),
        "program description matches /\\bkids?\\b/ and /x/",
        20
      )
    ).toBe("…ks, live music, and kids activities. Rain or…");
    expect(
      matchedSnippet(ev({ title: "Junior Inventors" }), "program title matches /\\bjunior\\b/")
    ).toBe("Junior Inventors");
  });
  it("organizer → the address; default / bad pattern → null", () => {
    expect(matchedSnippet(ev({}), "organizer education@ohtm.org is excluded")).toBe(
      "education@ohtm.org"
    );
    expect(matchedSnippet(ev({}), "default include")).toBeNull();
    expect(matchedSnippet(ev({}), "title matches /([/")).toBeNull();
  });
});
