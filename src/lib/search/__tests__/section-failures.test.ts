/**
 * OPE-549 item 4 — the copy shown when a search section fails.
 *
 * Small surface, but it is the only thing standing between a broken query and
 * "No results found". The LIKE-pattern family ran for a month across five call
 * sites partly because a failed section was indistinguishable from an honest
 * zero, and nobody reports a search that politely finds nothing.
 */
import { describe, it, expect } from "vitest";
import { formatSectionList } from "../section-failures";

describe("formatSectionList", () => {
  it("renders one section bare", () => {
    expect(formatSectionList(["events"])).toBe("events");
  });

  it("joins two with 'and', not a comma", () => {
    expect(formatSectionList(["events", "venues"])).toBe("events and venues");
  });

  it("joins three or more with commas and a final 'and'", () => {
    expect(formatSectionList(["events", "venues", "blog posts"])).toBe(
      "events, venues and blog posts"
    );
    expect(formatSectionList(["events", "venues", "vendors", "blog posts"])).toBe(
      "events, venues, vendors and blog posts"
    );
  });

  it("returns an empty string for no sections rather than 'undefined'", () => {
    // A caller that forgets to guard renders nothing, not a broken sentence.
    expect(formatSectionList([])).toBe("");
  });

  it("reads correctly inside the sentence it was written for", () => {
    // The whole point of extracting this: the copy is on an error path, which
    // is the copy least likely to be read again before a user sees it.
    const sentence = `We could not search ${formatSectionList(["events", "vendors"])} just now.`;
    expect(sentence).toBe("We could not search events and vendors just now.");
  });
});
