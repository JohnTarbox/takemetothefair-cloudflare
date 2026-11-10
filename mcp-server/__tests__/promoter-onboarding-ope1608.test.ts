/**
 * OPE-1608 — the promoter onboarding lane, against a real database. The auth and
 * match values are inbound 7f761f2a's own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  operatorOutboundDrafts,
  promoterOnboardingRequests,
  promoters,
  supportObligations,
} from "../src/schema.js";

const fetchSite = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../src/enrichment/fetch-site.js", () => ({ fetchVendorSite: fetchSite.fn }));
vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  // The handler takes env.DB; here that is already the drizzle handle.
  getDb: (d: unknown) => d,
}));

import {
  claimBelongsInOnboarding,
  composeFirstDraft,
  composeOnboardingDraft,
  openOnboardingRequest,
  runPromoterOnboardingPass,
  ENRICHMENT_TIMEOUT_MS,
} from "../src/inbound/promoter-onboarding.js";
import { handle } from "../src/email-handlers/promoter-onboarding.js";
import { toWorkflowIntent } from "../src/email-intents.js";
import { INTENT_TAXONOMY_DOC } from "../src/intent-classifier-prompt.js";
import { parseClassifierResponse } from "../src/intent-classifier.js";

const INBOUND = "7f761f2a-f179-47b9-aa98-42f63003cf03";
const VENDOR_ID = "615c32df-d58e-473d-b554-3f9cf59d98a4";
const FROM = "sgasiorowski@ohtm.org";
const T0 = new Date(Date.UTC(2026, 10, 10, 14, 10));
const MIN = 60_000;
const HOUR = 60 * MIN;
const MATCHES = JSON.stringify([
  {
    entityType: "vendor",
    entityId: VENDOR_ID,
    name: "Owls Head Transportation Museum",
    basis: "website-domain",
  },
]);

let db: TestDb;
let raw: Database.Database;
let sent: Array<Record<string, unknown>>;

function seedInbound(id = INBOUND, matched: string | null = MATCHES) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at,
         subject, from_display_name, classified_intent, classified_confidence, matched_entities)
       VALUES (?, ?, ?, 'hello@meetmeatthefair.com', 'promoter_onboarding', ?, 'Promoter account',
         'Samantha Gasiorowski', 'promoter_onboarding', 0.9, ?)`
    )
    .run(id, T0.getTime() / 1000, FROM, T0.getTime() / 1000, matched);
}

async function inboundRow(id = INBOUND) {
  const { inboundEmails } = await import("../src/schema.js");
  const [row] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id));
  return row;
}

const env = () => ({
  DB: db as never,
  ALERT_EMAIL_TECHNICAL: "ops@example.test",
  EMAIL_JOBS: { send: async (m: unknown) => void sent.push(m as Record<string, unknown>) },
});

const request = async () => (await db.select().from(promoterOnboardingRequests).limit(1))[0];
const drafts = () => db.select().from(operatorOutboundDrafts);
const after = (ms: number) => new Date(T0.getTime() + ms);

async function open() {
  seedInbound();
  return openOnboardingRequest(db as never, await inboundRow(), T0);
}

/** setup-db has no support_obligations; built from the schema, as OPE-1510's test does. */
function createObligationsTable() {
  const cfg = getTableConfig(supportObligations);
  const cols = cfg.columns.map((c) => {
    const dflt =
      c.name === "status" ? " DEFAULT 'open'" : c.name === "kind" ? " DEFAULT 'support'" : "";
    return `${c.name} ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}${dflt}`;
  });
  raw.exec(`DROP TABLE IF EXISTS support_obligations; CREATE TABLE support_obligations (${cols.join(", ")});
    CREATE UNIQUE INDEX uq_ob ON support_obligations(inbound_email_id);`);
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  createObligationsTable();
  sent = [];
  fetchSite.fn.mockReset();
  fetchSite.fn.mockResolvedValue({
    ok: true,
    html: "<html>tribe-events</html>",
    fetchMethod: "fetch",
  });
});

