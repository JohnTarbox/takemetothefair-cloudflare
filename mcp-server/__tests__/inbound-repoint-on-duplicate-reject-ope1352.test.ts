/**
 * OPE-1352 — `update_event_status` REJECTED-as-duplicate repoints the inbound
 * email that produced the row to the keeper.
 *
 * Specimen (prod, 2026-10-15): the UMF Chester Greenwood duplicate e15e22a7 was
 * rejected against keeper 7b8ac15d, and inbound f8ef71e5 kept naming the
 * rejected row — so every reader of `resulting_event_id` saw a failed
 * submission where there was a matched live listing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, events, inboundEmails, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let indexnow: ReturnType<typeof mockIndexNowFetch>;

function seedEvent(id: string, o: { flag?: string; mergedInto?: string; status?: string } = {}) {
  db.insert(events)
    .values({
      id,
      name: id,
      slug: unsafeSlug(id),
      promoterId: "promoter-1",
      status: (o.status ?? "PENDING") as never,
      possibleDuplicateOf: o.flag ?? null,
      mergedInto: o.mergedInto ?? null,
      createdAt: new Date("2026-10-01T12:00:00Z"),
    })
    .run();
}

function seedInbound(id: string, resultingEventId: string | null) {
  db.insert(inboundEmails)
    .values({
      id,
      receivedAt: new Date("2026-10-01T12:00:00Z"),
      fromAddress: "submitter@example.com",
      toAddress: "events@meetmeatthefair.com",
      intent: "new_event",
      resultingEventId,
      createdAt: new Date("2026-10-01T12:00:00Z"),
    } as never)
    .run();
}

const ptr = (id: string) =>
  db
    .select({ r: inboundEmails.resultingEventId })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, id))
    .get()?.r;

const repointAudits = () =>
  db
    .select({ targetId: adminActions.targetId, payload: adminActions.payloadJson })
    .from(adminActions)
    .where(eq(adminActions.action, "inbound_email.resulting_event_repoint"))
    .all()
    .map((a) => ({ id: a.targetId, ...JSON.parse(a.payload ?? "{}") }));

async function setStatus(eventId: string, status: string, extra: Record<string, unknown> = {}) {
  const r = (await server.invoke("update_event_status", {
    event_id: eventId,
    status,
    ...extra,
  })) as { isError?: boolean; content: Array<{ text: string }> };
  if (r.isError) throw new Error(r.content[0]?.text);
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  indexnow = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: unsafeSlug("test-promoter") })
    .run();
});

afterEach(() => {
  indexnow.restore();
});

describe("update_event_status — reject as duplicate repoints the inbound (OPE-1352)", () => {
  it("defaulted from possible_duplicate_of: the inbound now names the keeper, auditably", async () => {
    seedEvent("keeper", { status: "TENTATIVE" });
    seedEvent("dup", { flag: "keeper" });
    seedInbound("in-dup", "dup");
    seedInbound("in-keeper", "keeper");

    const res = await setStatus("dup", "REJECTED");

    expect(ptr("in-dup")).toBe("keeper");
    expect(ptr("in-keeper")).toBe("keeper");
    expect(repointAudits()).toEqual([
      {
        id: "in-dup",
        from_event_id: "dup",
        to_event_id: "keeper",
        named_keeper_id: "keeper",
        reason: "rejected_as_duplicate_of",
      },
    ]);
    expect(res.inbound_emails_repointed).toEqual({
      to_event_id: "keeper",
      inbound_email_ids: ["in-dup"],
    });
  });

  it("an explicit rejected_as_duplicate_of whose keeper was merged resolves to the live keeper", async () => {
    seedEvent("final", { status: "APPROVED" });
    seedEvent("mid", { status: "REJECTED", mergedInto: "final" });
    seedEvent("dup");
    seedInbound("in-dup", "dup");

    await setStatus("dup", "REJECTED", { rejected_as_duplicate_of: "mid" });

    expect(ptr("in-dup")).toBe("final");
  });

  it("a plain reject (not a duplicate) leaves the inbound on the event", async () => {
    seedEvent("dup");
    seedInbound("in-dup", "dup");

    const res = await setStatus("dup", "REJECTED");

    expect(ptr("in-dup")).toBe("dup");
    expect(repointAudits()).toEqual([]);
    expect(res.inbound_emails_repointed).toBeUndefined();
  });
});
