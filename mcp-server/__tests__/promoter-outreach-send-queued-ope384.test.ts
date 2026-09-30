/**
 * OPE-384 — a gated ask must actually be deliverable once the gate opens.
 *
 * A refused send is saved as `queued` so approved prose survives the gate. But
 * `queued` counts as OPEN, so after the flip the only send path answered
 * "already_open" for that event forever: the saved ask could never go out. The
 * first live send (Pratt Street, attempt ce49dd9d…, copy approved by John) hit
 * exactly this. `attempt_id` sends the stored row verbatim.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerSendPromoterEmailTool } from "../src/tools/admin-send-promoter-email.js";
import {
  adminActions,
  emailSuppressionList,
  events,
  promoters,
  promoterOutreachAttempts,
} from "../src/schema.js";

const AUTH = { userId: "u-admin", role: "ADMIN" as const };
const APPROVED_BODY =
  "Hi Rory,\n\nWe list Pratt Street Winter Village on Meet Me at the Fair.\n\nThanks,\nJohn";

interface Mail {
  to: string;
  subject: string;
  text: string;
  source: string;
}
let db: TestDb;
let sent: Mail[];

function tool(enabled: boolean) {
  const server = new CapturingMcpServer();
  registerSendPromoterEmailTool(server as never, db, AUTH, {
    PROMOTER_OUTREACH_ENABLED: enabled ? "true" : "false",
    EMAIL_JOBS: { send: async (m: Mail) => void sent.push(m) },
  } as never);
  return async (args: Record<string, unknown>) =>
    JSON.parse(
      ((await server.invoke("send_promoter_email", args)) as { content: Array<{ text: string }> })
        .content[0].text
    );
}
const attempt = () =>
  db
    .select()
    .from(promoterOutreachAttempts)
    .where(eq(promoterOutreachAttempts.id, "ce49dd9d"))
    .all()[0];

beforeEach(() => {
  ({ db } = createTestDb());
  sent = [];
  db.insert(promoters)
    .values({
      id: "p-pratt",
      companyName: "Pratt Street Historic District",
      slug: "pratt-street-historic-district",
      contactEmail: "rory@hartfordprints.com",
    } as never)
    .run();
  db.insert(events)
    .values({
      id: "e-pratt",
      name: "Pratt Street Winter Village",
      slug: "pratt-street-winter-village-2026",
      promoterId: "p-pratt",
      status: "APPROVED",
    } as never)
    .run();
  db.insert(promoterOutreachAttempts)
    .values({
      id: "ce49dd9d",
      promoterId: "p-pratt",
      eventId: "e-pratt",
      channel: "email",
      toAddress: "rory@hartfordprints.com",
      subject: "Pratt Street Winter Village 2026 dates?",
      bodyText: APPROVED_BODY,
      status: "queued",
      createdAt: new Date(),
    } as never)
    .run();
});

describe("why the mode exists", () => {
  it("the ordinary send path refuses the event while its approved ask sits queued", async () => {
    const r = await tool(true)({ event_id: "e-pratt" });
    expect(r.blocked).toBe("already_open");
    expect(sent).toHaveLength(0);
  });
});

describe("send_promoter_email(attempt_id)", () => {
  it("ACCEPTANCE: sends the STORED subject, body and recipient verbatim, and marks it sent", async () => {
    const r = await tool(true)({ attempt_id: "ce49dd9d" });
    expect(r).toMatchObject({ success: true, delivered_from_queue: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "rory@hartfordprints.com",
      subject: "Pratt Street Winter Village 2026 dates?",
      text: APPROVED_BODY,
      source: "email:promoter-outreach",
    });
    const a = attempt();
    expect(a.status).toBe("sent");
    expect(a.sentAt).not.toBeNull();
    const log = db.select().from(adminActions).all();
    expect(log.map((l: { action: string }) => l.action)).toEqual(["promoter.email_sent"]);
  });

  it("ignores any subject/body passed alongside — nothing is recomposed", async () => {
    await tool(true)({ attempt_id: "ce49dd9d", subject: "DIFFERENT", body: "DIFFERENT" });
    expect(sent[0].subject).toBe("Pratt Street Winter Village 2026 dates?");
    expect(sent[0].text).toBe(APPROVED_BODY);
  });

  it("a second call cannot send the same ask twice", async () => {
    const send = tool(true);
    await send({ attempt_id: "ce49dd9d" });
    const again = await send({ attempt_id: "ce49dd9d" });
    expect(again.blocked).toBe("not_queued");
    // The early check reports WHERE the attempt got to, not just "no".
    expect(again.status).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("two CONCURRENT calls send once — the row is claimed before the send", async () => {
    const send = tool(true);
    const results = await Promise.all([
      send({ attempt_id: "ce49dd9d" }),
      send({ attempt_id: "ce49dd9d" }),
    ]);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.success === true)).toHaveLength(1);
  });

  it("gate closed: nothing is sent and the attempt stays queued", async () => {
    const r = await tool(false)({ attempt_id: "ce49dd9d" });
    expect(r).toMatchObject({ success: false, queued: true });
    expect(sent).toHaveLength(0);
    expect(attempt().status).toBe("queued");
  });

  it("a suppressed recipient is not sent to, and the attempt stays queued", async () => {
    db.insert(emailSuppressionList)
      .values({ email: "rory@hartfordprints.com", reason: "test", createdAt: new Date() } as never)
      .run();
    const r = await tool(true)({ attempt_id: "ce49dd9d" });
    expect(r.blocked).toBe("suppressed");
    expect(sent).toHaveLength(0);
    expect(attempt().status).toBe("queued");
  });
});