describe("OPE-1608 — classify and route", () => {
  it("is a classifier intent the prompt defines, and dispatches to itself", () => {
    expect(INTENT_TAXONOMY_DOC).toContain("promoter_onboarding:");
    expect(toWorkflowIntent("promoter_onboarding")).toBe("promoter_onboarding");
  });

  it("the parser keeps the label rather than coercing it away", () => {
    const [c] = parseClassifierResponse(
      JSON.stringify({ intent: "promoter_onboarding", confidence: 0.92, rationale: "asks to list" })
    );
    expect(c.intent).toBe("promoter_onboarding");
  });

  it("a claim comes here only when the org is identifiable and has no promoter row", () => {
    expect(claimBelongsInOnboarding({ matchedEntities: MATCHES, fromAddress: FROM })).toBe(true);
    const promoter = JSON.stringify([{ entityType: "promoter", entityId: "p1" }]);
    expect(claimBelongsInOnboarding({ matchedEntities: promoter, fromAddress: FROM })).toBe(false);
    expect(
      claimBelongsInOnboarding({ matchedEntities: "[]", fromAddress: "someone@gmail.com" })
    ).toBe(false);
    expect(claimBelongsInOnboarding({ matchedEntities: "[]", fromAddress: FROM })).toBe(true);
  });
});

