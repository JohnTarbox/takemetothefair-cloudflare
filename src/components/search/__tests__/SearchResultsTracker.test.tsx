/**
 * OPE-248 — the /search page must emit `view_search_results` WITH
 * `results_count`, and 0 is the case the whole ticket exists for: a
 * zero-result query is a user telling us what we're missing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SearchResultsTracker } from "../SearchResultsTracker";

const trackSearchResults = vi.fn();
vi.mock("@/lib/analytics", () => ({
  trackSearchResults: (...args: unknown[]) => trackSearchResults(...args),
}));

describe("SearchResultsTracker (OPE-248)", () => {
  beforeEach(() => {
    trackSearchResults.mockClear();
    cleanup();
  });

  it("emits the query and its result count", () => {
    render(<SearchResultsTracker query="fryeburg" resultsCount={7} />);
    expect(trackSearchResults).toHaveBeenCalledWith("fryeburg", 7);
  });

  it("emits ZERO results — the case zero-result detection depends on", () => {
    render(<SearchResultsTracker query="zzzqqq" resultsCount={0} />);
    // Not `toHaveBeenCalled()` — a falsy-count guard would silently skip 0 and
    // reintroduce exactly the blindness this fixes.
    expect(trackSearchResults).toHaveBeenCalledWith("zzzqqq", 0);
  });

  it("renders nothing (drops into a Server Component page)", () => {
    const { container } = render(<SearchResultsTracker query="a" resultsCount={1} />);
    expect(container.innerHTML).toBe("");
  });

  it("does not re-emit for the same query on re-render", () => {
    const { rerender } = render(<SearchResultsTracker query="fair" resultsCount={3} />);
    rerender(<SearchResultsTracker query="fair" resultsCount={3} />);
    expect(trackSearchResults).toHaveBeenCalledTimes(1);
  });

  it("emits again when the query changes", () => {
    const { rerender } = render(<SearchResultsTracker query="fair" resultsCount={3} />);
    rerender(<SearchResultsTracker query="craft" resultsCount={0} />);
    expect(trackSearchResults).toHaveBeenCalledTimes(2);
    expect(trackSearchResults).toHaveBeenLastCalledWith("craft", 0);
  });
});
