/**
 * OPE-831 — the vendor profile form says what a blank state costs, and says it
 * for exactly the values that actually cost it.
 *
 * 13 of 94 real claimed vendors (prod, 2026-09-07) saved this form and left
 * `state` blank. The form was silent about the consequence: `groupByState`
 * drops them from every /vendors/browse/state/[state] page.
 *
 * ⚠️ The load-bearing test is the DRIFT one at the bottom. Testing
 * `isBrowseStateCode` alone would have been decorative — it would stay green if
 * someone rewrote the render condition to a bare blank check, which is exactly
 * the regression worth catching. So these render the real component and compare
 * its output against the real grouper.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StateBrowseHint } from "../state-browse-hint";
import { groupByState, type BrowseEntry } from "@/lib/browse/directory";

const HINT = "state-browse-hint";

function hintShownFor(state: string): boolean {
  cleanup();
  render(<StateBrowseHint state={state} onUseLookup={() => {}} />);
  return screen.queryByTestId(HINT) !== null;
}

/** Would the real grouper put a vendor with this state on a browse page? */
function reachesBrowse(state: string): boolean {
  const entry: BrowseEntry = { slug: "s", name: "Vendor", state };
  let total = 0;
  for (const list of groupByState([entry]).values()) total += list.length;
  return total > 0;
}

describe("OPE-831 — StateBrowseHint", () => {
  it("says nothing when the state is a real US code", () => {
    expect(hintShownFor("ME")).toBe(false);
    expect(hintShownFor("ma")).toBe(false);
    expect(hintShownFor(" VT ")).toBe(false);
  });

  it("warns on a blank state, naming the consequence rather than the rule", () => {
    cleanup();
    render(<StateBrowseHint state="" onUseLookup={() => {}} />);
    const el = screen.getByTestId(HINT);
    expect(el.textContent).toContain("won’t appear on the by-state browse pages");
    // The remedy that already exists but is collapsed by default.
    expect(el.textContent).toContain("Find my business on Google");
  });

  it("warns on a NON-BLANK but unrecognised code, quoting what was typed", () => {
    // The case a blank-only check misses while looking entirely correct: the
    // field is filled in, so nothing looks wrong, and browse still drops them.
    cleanup();
    render(<StateBrowseHint state="Maine" onUseLookup={() => {}} />);
    expect(screen.getByTestId(HINT).textContent).toContain("“Maine” isn’t a US state code");
  });

  it("the lookup button reveals the collapsed Google search", () => {
    const onUseLookup = vi.fn();
    cleanup();
    render(<StateBrowseHint state="" onUseLookup={onUseLookup} />);
    screen.getByRole("button", { name: /Find my business on Google/ }).click();
    expect(onUseLookup).toHaveBeenCalledTimes(1);
  });

  it("does not block: it renders a <p>, never a required field or an error", () => {
    cleanup();
    const { container } = render(<StateBrowseHint state="" onUseLookup={() => {}} />);
    // Whether location is REQUIRED is an open product question on this ticket.
    // If someone answers it by making the field required, that is a deliberate
    // decision — not something this hint should smuggle in.
    expect(container.querySelector("[required]")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });
});

describe("OPE-831 — the warning and the grouper cannot drift apart", () => {
  it("shows the hint for EXACTLY the states groupByState drops", () => {
    const corpus = [
      // reachable
      "ME",
      "MA",
      "ma",
      " VT ",
      "NH",
      "CT",
      "DC",
      "PR",
      "AK",
      "HI",
      // dropped
      "",
      "   ",
      "Maine",
      "XX",
      "M",
      "MEE",
      "N/A",
      "USA",
      "99",
      "-",
    ];

    const disagreements = corpus.filter((s) => hintShownFor(s) !== !reachesBrowse(s));

    // Positive landmark beside the negative assertion (OPE-6 v3.8 obligation 2):
    // "no disagreements" means nothing unless the corpus was actually examined,
    // and unless BOTH outcomes occur in it. A corpus that is all-reachable would
    // pass this vacuously.
    expect(corpus.length).toBe(20);
    expect(corpus.filter(reachesBrowse).length).toBe(10);
    expect(corpus.filter((s) => !reachesBrowse(s)).length).toBe(10);
    expect(disagreements).toEqual([]);
  });
});
