/**
 * OPE-1635 — the CI backtest gate for feed inclusion rules.
 *
 * A change to `feeds/inclusion.ts` (or the matcher) is replayed over a LABELLED
 * corpus of real feed items. The gate fails when a labelled item's verdict
 * changes the wrong way — a new wrong verdict — not on the four the current
 * rules already get wrong (`known_violations`), which would make it red on main
 * before anyone changed anything.
 *
 * Corpus: the OPE-1629 TEC fixture (OHTM, Marshfield, Saco, Gurley — 11-11
 * reads), labelled by feed + TEC id, plus real Boothbay snapshots from prod and
 * one item marked SYNTHETIC (no real fair is in any feed yet).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapTecEvent, type FeedEvent } from "../feeds/feed-event";
import { DEFAULT_INCLUSION_RULES, type FeedInclusionRules } from "../feeds/inclusion";
import {
  backtestInclusion,
  labelViolations,
  PRE_OPE1629_INCLUSION_RULES,
  type CorpusItem,
} from "../feeds/backtest";

const fixture = <T>(name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as T;

const TEC = fixture<{ feeds: Record<string, Array<Record<string, unknown>>> }>(
  "ope1629-tec-feeds-2026-11-11.json"
);
const LABELLED = fixture<{
  labels: Array<{ feed: string; external_id: string; label: string; source: string }>;
  items: Array<{ feed: string; label: string; source: string; event: FeedEvent }>;
  known_violations: { ids: string[] };
}>("ope1635-labelled-corpus.json");

/** The corpus exactly as the gate replays it. Exported shape mirrors the D1 loader's. */
function buildCorpus(): CorpusItem[] {
  const labelFor = new Map(LABELLED.labels.map((l) => [`${l.feed}:${l.external_id}`, l.label]));
  const out: CorpusItem[] = [];
  for (const [feed, raw] of Object.entries(TEC.feeds)) {
    for (const r of raw) {
      const ev = mapTecEvent(r);
      if (!ev) continue;
      const id = `${feed}:${ev.externalId}`;
      const label = labelFor.get(id);
      out.push({
        itemId: id,
        feedId: feed,
        version: "latest",
        event: ev,
        campsWorkshopsOptIn: false,
        labels: label ? [{ label, at: 0 }] : [],
      });
    }
  }
  for (const it of LABELLED.items) {
    out.push({
      itemId: `${it.feed}:${it.event.externalId}`,
      feedId: it.feed,
      version: "latest",
      event: it.event,
      campsWorkshopsOptIn: false,
      labels: [{ label: it.label, at: 0 }],
    });
  }
  return out;
}

const rules = (r: FeedInclusionRules) => ({ rulesFor: () => r });
const CURRENT = rules(DEFAULT_INCLUSION_RULES);
const corpus = buildCorpus();
const violations = (r: FeedInclusionRules) =>
  labelViolations(corpus, rules(r))
    .map((v) => v.item_id)
    .sort();

describe("OPE-1635 — CI backtest gate: the labelled corpus", () => {
  it("is the corpus it claims to be (positive landmark)", () => {
    // 46 TEC items + 12 copied; every one labelled. If a fixture stops loading,
    // this goes red instead of the gate reading "no violations".
    expect(corpus).toHaveLength(58);
    expect(corpus.filter((c) => c.labels.length)).toHaveLength(58);
    expect(LABELLED.labels.every((l) => l.source.length > 0)).toBe(true);
    expect(LABELLED.items.every((l) => l.source.length > 0)).toBe(true);
  });

  it("GATE: the default rules get exactly the known violations wrong — no new wrong verdict", () => {
    const got = violations(DEFAULT_INCLUSION_RULES);
    const known = [...LABELLED.known_violations.ids].sort();
    const fresh = got.filter((id) => !known.includes(id));
    const fixed = known.filter((id) => !got.includes(id));
    expect(
      fresh,
      `labelled items the changed rules now get WRONG (fix the rule, or — only if the label is wrong — fix the label): ${fresh.join(", ")}`
    ).toEqual([]);
    expect(
      fixed,
      `known violations the rules now get RIGHT — delete them from known_violations in ope1635-labelled-corpus.json: ${fixed.join(", ")}`
    ).toEqual([]);
  });
});

describe("OPE-1635 — the gate fails on a deliberately bad rule (acceptance 2)", () => {
  it("a rule that drops `fair` flips the labelled fair the wrong way", () => {
    const bad = {
      ...DEFAULT_INCLUSION_RULES,
      excludeTitlePatterns: [...DEFAULT_INCLUSION_RULES.excludeTitlePatterns, "\\bfair\\b"],
    };
    const bt = backtestInclusion(corpus, CURRENT, rules(bad));
    expect(bt.wrong_way.map((f) => f.item_id)).toEqual(["synthetic:synthetic-fair-1"]);
    // …and the gate's own check sees it as a NEW violation.
    expect(violations(bad)).toContain("synthetic:synthetic-fair-1");
  });

  it("a rule that drops `show` flips Gurley's real, approved antique shows the wrong way", () => {
    // At closure level: a title include (`show`) beats a PROGRAM pattern, so a
    // program-level `show` could never drop a show — only this level can.
    const bad = {
      ...DEFAULT_INCLUSION_RULES,
      excludeTitlePatterns: [...DEFAULT_INCLUSION_RULES.excludeTitlePatterns, "\\bshows?\\b"],
    };
    const bt = backtestInclusion(corpus, CURRENT, rules(bad));
    const wrong = bt.wrong_way.map((f) => f.title);
    expect(wrong.length).toBeGreaterThanOrEqual(3);
    expect(wrong.every((t) => /show/i.test(t))).toBe(true);
    expect(bt.wrong_way.every((f) => f.expected === "keep" && !f.after.included)).toBe(true);
  });
});

describe("OPE-1635 — replaying OPE-1629's fix (acceptance 1)", () => {
  const PRE = { ...DEFAULT_INCLUSION_RULES, ...PRE_OPE1629_INCLUSION_RULES };
  const bt = backtestInclusion(corpus, rules(PRE), CURRENT);

  it("moves Marshfield's 7 Indoor Farmers' Markets (and Saco's market) to included", () => {
    const toInc = bt.to_included.map((f) => `${f.feed_id}:${f.title}`);
    expect(toInc.filter((t) => t.startsWith("marsh:"))).toHaveLength(7);
    expect(toInc).toContain("saco:Main Street Market");
    expect(toInc).toHaveLength(8);
    for (const f of bt.to_included) {
      expect(f.before.rule).toBe("program_description:\\bkids?\\b");
      expect(f.after.rule).toBe("include_title:market");
      // These were labelled keep: the fix is RIGHT-way on every one.
      expect(f.expected).toBe("keep");
      expect(f.wrong_way).toBe(false);
    }
  });

  it("keeps OHTM's kids' STEM programs dropped, and flips nothing to dropped", () => {
    expect(bt.to_dropped).toEqual([]);
    expect(bt.to_included.some((f) => f.feed_id === "ohtm")).toBe(false);
    const ohtmStem = corpus.filter((c) => c.feedId === "ohtm" && /\bstem\b/i.test(c.event.title));
    expect(ohtmStem.length).toBeGreaterThanOrEqual(3); // landmark: there ARE STEM items to keep dropped
  });

  it("raises the estimated false-drop rate's complement: fewer labelled keeps dropped after the fix", () => {
    expect(bt.before.false_drop_rate.numerator).toBe(8);
    expect(bt.after.false_drop_rate.numerator).toBe(0);
  });
});
