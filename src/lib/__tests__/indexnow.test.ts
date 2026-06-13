import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pingIndexNow, indexNowUrlFor } from "../indexnow";
import { SITE_HOSTNAME } from "@takemetothefair/constants";

// Tests cover:
// - indexNowUrlFor (pure URL builder)
// - pingIndexNow's branches: no key, no eligible URLs, single-URL GET,
//   multi-URL POST, success/failure response handling, network throw,
//   `db === null` short-circuit on the recordSubmission write.
//
// We mock global fetch and provide a minimal fake D1 chain. The fire-and-
// forget contract means pingIndexNow must NEVER throw — every test
// asserts the call resolves cleanly.

interface FakeDb {
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
}

function makeDb(): FakeDb {
  const db: FakeDb = {
    insert: vi.fn(() => db),
    values: vi.fn(async () => undefined),
    delete: vi.fn(() => db),
    where: vi.fn(async () => undefined),
  };
  return db;
}

describe("indexNowUrlFor", () => {
  it("constructs the canonical URL for an event slug", () => {
    expect(indexNowUrlFor("events", "test-event")).toBe(
      `https://${SITE_HOSTNAME}/events/test-event`
    );
  });

  it("constructs the canonical URL for venues, vendors, blog kinds", () => {
    expect(indexNowUrlFor("venues", "v")).toBe(`https://${SITE_HOSTNAME}/venues/v`);
    expect(indexNowUrlFor("vendors", "x")).toBe(`https://${SITE_HOSTNAME}/vendors/x`);
    expect(indexNowUrlFor("blog", "post-1")).toBe(`https://${SITE_HOSTNAME}/blog/post-1`);
  });
});

