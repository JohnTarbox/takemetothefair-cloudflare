/**
 * OPE-1573 — a malformed ?page= on /events/past must 404 WITHOUT querying D1.
 *
 * The 2026-11-13 04:19Z D1 "Requests queued for too long" burst was ~100
 * scanner renders of /events/past?page=<SQLi payload>: each one ran the full
 * list + count + vendor + event_days queries because parseInt() read the
 * payload as page 2.
 *
 * Amendment H: "404s and never touches D1" is also what a page that 404s for
 * EVERY request would do, so the valid-page case on the same mock proves the
 * page still renders and still reaches D1.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let dbCalls = 0;

// A chainable query-builder stand-in: every method returns the chain, and
// awaiting it yields []. Enough for the list, count and batch queries.
function chain(): unknown {
  const target = () => {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown[]) => void) => resolve([]);
      }
      return () => chain();
    },
  });
}

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => {
    dbCalls += 1;
    return chain();
  },
}));
vi.mock("@/lib/event-days-attach", () => ({
  attachEventDayDates: async (_db: unknown, rows: unknown[]) => rows,
}));
vi.mock("@/components/events/events-view", () => ({ EventsView: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const mod = await import("../page");
const Page = mod.default as (p: {
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;

const render = (page?: string) => Page({ searchParams: Promise.resolve({ page }) });

beforeEach(() => {
  dbCalls = 0;
});

describe("/events/past ?page= guard (OPE-1573)", () => {
  it.each([
    "2') AND EXTRACTVALUE(9953,CONCAT(0x7e,((SELECT (ELT(9953=9953,1)))),0x7e))-- -",
    "-2 UNION ALL SELECT NULL,'njoetjfdvobmbycdxqgynebenrqwyscg'-- uvyy8r",
    "0",
    "abc",
  ])("%j → 404 with zero D1 calls", async (raw) => {
    await expect(render(raw)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(dbCalls).toBe(0);
  });

  it.each([undefined, "1", "3"])("valid page %j → renders and queries D1", async (raw) => {
    await expect(render(raw)).resolves.toBeTruthy();
    expect(dbCalls).toBeGreaterThan(0);
  });
});