describe("OPE-1608 — the inbound replay (7f761f2a)", () => {
  it("sends no ack, opens one obligation, and records the match without a promoter row", async () => {
    seedInbound();
    const row = await inboundRow();
    const result = await handle(env() as never, {} as never, row);
    expect(result.replyKind).toBeNull();
    expect(result.status).toBe("awaiting_human");
    expect(result.skipAdminDecision).toBe(true);
    expect(result.crossingDestinationRef).toBeTruthy();

    const r = await request();
    expect(r.enrichmentStatus).toBe("queued");
    expect(r.orgDomain).toBe("ohtm.org");
    const report = JSON.parse(r.matchReport!);
    expect(report.vendors[0].entityId).toBe(VENDOR_ID);
    expect(report.missing).toEqual(["promoter", "venue"]);
    expect(JSON.parse(r.stagedPromoter!)).toMatchObject({
      state: "staged",
      companyName: "Owls Head Transportation Museum",
      linkedVendorId: VENDOR_ID,
      contactEmail: FROM,
    });
    expect(await db.select().from(promoters)).toHaveLength(0);
    expect(await drafts()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("is idempotent on a workflow retry", async () => {
    await open();
    await openOnboardingRequest(db as never, await inboundRow(), T0);
    expect(await db.select().from(promoterOnboardingRequests)).toHaveLength(1);
  });
});

describe("OPE-1608 — the draft waits for enrichment", () => {
  it("composeFirstDraft refuses while enrichment is queued", async () => {
    await open();
    expect(await composeFirstDraft(db as never, await request(), after(MIN))).toBeNull();
    expect(await drafts()).toHaveLength(0);
  });

  it("drafts after the pass, stating none were found, and only John is mailed", async () => {
    await open();
    const s = await runPromoterOnboardingPass(db as never, env() as never, after(10 * MIN));
    expect(s).toMatchObject({ examined: 1, enriched: 1, drafted: 1, notified: 1 });
    const [d] = await drafts();
    expect(d.toAddress).toBe(FROM);
    expect(d.status).toBe("pending");
    expect(d.bodyText).toContain("Hello Samantha,");
    expect(d.bodyText).toContain("We haven't found any of your events to list yet.");
    expect(d.bodyText).toContain("listing is free");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ops@example.test");
    expect(String(sent[0].text)).toContain(d.bodyText);
  });

  it("lists events held for the org when there are some", () => {
    const { bodyText } = composeOnboardingDraft({
      subject: "x",
      firstName: null,
      orgName: "OHTM",
      validated: true,
      events: [
        {
          name: "Wings & Wheels",
          slug: "wings-and-wheels",
          startDate: new Date("2027-07-10T14:00:00Z"),
          endDate: new Date("2027-07-11T20:00:00Z"),
        },
      ],
    });
    expect(bodyText).toContain("Wings & Wheels, July 10, 2027 to July 11, 2027");
    expect(bodyText).toContain("/events/wings-and-wheels");
    expect(bodyText).toContain("applied directly");
  });

  it("a failed pass retries, then times out and still drafts", async () => {
    await open();
    fetchSite.fn.mockRejectedValue(new Error("boom"));
    await runPromoterOnboardingPass(db as never, env() as never, after(10 * MIN));
    expect((await request()).enrichmentStatus).toBe("queued");
    expect(await drafts()).toHaveLength(0);
    await runPromoterOnboardingPass(
      db as never,
      env() as never,
      after(ENRICHMENT_TIMEOUT_MS + MIN)
    );
    expect((await request()).enrichmentStatus).toBe("timed_out");
    expect(await drafts()).toHaveLength(1);
  });
});

describe("OPE-1608 — alerts and the deadline", () => {
  it("notifies once, reminds once at 50%, and writes one fault at the deadline", async () => {
    await open();
    const r0 = await request();
    const window = r0.targetAt!.getTime() - T0.getTime();

    await runPromoterOnboardingPass(db as never, env() as never, after(10 * MIN));
    await runPromoterOnboardingPass(db as never, env() as never, after(20 * MIN));
    expect(sent).toHaveLength(1);
    expect(String(sent[0].subject)).toContain("waiting for your approval");

    await runPromoterOnboardingPass(db as never, env() as never, after(window / 2 + MIN));
    expect(sent).toHaveLength(2);
    expect(String(sent[1].subject)).toContain("[ACTION NEEDED]");
    await runPromoterOnboardingPass(db as never, env() as never, after(window / 2 + 20 * MIN));
    expect(sent).toHaveLength(2);

    const faults = () =>
      raw
        .prepare(`SELECT count(*) n FROM error_logs WHERE message LIKE '%deadline passed%'`)
        .get() as { n: number };
    expect(faults().n).toBe(0);
    const s = await runPromoterOnboardingPass(db as never, env() as never, after(window + MIN));
    expect(s.faults).toBe(1);
    await runPromoterOnboardingPass(db as never, env() as never, after(window + 20 * MIN));
    expect(faults().n).toBe(1);
    expect(await drafts()).toHaveLength(1);
  });

  it("a discarded draft closes the request and stops the alerts", async () => {
    await open();
    await runPromoterOnboardingPass(db as never, env() as never, after(10 * MIN));
    raw.prepare(`UPDATE operator_outbound_drafts SET status='discarded'`).run();
    await runPromoterOnboardingPass(db as never, env() as never, after(20 * MIN));
    expect((await request()).closeReason).toBe("draft-discarded");
    expect(sent).toHaveLength(1);
  });

  it("closes without drafting for a suppressed sender", async () => {
    await open();
    raw
      .prepare(
        `INSERT INTO email_suppression_list (email, reason, created_at) VALUES (?, 'manual', 0)`
      )
      .run(FROM);
    await runPromoterOnboardingPass(db as never, env() as never, after(10 * MIN));
    expect((await request()).closeReason).toBe("sender-suppressed");
    expect(await drafts()).toHaveLength(0);
  });
});

describe("OPE-1608 — the 7-day follow-up", () => {
  const DAY = 24 * HOUR;
  async function replied() {
    await open();
    await runPromoterOnboardingPass(db as never, env() as never, after(10 * MIN));
    raw
      .prepare(`UPDATE operator_outbound_drafts SET status='sent', sent_at=?`)
      .run(after(HOUR).getTime() / 1000);
    await runPromoterOnboardingPass(db as never, env() as never, after(2 * HOUR));
    sent = [];
  }

  it("queues one follow-up after seven quiet days, and tells John", async () => {
    await replied();
    await runPromoterOnboardingPass(db as never, env() as never, after(6 * DAY));
    expect(await drafts()).toHaveLength(1);
    await runPromoterOnboardingPass(db as never, env() as never, after(8 * DAY));
    await runPromoterOnboardingPass(db as never, env() as never, after(8 * DAY + 10 * MIN));
    const all = await drafts();
    expect(all).toHaveLength(2);
    expect(all.find((d) => d.subject.startsWith("Following up"))?.status).toBe("pending");
    expect(sent.filter((m) => String(m.subject).includes("follow-up"))).toHaveLength(1);
  });

  it("no follow-up once the org has submitted an event", async () => {
    await replied();
    raw
      .prepare(
        `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at, classified_intent)
         VALUES ('sub1', ?, ?, 'submit@meetmeatthefair.com', 'submit', ?, 'new_event')`
      )
      .run(after(2 * DAY).getTime() / 1000, FROM, after(2 * DAY).getTime() / 1000);
    await runPromoterOnboardingPass(db as never, env() as never, after(3 * DAY));
    expect((await request()).firstSubmissionAt).toBeTruthy();
    await runPromoterOnboardingPass(db as never, env() as never, after(8 * DAY));
    expect(await drafts()).toHaveLength(1);
  });
});
