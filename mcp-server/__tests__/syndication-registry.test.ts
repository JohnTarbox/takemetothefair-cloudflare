/**
 * SYN1 PR2 — subscriber registry MCP tools. "Adding a subscriber is an INSERT,
 * not a deploy" — these tools are that INSERT surface.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerSyndicationTools } from "../src/tools/admin-syndication.js";
import { events, promoters, syndicationSubscriptions } from "../src/schema.js";
import { eq } from "drizzle-orm";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerSyndicationTools(server as never, db, ADMIN);
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "e1", name: "E1", slug: "e1", promoterId: "p1", status: "APPROVED" })
    .run();
  db.insert(events)
    .values({ id: "e2", name: "E2", slug: "e2", promoterId: "p1", status: "APPROVED" })
    .run();
});

function parse(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("registerSyndicationTools", () => {
  it("registers a subscriber, then is idempotent on a duplicate callback_url", async () => {
    const r1 = parse(
      await server.invoke("register_syndication_subscriber", {
        name: "mcw",
        callback_url: "https://consumer.example/hook",
        signing_secret: "0123456789abcdef0123",
      })
    );
    expect(r1.registered).toBe(true);
    expect(r1.subscriber_id).toBeTruthy();

    const r2 = (await server.invoke("register_syndication_subscriber", {
      name: "mcw-again",
      callback_url: "https://consumer.example/hook",
      signing_secret: "0123456789abcdef0123",
    })) as { isError?: boolean };
    expect(r2.isError).toBe(true);
  });

  it("subscribes to known events, skipping unknown + already-subscribed", async () => {
    const sub = parse(
      await server.invoke("register_syndication_subscriber", {
        name: "mcw",
        callback_url: "https://consumer.example/hook",
        signing_secret: "0123456789abcdef0123",
      })
    );
    const id = sub.subscriber_id;

    const add1 = parse(
      await server.invoke("add_syndication_subscription", {
        subscriber_id: id,
        event_ids: ["e1", "e2", "does-not-exist"],
      })
    );
    expect(add1).toEqual({ added: 2, skipped_existing: 0, skipped_unknown_event: 1 });

    // Re-adding e1 is skipped as already-subscribed.
    const add2 = parse(
      await server.invoke("add_syndication_subscription", { subscriber_id: id, event_ids: ["e1"] })
    );
    expect(add2.added).toBe(0);
    expect(add2.skipped_existing).toBe(1);

    const rows = db
      .select()
      .from(syndicationSubscriptions)
      .where(eq(syndicationSubscriptions.subscriberId, id))
      .all();
    expect(rows).toHaveLength(2);
  });

  it("lists subscribers with event counts and no secrets, and toggles active", async () => {
    const sub = parse(
      await server.invoke("register_syndication_subscriber", {
        name: "mcw",
        callback_url: "https://consumer.example/hook",
        signing_secret: "0123456789abcdef0123",
      })
    );
    await server.invoke("add_syndication_subscription", {
      subscriber_id: sub.subscriber_id,
      event_ids: ["e1"],
    });

    const list = parse(await server.invoke("list_syndication_subscribers", {}));
    expect(list.subscribers).toHaveLength(1);
    expect(list.subscribers[0].eventCount).toBe(1);
    expect(list.subscribers[0]).not.toHaveProperty("signingSecret");

    await server.invoke("set_syndication_subscriber_active", {
      subscriber_id: sub.subscriber_id,
      active: false,
    });
    const list2 = parse(await server.invoke("list_syndication_subscribers", {}));
    expect(list2.subscribers[0].active).toBe(false);
  });

  it("removes a subscription", async () => {
    const sub = parse(
      await server.invoke("register_syndication_subscriber", {
        name: "mcw",
        callback_url: "https://consumer.example/hook",
        signing_secret: "0123456789abcdef0123",
      })
    );
    await server.invoke("add_syndication_subscription", {
      subscriber_id: sub.subscriber_id,
      event_ids: ["e1", "e2"],
    });
    await server.invoke("remove_syndication_subscription", {
      subscriber_id: sub.subscriber_id,
      event_id: "e1",
    });
    const rows = db
      .select()
      .from(syndicationSubscriptions)
      .where(eq(syndicationSubscriptions.subscriberId, sub.subscriber_id))
      .all();
    expect(rows.map((r) => r.eventId)).toEqual(["e2"]);
  });

  it("is a no-op for non-admins (registers nothing)", async () => {
    const s2 = new CapturingMcpServer();
    registerSyndicationTools(s2 as never, db, { userId: "u", role: "VENDOR" as never });
    expect(s2.handlers.size).toBe(0);
  });
});