describe("pingIndexNow", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("missing key", () => {
    it("records 'no_key' and skips the network call when INDEXNOW_KEY is absent", async () => {
      const db = makeDb();
      await pingIndexNow(db as never, [`https://${SITE_HOSTNAME}/events/x`], {}, "test");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalledTimes(1);
      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("no_key");
      expect(row.source).toBe("test");
    });

    it("does not throw when db is null and INDEXNOW_KEY is missing", async () => {
      await expect(
        pingIndexNow(null, [`https://${SITE_HOSTNAME}/events/x`], {}, "test")
      ).resolves.toMatchObject({ ok: false, failureReason: "no_key" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("URL filtering", () => {
    it("filters out URLs that don't match the site hostname", async () => {
      const db = makeDb();
      await pingIndexNow(
        db as never,
        [
          "https://example.com/events/foreign", // wrong host — drop
          `http://${SITE_HOSTNAME}/events/wrong-protocol`, // wrong protocol — drop
          `https://${SITE_HOSTNAME}/events/keep-me`, // keep
        ],
        { INDEXNOW_KEY: "test-key" },
        "test"
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // The submitted URL is percent-encoded into the query string,
      // so we decode the `url` param before asserting the slug.
      const fullUrl = new URL(String(fetchSpy.mock.calls[0][0]));
      const submitted = fullUrl.searchParams.get("url") ?? "";
      expect(submitted).toContain("events/keep-me");
      expect(submitted).not.toContain("foreign");
      expect(submitted).not.toContain("wrong-protocol");
    });

    it("records 'no_eligible_urls' when all URLs are filtered out", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      await pingIndexNow(
        db as never,
        ["https://example.com/x", "https://other.example/y"],
        { INDEXNOW_KEY: "test-key" },
        "test"
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("no_eligible_urls");
      expect(row.urlCount).toBe(0);
    });
  });

  describe("single-URL GET", () => {
    it("issues a GET to the IndexNow endpoint with url, key, keyLocation", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      const url = `https://${SITE_HOSTNAME}/events/single`;

      await pingIndexNow(db as never, url, { INDEXNOW_KEY: "k123" }, "test");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [reqUrl, init] = fetchSpy.mock.calls[0];
      expect(init?.method).toBe("GET");
      const fullUrl = new URL(String(reqUrl));
      expect(fullUrl.origin + fullUrl.pathname).toBe("https://api.indexnow.org/indexnow");
      expect(fullUrl.searchParams.get("url")).toBe(url);
      expect(fullUrl.searchParams.get("key")).toBe("k123");
      expect(fullUrl.searchParams.get("keyLocation")).toBe(`https://${SITE_HOSTNAME}/k123.txt`);
    });

    it("records 'success' for a 200 response", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("success");
      expect(row.httpStatus).toBe(200);
    });

    it("records 'failure' with the body excerpt for a 4xx response", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("Bad request body", { status: 422 }));
      await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("failure");
      expect(row.httpStatus).toBe(422);
      expect(row.errorMessage).toContain("Bad request body");
    });
  });

  describe("multi-URL POST batch", () => {
    it("issues a POST with host, key, keyLocation, urlList for >1 URLs", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      const urls = [
        `https://${SITE_HOSTNAME}/events/a`,
        `https://${SITE_HOSTNAME}/events/b`,
        `https://${SITE_HOSTNAME}/blog/c`,
      ];

      await pingIndexNow(db as never, urls, { INDEXNOW_KEY: "k123" }, "test");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0];
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
      const body = JSON.parse(String(init?.body));
      expect(body.host).toBe(SITE_HOSTNAME);
      expect(body.key).toBe("k123");
      expect(body.keyLocation).toBe(`https://${SITE_HOSTNAME}/k123.txt`);
      expect(body.urlList).toEqual(urls);
    });

    it("records one row per batch chunk", async () => {
      // Build > MAX_BATCH_SIZE (10_000) URLs to force two chunks.
      // Each chunk should produce its own fetch + DB insert.
      const db = makeDb();
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const urls = Array.from(
        { length: 10_005 },
        (_, i) => `https://${SITE_HOSTNAME}/events/e-${i}`
      );

      await pingIndexNow(db as never, urls, { INDEXNOW_KEY: "k" }, "bulk");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // recordSubmission is called once per chunk → 2 inserts. Cleanup is
      // probabilistic, so we just check the lower bound.
      expect(db.insert.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("network errors", () => {
    it("records 'failure' with the error message when fetch throws", async () => {
      const db = makeDb();
      fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"));
      await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      expect(errorSpy).toHaveBeenCalled();
      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("failure");
      expect(row.errorMessage).toContain("ECONNRESET");
    });

    it("never throws even when fetch rejects with a non-Error value", async () => {
      const db = makeDb();
      fetchSpy.mockRejectedValueOnce("string error");
      // REL4: returns a failure PingResult (no longer void) and still never throws.
      await expect(
        pingIndexNow(
          db as never,
          `https://${SITE_HOSTNAME}/events/x`,
          { INDEXNOW_KEY: "k" },
          "test"
        )
      ).resolves.toMatchObject({ ok: false, failed: 1 });
    });
  });

  describe("db null short-circuit", () => {
    it("works without a db (records skipped, fetch still happens)", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      await expect(
        pingIndexNow(null, `https://${SITE_HOSTNAME}/events/x`, { INDEXNOW_KEY: "k" }, "test")
      ).resolves.toMatchObject({ ok: true, succeeded: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // REL4 (2026-06-13) — pingIndexNow now reports the TRUE Bing outcome so the
  // internal endpoint and the MCP flush can leave throttled rows pending
  // instead of silently marking them flushed.
  describe("PingResult return value", () => {
    it("reports ok:false + the 429 status when Bing throttles a single URL", async () => {
      const db = makeDb();
      // No retry-after header → 4 fetches, all 429, then give up.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));
      const result = await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );
      vi.useRealTimers();
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(429);
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
    });

    it("reports ok:true + counts on success", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      const result = await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );
      expect(result).toMatchObject({
        ok: true,
        deferred: false,
        attempted: 1,
        succeeded: 1,
        failed: 0,
      });
    });

    it("reports ok:false + no_key when the key is missing (so flush rows stay pending)", async () => {
      const db = makeDb();
      const result = await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        {},
        "test"
      );
      expect(result).toMatchObject({ ok: false, failureReason: "no_key" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // Bing 429 burst protection — covers the duplicate-vendor cleanup case
  // documented 2026-05-05 (4 parallel delete_vendor → 3 of 4 hit 429).
  describe("429 backoff + retry", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries on 429 and records success when retry succeeds (single-URL GET)", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

      await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("success");
      expect(row.httpStatus).toBe(200);
    });

    it("retries on 429 for multi-URL POST batch", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 429 }));
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      const urls = [`https://${SITE_HOSTNAME}/events/a`, `https://${SITE_HOSTNAME}/events/b`];

      await pingIndexNow(db as never, urls, { INDEXNOW_KEY: "k" }, "test");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("success");
    });

    it("gives up after 3 retries and records the final 429 as failure", async () => {
      const db = makeDb();
      // Initial + 3 retries = 4 total fetches, all 429.
      fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));

      await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      expect(fetchSpy).toHaveBeenCalledTimes(4);
      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("failure");
      expect(row.httpStatus).toBe(429);
    });

    it("does not retry on non-429 failures (4xx/5xx pass through)", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(new Response("Bad request body", { status: 422 }));

      await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const row = db.values.mock.calls[0][0];
      expect(row.status).toBe("failure");
      expect(row.httpStatus).toBe(422);
    });

    // REL4 §2 — honor Retry-After.
    it("honors a short Retry-After header (within budget) then retries", async () => {
      const db = makeDb();
      fetchSpy.mockResolvedValueOnce(
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "2" } })
      );
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

      const result = await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
    });

    it("gives up immediately when Retry-After exceeds the in-request budget", async () => {
      const db = makeDb();
      // 900s cooldown ≫ MAX_RETRY_AFTER_MS (5s) → no retry, surface the 429.
      fetchSpy.mockResolvedValueOnce(
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "900" } })
      );

      const result = await pingIndexNow(
        db as never,
        `https://${SITE_HOSTNAME}/events/x`,
        { INDEXNOW_KEY: "k" },
        "test"
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry burst
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(429);
    });
  });
});
