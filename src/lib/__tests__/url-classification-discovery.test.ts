import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUnclassifiedOutboundDestinations } from "../url-classification-discovery";

// The function under test runs two Drizzle queries:
//   1. select(properties).from(analyticsEvents).where(...)
//   2. select(domain).from(urlDomainClassifications)
//
// We model this as a queue of "result sets" — each terminal step
// (`.where()` for query 1, `.from()` for query 2) drains one entry.
//
// This is more flexible than two distinct mock chains and keeps each
// test's setup local to that test.

const queryResults: Array<unknown[]> = [];

// Cast to `any` so the line-39 `typeof fakeDb.where` reference (deep in the
// chain-mock thenable below) typechecks. Test mocks that need both sync chain
// access and async-await behavior don't fit cleanly into a static type — this
// is the conventional escape hatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb: any = {
  select: vi.fn(() => fakeDb),
  from: vi.fn(async () => {
    // Query 2 (no .where()) terminates here. If query 1 is in progress,
    // this returns the chain object so .where() can be called next.
    return queryResults.shift() ?? [];
  }),
  where: vi.fn(async () => queryResults.shift() ?? []),
};

// Drizzle's chain semantics need .from() to be sometimes-await-able and
// sometimes-chainable. The tests below pop result sets in the order:
//   [beacons, classifications]
// so that whichever path Drizzle takes, both queries get their data.
//
// The trick: we make from() return a Promise that resolves to the
// next queue entry, AND we make from() return `fakeDb` synchronously
// so .where() chaining still works. We do this by overriding .from()
// to return a thenable that's also chainable.

fakeDb.from = vi.fn(() => {
  // Return a thenable so `await db.select(...).from(table)` resolves
  // to the next queue entry, while still letting callers chain .where().
  const chain: PromiseLike<unknown[]> & { where: typeof fakeDb.where } = {
    then: (onFulfilled, onRejected) => {
      const value = queryResults.shift() ?? [];
      return Promise.resolve(value).then(onFulfilled, onRejected);
    },
    where: vi.fn(async () => queryResults.shift() ?? []),
  };
  return chain;
});

type DbArg = Parameters<typeof getUnclassifiedOutboundDestinations>[0];

describe("getUnclassifiedOutboundDestinations", () => {
  beforeEach(() => {
    queryResults.length = 0;
    vi.clearAllMocks();
  });

  it("returns an empty array when no beacons match", async () => {
    queryResults.push([]); // no beacon rows
    // Second query is short-circuited (function returns early when byDomain is empty)
    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg);
    expect(result).toEqual([]);
  });

  it("skips beacons whose properties JSON is malformed", async () => {
    queryResults.push([
      { properties: "not-valid-json" },
      { properties: '{"destinationUrl":"https://example.com/"}' },
    ]);
    queryResults.push([]); // classifications: nothing classified yet

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 1,
    });

    // Only the well-formed beacon is counted.
    expect(result).toEqual([{ domain: "example.com", clicks: 1, sampleEventSlug: null }]);
  });

  it("skips beacons with null/empty properties", async () => {
    queryResults.push([
      { properties: null },
      { properties: "" },
      { properties: '{"destinationUrl":"https://kept.example/"}' },
    ]);
    queryResults.push([]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("kept.example");
  });

  it("aggregates beacons by domain, summing clicks", async () => {
    queryResults.push([
      { properties: '{"destinationUrl":"https://eventbrite.com/e/1","eventSlug":"event-a"}' },
      { properties: '{"destinationUrl":"https://eventbrite.com/e/2"}' },
      { properties: '{"destinationUrl":"https://www.eventbrite.com/e/3"}' },
    ]);
    queryResults.push([]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      domain: "eventbrite.com",
      clicks: 3,
      sampleEventSlug: "event-a",
    });
  });

  it("accepts both camelCase destinationUrl and legacy snake_case destination_url", async () => {
    queryResults.push([
      { properties: '{"destinationUrl":"https://camel.example/"}' },
      { properties: '{"destination_url":"https://snake.example/"}' },
    ]);
    queryResults.push([]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 1,
    });

    const domains = result.map((r) => r.domain).sort();
    expect(domains).toEqual(["camel.example", "snake.example"]);
  });

  it("excludes domains that are already classified", async () => {
    queryResults.push([
      { properties: '{"destinationUrl":"https://eventbrite.com/e/1"}' },
      { properties: '{"destinationUrl":"https://newcomer.example/"}' },
    ]);
    queryResults.push([{ domain: "eventbrite.com" }]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("newcomer.example");
  });

  it("excludes domains under the minClicks threshold", async () => {
    // Build 5 clicks for popular.example, 2 for niche.example.
    const props = [
      ...Array.from({ length: 5 }, () => ({
        properties: '{"destinationUrl":"https://popular.example/"}',
      })),
      ...Array.from({ length: 2 }, () => ({
        properties: '{"destinationUrl":"https://niche.example/"}',
      })),
    ];
    queryResults.push(props);
    queryResults.push([]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 5,
    });

    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("popular.example");
  });

  it("sorts results by click count descending", async () => {
    queryResults.push([
      ...Array.from({ length: 3 }, () => ({
        properties: '{"destinationUrl":"https://three.example/"}',
      })),
      ...Array.from({ length: 7 }, () => ({
        properties: '{"destinationUrl":"https://seven.example/"}',
      })),
      ...Array.from({ length: 5 }, () => ({
        properties: '{"destinationUrl":"https://five.example/"}',
      })),
    ]);
    queryResults.push([]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 1,
    });

    expect(result.map((r) => r.domain)).toEqual(["seven.example", "five.example", "three.example"]);
  });

  it("skips beacons with no destinationUrl/destination_url field", async () => {
    queryResults.push([
      { properties: '{"eventSlug":"orphan"}' },
      { properties: '{"destinationUrl":"https://valid.example/"}' },
    ]);
    queryResults.push([]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      minClicks: 1,
    });

    expect(result.map((r) => r.domain)).toEqual(["valid.example"]);
  });

  it("respects custom `days` option (only changes the SQL filter, not parsing)", async () => {
    // We can't easily inspect Drizzle's where() arguments, but we can at
    // least confirm the function tolerates the option without throwing
    // and still returns expected shape.
    queryResults.push([{ properties: '{"destinationUrl":"https://valid.example/"}' }]);
    queryResults.push([]);

    const result = await getUnclassifiedOutboundDestinations(fakeDb as DbArg, {
      days: 30,
      minClicks: 1,
    });

    expect(result).toHaveLength(1);
  });
});
