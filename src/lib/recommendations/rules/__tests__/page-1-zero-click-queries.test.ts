/**
 * Tests for page_1_zero_click_queries recommendation rule (analyst
 * Item 2, 2026-05-30). Mocks the GSC API call + slug-history resolver
 * so we can assert the filter pipeline matches the spec:
 *   - position ≤ 10
 *   - clicks === 0
 *   - impressions ≥ 10
 *
 * Cases focus on boundary values + sort order. Slug resolution is
 * a separate concern tested elsewhere; we stub it to a passthrough.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: vi.fn(() => ({})),
}));

vi.mock("@/lib/search-console", () => ({
  ScApiError: class extends Error {},
  ScConfigError: class extends Error {},
  getSiteSearchQueries: vi.fn(),
}));

// Path is relative to the rule file's import, not this test's location —
// `../resolve-gsc-path` from src/lib/recommendations/rules/page-1-zero-
// click-queries.ts resolves to src/lib/recommendations/resolve-gsc-path.
vi.mock("../../resolve-gsc-path", () => ({
  resolveGscPath: vi.fn(async (_db: unknown, path: string | null) => ({
    path,
    status: "valid" as const,
  })),
}));

import { page1ZeroClickQueriesRule } from "../page-1-zero-click-queries";
import { getSiteSearchQueries } from "@/lib/search-console";

const MOCK_DB = {} as unknown as Parameters<typeof page1ZeroClickQueriesRule.run>[0];

function gsc(
  overrides: Partial<{
    query: string;
    clicks: number;
    impressions: number;
    position: number;
    ctr: number;
    topPages: Array<{ path: string; impressions: number }>;
  }> = {}
) {
  return {
    query: overrides.query ?? "q",
    clicks: overrides.clicks ?? 0,
    impressions: overrides.impressions ?? 50,
    position: overrides.position ?? 5,
    ctr: overrides.ctr ?? 0,
    topPages: overrides.topPages ?? [{ path: "/events/test", impressions: 50 }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("page_1_zero_click_queries — filter contract", () => {
  it("matches position ≤ 10, clicks = 0, impressions ≥ 10", async () => {
    vi.mocked(getSiteSearchQueries).mockResolvedValue({
      queries: [
        gsc({ query: "perfect", position: 8, clicks: 0, impressions: 82 }),
        gsc({ query: "boundary-pos", position: 10, clicks: 0, impressions: 50 }),
        gsc({ query: "boundary-impressions", position: 5, clicks: 0, impressions: 10 }),
      ],
      totals: { clicks: 0, impressions: 0 },
    } as unknown as Awaited<ReturnType<typeof getSiteSearchQueries>>);
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.targetId)).toEqual([
      "perfect",
      "boundary-pos",
      "boundary-impressions",
    ]);
  });

  it("excludes queries with position > 10 (off page 1)", async () => {
    vi.mocked(getSiteSearchQueries).mockResolvedValue({
      queries: [gsc({ query: "page-2", position: 11, clicks: 0, impressions: 100 })],
      totals: { clicks: 0, impressions: 0 },
    } as unknown as Awaited<ReturnType<typeof getSiteSearchQueries>>);
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toHaveLength(0);
  });

  it("excludes queries with any clicks (the rule is ZERO-click specifically)", async () => {
    vi.mocked(getSiteSearchQueries).mockResolvedValue({
      queries: [
        gsc({ query: "one-click", position: 5, clicks: 1, impressions: 100 }),
        gsc({ query: "two-clicks", position: 5, clicks: 2, impressions: 100 }),
      ],
      totals: { clicks: 3, impressions: 200 },
    } as unknown as Awaited<ReturnType<typeof getSiteSearchQueries>>);
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toHaveLength(0);
  });

  it("excludes queries below the 10-impression noise floor", async () => {
    vi.mocked(getSiteSearchQueries).mockResolvedValue({
      queries: [
        gsc({ query: "too-quiet", position: 5, clicks: 0, impressions: 9 }),
        gsc({ query: "way-too-quiet", position: 5, clicks: 0, impressions: 1 }),
      ],
      totals: { clicks: 0, impressions: 10 },
    } as unknown as Awaited<ReturnType<typeof getSiteSearchQueries>>);
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toHaveLength(0);
  });

  it("sorts matches by impressions descending", async () => {
    vi.mocked(getSiteSearchQueries).mockResolvedValue({
      queries: [
        gsc({ query: "small", position: 5, clicks: 0, impressions: 15 }),
        gsc({ query: "big", position: 5, clicks: 0, impressions: 82 }),
        gsc({ query: "medium", position: 5, clicks: 0, impressions: 40 }),
      ],
      totals: { clicks: 0, impressions: 137 },
    } as unknown as Awaited<ReturnType<typeof getSiteSearchQueries>>);
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches.map((m) => m.targetId)).toEqual(["big", "medium", "small"]);
  });

  it("caps at 50 matches", async () => {
    vi.mocked(getSiteSearchQueries).mockResolvedValue({
      queries: Array.from({ length: 80 }, (_, i) =>
        gsc({ query: `q-${i}`, position: 5, clicks: 0, impressions: 100 - i })
      ),
      totals: { clicks: 0, impressions: 0 },
    } as unknown as Awaited<ReturnType<typeof getSiteSearchQueries>>);
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toHaveLength(50);
  });

  it("returns empty list on GSC config error (no autoResolve clobber)", async () => {
    const { ScConfigError } = await import("@/lib/search-console");
    vi.mocked(getSiteSearchQueries).mockRejectedValue(new ScConfigError("no creds"));
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toEqual([]);
  });

  it("returns empty list on GSC API error", async () => {
    const { ScApiError } = await import("@/lib/search-console");
    vi.mocked(getSiteSearchQueries).mockRejectedValue(new ScApiError("rate-limited"));
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toEqual([]);
  });

  it("rethrows non-GSC errors so the engine catches them", async () => {
    vi.mocked(getSiteSearchQueries).mockRejectedValue(new Error("internal"));
    await expect(page1ZeroClickQueriesRule.run(MOCK_DB)).rejects.toThrow("internal");
  });
});

describe("page_1_zero_click_queries — payload shape", () => {
  it("includes query, impressions, clicks=0, position, action, target URL", async () => {
    vi.mocked(getSiteSearchQueries).mockResolvedValue({
      queries: [
        gsc({
          query: "Charlestown Seafood Festival 2026",
          position: 8.2,
          clicks: 0,
          impressions: 82,
          topPages: [{ path: "/events/charlestown-seafood-festival-2026", impressions: 82 }],
        }),
      ],
      totals: { clicks: 0, impressions: 82 },
    } as unknown as Awaited<ReturnType<typeof getSiteSearchQueries>>);
    const matches = await page1ZeroClickQueriesRule.run(MOCK_DB);
    expect(matches).toHaveLength(1);
    const p = matches[0].payload as Record<string, unknown>;
    expect(p.query).toBe("Charlestown Seafood Festival 2026");
    expect(p.impressions).toBe(82);
    expect(p.clicks).toBe(0);
    expect(p.ctr).toBe(0);
    expect(p.position).toBe(8.2);
    expect(p.topPagePath).toBe("/events/charlestown-seafood-festival-2026");
    expect(p.suggestedAction).toBe("Rewrite title and meta description");
  });
});
