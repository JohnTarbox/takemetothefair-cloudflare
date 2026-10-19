/**
 * OPE-1496 — /go/<kind>/<slug>: log the click first-party, then 302 to the
 * destination stored on the event. Runs the real route against a real SQLite
 * holding the real schema's tables, so the slug-history walk, the promoter
 * join and the visibility gate are exercised, not stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";
import { analyticsEvents, events, eventSlugHistory, promoters } from "@/lib/db/schema";

const h = vi.hoisted(() => ({
  db: null as unknown,
  ga4: vi.fn(async (_cid: string, _events: unknown[]): Promise<void> => undefined),
}));

vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => h.db }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no request context in tests");
  },
}));
vi.mock("@/lib/ga4-measurement-protocol", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ga4-measurement-protocol")>();
  return { ...actual, sendGa4MeasurementProtocol: h.ga4 };
});

import { GET, HEAD } from "../route";

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let raw: Database.Database;

function createTable(t: SQLiteTable) {
  const cfg = getTableConfig(t);
  raw.exec(
    `CREATE TABLE ${cfg.name} (${cfg.columns
      .map((c) => `${c.name} ${c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT"}`)
      .join(", ")})`
  );
}

function addEvent(e: {
  id: string;
  slug: string;
  status?: string;
  lifecycle?: string;
  applicationUrl?: string | null;
  ticketUrl?: string | null;
  sourceUrl?: string | null;
  promoterId?: string;
}) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, lifecycle_status, application_url, ticket_url, source_url, promoter_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      e.id,
      e.slug,
      e.slug,
      e.status ?? "APPROVED",
      e.lifecycle ?? "SCHEDULED",
      e.applicationUrl ?? null,
      e.ticketUrl ?? null,
      e.sourceUrl ?? null,
      e.promoterId ?? "p1"
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [events, promoters, eventSlugHistory, analyticsEvents]) createTable(t);
  raw
    .prepare(`INSERT INTO promoters (id, company_name, slug, website) VALUES (?,?,?,?)`)
    .run("p1", "Acme Fairs", "acme-fairs", "https://acmefairs.example/");
  h.db = drizzle(raw, { schema });
  h.ga4.mockClear();
});
afterEach(() => raw.close());

function req(
  path: string,
  init: { method?: string; ua?: string | null; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.ua !== null) headers["user-agent"] = init.ua ?? BROWSER_UA;
  return new Request(`https://meetmeatthefair.com${path}`, {
    method: init.method ?? "GET",
    headers,
  });
}

async function hit(path: string, init: Parameters<typeof req>[1] = {}) {
  const [, , kind, slug] = new URL(`https://x${path}`).pathname.split("/");
  const handler = (init.method ?? "GET") === "HEAD" ? HEAD : GET;
  const res = await handler(req(path, init), {
    params: Promise.resolve({ kind, slug }),
  });
  // The log write is scheduled, not awaited; let it land.
  await new Promise((r) => setTimeout(r, 10));
  return res;
}

function rows() {
  return (
    raw.prepare(`SELECT event_name, source, properties FROM analytics_events`).all() as Array<{
      event_name: string;
      source: string;
      properties: string;
    }>
  ).map((r) => ({ ...r, props: JSON.parse(r.properties) as Record<string, unknown> }));
}

describe("GET /go/apply/<slug> — resolves from the event, logs, 302s", () => {
  it("application_url wins; one row with the campaign; human browser GET", async () => {
    addEvent({
      id: "e1",
      slug: "spring-fair-2026",
      applicationUrl: "https://apply.example/form?id=9",
      sourceUrl: "https://fair.example/",
    });
    const res = await hit(
      "/go/apply/spring-fair-2026?c=vendor-digest-2026-10-26&s=newsletter&m=email&l=card-3"
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://apply.example/form?id=9");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].event_name).toBe("outbound_application_click");
    expect(r[0].source).toBe("redirect");
    expect(r[0].props).toMatchObject({
      eventSlug: "spring-fair-2026",
      destinationUrl: "https://apply.example/form?id=9",
      resolvedFrom: "application_url",
      resolved: true,
      campaign: "vendor-digest-2026-10-26",
      trafficSource: "newsletter",
      trafficMedium: "email",
      linkLabel: "card-3",
      ua_class: "human",
    });
    // The person's click is mirrored to GA4 under the existing _server name.
    expect(h.ga4).toHaveBeenCalledTimes(1);
    expect((h.ga4.mock.calls[0][1] as Array<{ name: string }>)[0].name).toBe(
      "outbound_application_click_server"
    );
  });

  it("HEAD is a scanner: logged under the _scanner name, not counted as a conversion, not mirrored", async () => {
    addEvent({ id: "e1", slug: "spring-fair-2026", applicationUrl: "https://apply.example/" });
    const res = await hit("/go/apply/spring-fair-2026?c=vendor-digest-2026-10-26", {
      method: "HEAD",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://apply.example/");
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].event_name).toBe("outbound_application_click_scanner");
    expect(r[0].source).toBe("redirect");
    expect(r[0].props).toMatchObject({
      campaign: "vendor-digest-2026-10-26",
      ua_class: "scanner",
      ua_reason: "head",
    });
    expect(h.ga4).not.toHaveBeenCalled();
  });

  it("a known scanner UA on GET is a scanner too", async () => {
    addEvent({ id: "e1", slug: "spring-fair-2026", applicationUrl: "https://apply.example/" });
    await hit("/go/apply/spring-fair-2026", {
      ua: "Mozilla/5.0 (Windows NT 10.0) via ggpht.com GoogleImageProxy",
    });
    expect(rows()[0].props).toMatchObject({
      ua_class: "scanner",
      ua_reason: "ua:googleimageproxy",
    });
  });

  it("no application_url and no source_url → the promoter's website", async () => {
    addEvent({ id: "e1", slug: "harvest-days" });
    const res = await hit("/go/apply/harvest-days");
    expect(res.headers.get("location")).toBe("https://acmefairs.example/");
    expect(rows()[0].props.resolvedFrom).toBe("promoter_site");
  });

  it("nothing stored at all → our own event page", async () => {
    raw.prepare(`UPDATE promoters SET website = NULL`).run();
    addEvent({ id: "e1", slug: "harvest-days" });
    const res = await hit("/go/apply/harvest-days");
    expect(res.headers.get("location")).toBe("https://meetmeatthefair.com/events/harvest-days");
    expect(rows()[0].props.resolvedFrom).toBe("event_page");
  });

  it("no request parameter can set the destination (open-redirect probe)", async () => {
    addEvent({ id: "e1", slug: "spring-fair-2026", applicationUrl: "https://apply.example/" });
    for (const q of ["to", "url", "u", "redirect", "next", "dest", "c", "l"]) {
      const res = await hit(`/go/apply/spring-fair-2026?${q}=https://evil.example/`);
      expect(res.headers.get("location")).toBe("https://apply.example/");
    }
  });

  it("a stored non-http value is skipped, never redirected to", async () => {
    addEvent({
      id: "e1",
      slug: "spring-fair-2026",
      applicationUrl: "javascript:alert(1)",
      sourceUrl: "https://fair.example/",
    });
    const res = await hit("/go/apply/spring-fair-2026");
    expect(res.headers.get("location")).toBe("https://fair.example/");
    expect(rows()[0].props.resolvedFrom).toBe("source_url");
  });
});

describe("GET /go/tickets/<slug>", () => {
  it("ticket_url → source_url → event page (the promoter site is NOT a ticket fallback)", async () => {
    addEvent({ id: "e1", slug: "a", ticketUrl: "https://tix.example/a" });
    addEvent({ id: "e2", slug: "b", sourceUrl: "https://fair.example/b" });
    addEvent({ id: "e3", slug: "c" });
    expect((await hit("/go/tickets/a")).headers.get("location")).toBe("https://tix.example/a");
    expect((await hit("/go/tickets/b")).headers.get("location")).toBe("https://fair.example/b");
    expect((await hit("/go/tickets/c")).headers.get("location")).toBe(
      "https://meetmeatthefair.com/events/c"
    );
    expect(rows().map((r) => [r.event_name, r.props.resolvedFrom])).toEqual([
      ["outbound_ticket_click", "ticket_url"],
      ["outbound_ticket_click", "source_url"],
      ["outbound_ticket_click", "event_page"],
    ]);
  });
});

describe("slugs that do not resolve to a public event", () => {
  it("a retired slug follows event_slug_history to the live event", async () => {
    addEvent({ id: "e1", slug: "spring-fair-2026", applicationUrl: "https://apply.example/" });
    raw
      .prepare(
        `INSERT INTO event_slug_history (id, event_id, old_slug, new_slug, changed_at) VALUES (?,?,?,?,?)`
      )
      .run("h1", "e1", "spring-fair", "spring-fair-2026", 1_700_000_000);
    const res = await hit("/go/apply/spring-fair");
    expect(res.headers.get("location")).toBe("https://apply.example/");
    expect(rows()[0].props).toMatchObject({ eventSlug: "spring-fair-2026", resolved: true });
  });

  it("an unknown slug → 302 to /events, logged resolved:false", async () => {
    const res = await hit("/go/apply/no-such-event?c=x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://meetmeatthefair.com/events");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].props).toMatchObject({
      eventSlug: "no-such-event",
      resolved: false,
      resolvedFrom: "events_index",
    });
    expect(h.ga4).not.toHaveBeenCalled();
  });

  it.each([
    ["PENDING", "SCHEDULED"],
    ["REJECTED", "SCHEDULED"],
    ["APPROVED", "CANCELLED"],
  ])("a non-public event (%s / %s) is treated as unknown", async (status, lifecycle) => {
    addEvent({
      id: "e1",
      slug: "hidden",
      status,
      lifecycle,
      applicationUrl: "https://apply.example/",
    });
    const res = await hit("/go/apply/hidden");
    expect(res.headers.get("location")).toBe("https://meetmeatthefair.com/events");
    expect(rows()[0].props.resolved).toBe(false);
  });

  it("an unknown kind → /events, nothing logged", async () => {
    addEvent({ id: "e1", slug: "spring-fair-2026", applicationUrl: "https://apply.example/" });
    const res = await hit("/go/website/spring-fair-2026");
    expect(res.headers.get("location")).toBe("https://meetmeatthefair.com/events");
    expect(rows()).toHaveLength(0);
  });
});

describe("a failing log write never blocks the redirect", () => {
  it("analytics_events missing → still 302s to the destination", async () => {
    addEvent({ id: "e1", slug: "spring-fair-2026", applicationUrl: "https://apply.example/" });
    raw.exec(`DROP TABLE analytics_events`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await hit("/go/apply/spring-fair-2026");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://apply.example/");
    spy.mockRestore();
  });

  it("the event lookup itself failing → /events, not a 500", async () => {
    raw.exec(`DROP TABLE events`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await hit("/go/apply/spring-fair-2026");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://meetmeatthefair.com/events");
    spy.mockRestore();
  });
});
