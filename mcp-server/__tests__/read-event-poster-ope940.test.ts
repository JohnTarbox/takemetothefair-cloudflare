/**
 * OPE-940 option 1 — read_event_poster: a READ-ONLY vision read of a poster.
 *
 * The acceptance "drive it to failure once: a poster whose text contradicts the
 * page, and the tool returns the POSTER's value" is exercised through the real
 * tool: the stored row says free / Sep 19, the poster prints $5 / Sep 12, and
 * the tool reports the poster's values, names both disagreements, and writes
 * nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerReadEventPosterTool } from "../src/tools/read-event-poster.js";
import { parsePosterReply, posterDisagreements, readPoster } from "../src/photo/read-poster.js";
import { events, promoters, users } from "../src/schema.js";

const EDDINGTON = {
  event_name: "Fall Bazaar",
  dates: ["Saturday, September 12, 2026"],
  hours: "10am - 2pm",
  price: "$5, under 18 free",
  location: "Town Office Lawn",
  raw_text:
    "Eddington Historical Society | Fall Bazaar | Saturday, September 12, 2026 | 10am - 2pm | Town Office Lawn",
  confidence: 0.86,
};

describe("parsePosterReply", () => {
  it("reads an object, a JSON string, and a {response} wrapper alike", () => {
    expect(parsePosterReply(EDDINGTON).hours).toBe("10am - 2pm");
    expect(parsePosterReply(JSON.stringify(EDDINGTON)).location).toBe("Town Office Lawn");
    expect(parsePosterReply({ response: `here: ${JSON.stringify(EDDINGTON)}` }).dates).toEqual([
      "Saturday, September 12, 2026",
    ]);
  });
  it("prose and garbage fail closed with a reason, never a guessed value", () => {
    expect(parsePosterReply("I think it's a bazaar").failure_reason).toBe("no-json-in-reply");
    expect(parsePosterReply(42).failure_reason).toBe("reply-not-an-object");
  });
  it("readPoster never throws", async () => {
    const r = await readPoster(
      {
        run: async () => {
          throw new Error("5028");
        },
      },
      new Uint8Array([1])
    );
    expect(r.failure_reason).toMatch(/ai-run-threw: 5028/);
  });
});

describe("posterDisagreements", () => {
  it("names a date and a price the poster contradicts", () => {
    const d = posterDisagreements(parsePosterReply(EDDINGTON), {
      start_date: "2026-09-19",
      ticket_price_min: 0,
    });
    expect(d.some((x) => x.startsWith("start_date"))).toBe(true);
    expect(d.some((x) => x.startsWith("price"))).toBe(true);
  });
  it("is silent when the poster agrees", () => {
    expect(
      posterDisagreements(parsePosterReply(EDDINGTON), {
        start_date: "2026-09-12",
        ticket_price_min: 5,
      })
    ).toEqual([]);
  });
});

describe("read_event_poster, through the real tool", () => {
  let db: TestDb;
  let raw: ReturnType<typeof createTestDb>["raw"];
  let server: CapturingMcpServer;
  const run = vi.fn(async () => ({ response: EDDINGTON }));

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    db.insert(users).values({ id: "u", email: "a@x", role: "ADMIN" }).run();
    db.insert(promoters)
      .values({ id: "p", companyName: "EHS", slug: "ehs" as never })
      .run();
    db.insert(events)
      .values({
        id: "ev-1",
        name: "Fall Bazaar",
        slug: "fall-bazaar" as never,
        promoterId: "p",
        status: "APPROVED",
        startDate: new Date("2026-09-19T12:00:00Z"),
        ticketPriceMinCents: 0,
      } as typeof events.$inferInsert)
      .run();
    server = new CapturingMcpServer();
    registerReadEventPosterTool(
      server as never,
      db,
      { userId: "u", role: "ADMIN" },
      { AI: { run } }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
            headers: { "Content-Type": "image/jpeg" },
          })
      )
    );
  });

  it("ACCEPTANCE: the poster wins — its values are returned, the contradictions named, nothing written", async () => {
    const before = raw.prepare("SELECT * FROM events").all();
    const res = (await server.invoke("read_event_poster", {
      image_url:
        "https://eddingtonhistoricalsociety.org/wp-content/uploads/REVISED-FALL-BAZAAR-2_2026-791x1024.jpg",
      event_id: "ev-1",
    })) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0].text);

    expect(out.reading.dates).toEqual(["Saturday, September 12, 2026"]);
    expect(out.reading.hours).toBe("10am - 2pm");
    expect(out.reading.location).toBe("Town Office Lawn");
    expect(out.source_to_cite).toMatch(/REVISED-FALL-BAZAAR/);
    expect(out.disagreements).toHaveLength(2);
    expect(raw.prepare("SELECT * FROM events").all()).toEqual(before); // read-only
    expect(run).toHaveBeenCalledTimes(1); // one image per call
  });

  it("a non-image URL is refused before the model is called", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>nope</html>", { headers: { "Content-Type": "text/html" } })
      )
    );
    run.mockClear();
    const res = (await server.invoke("read_event_poster", {
      image_url: "https://x.test/page",
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  // OPE-1370 (SSRF6) — the poster URL is caller-supplied and had no guard.
  it("refuses a poster URL that redirects to loopback, without requesting the hop", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(String(input));
        if (String(input) === "https://x.test/poster.jpg") {
          // A runtime-followed redirect would land on the hop; manual stops here.
          return init?.redirect === "manual"
            ? new Response(null, { status: 302, headers: { location: "http://[::7f00:1]/p.jpg" } })
            : new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
                headers: { "Content-Type": "image/jpeg" },
              });
        }
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          headers: { "Content-Type": "image/jpeg" },
        });
      })
    );
    run.mockClear();
    const res = (await server.invoke("read_event_poster", {
      image_url: "https://x.test/poster.jpg",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/internal host/i);
    expect(seen).toEqual(["https://x.test/poster.jpg"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops reading an oversize poster at the cap instead of buffering it whole", async () => {
    let sent = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                if (sent >= 64 * 1024 * 1024) return c.close();
                sent += 1024 * 1024;
                c.enqueue(new Uint8Array(1024 * 1024));
              },
            }),
            { headers: { "Content-Type": "image/jpeg" } }
          )
      )
    );
    run.mockClear();
    const res = (await server.invoke("read_event_poster", {
      image_url: "https://x.test/huge.jpg",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/reads at most/);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
    expect(run).not.toHaveBeenCalled();
  });
});
