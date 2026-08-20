/**
 * OPE-240 — `list_photo_proposals`.
 *
 * The gate this reads for (`PHOTO_AUTOWRITE_ENABLED`) is meant to be judged on
 * staged evidence, and on 2026-08-20 the review lane could not read it at all.
 * It also reported "exactly one real staged proposal" when prod held four — a
 * sample of one looks like a flawless classifier, which is precisely the wrong
 * impression to form before enabling an auto-writer that makes public factual
 * claims about real businesses.
 *
 * Hence the summary block: the denominator is the point.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, events, promoters } from "../src/schema.js";
import { BOOTH_PROPOSED_ACTION } from "../src/photo/booth-pipeline.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "k" };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mockIndexNowFetch();
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p1" }).run();
  db.insert(events)
    .values({
      id: "e1",
      name: "Winthrop Arts Festival 2026",
      slug: "winthrop-2026",
      promoterId: "p1",
      status: "APPROVED",
    })
    .run();
});

/** The four real prod payloads, in shape. */
function seedProposal(over: Record<string, unknown>, at = new Date("2026-08-16T02:00:00Z")) {
  db.insert(adminActions)
    .values({
      action: BOOTH_PROPOSED_ACTION,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: (over.targetId as string) ?? crypto.randomUUID(),
      payloadJson: JSON.stringify({ event_id: "e1", ...over }),
      createdAt: at,
    })
    .run();
}

function parse(r: unknown) {
  return JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
}

describe("list_photo_proposals", () => {
  it("returns the staged proposal with what was identified", async () => {
    seedProposal({
      photo_name: "PMI.jpg",
      business_name: "Paul Menice Images",
      products: ["photos", "prints"],
      confidence: 1,
      would_auto_write: true,
    });

    const out = parse(await server.invoke("list_photo_proposals", {}));
    expect(out.count).toBe(1);
    expect(out.proposals[0]).toMatchObject({
      business_name: "Paul Menice Images",
      confidence: 1,
      would_auto_write: true,
      event_name: "Winthrop Arts Festival 2026",
    });
  });

  it("reports the DENOMINATOR, not just the hits", async () => {
    // The 4 real prod rows: one confident write, one parse failure that had in
    // fact identified a business, two genuine non-identifications.
    seedProposal({
      photo_name: "PMI.jpg",
      business_name: "Paul Menice Images",
      confidence: 1,
      would_auto_write: true,
    });
    seedProposal({
      photo_name: "MV.jpg",
      confidence: 0,
      would_auto_write: false,
      failure_reason:
        'no-json-span len=203 text="{\\"business_name\\":\\"Mountain View Crochet Studio\\"',
      stage_reason: "could not tell what the photo shows",
    });
    seedProposal({
      photo_name: "P-P.jpg",
      confidence: 0,
      would_auto_write: false,
      failure_reason: "empty-text raw=object",
    });
    seedProposal({
      photo_name: "W_Fire.jpg",
      confidence: 0,
      would_auto_write: false,
      stage_reason: "could not tell what the photo shows",
    });

    const out = parse(await server.invoke("list_photo_proposals", {}));
    expect(out.summary).toEqual({
      total_staged: 4,
      would_have_written: 1,
      vision_failures: 2,
      identified_but_below_threshold: 0,
    });
    // 1 of 4, not 1 of 1 — the distinction the gate turns on.
    expect(out.summary.would_have_written).toBeLessThan(out.summary.total_staged);
  });

  it("separates a vision FAILURE from a confident 'cannot tell'", async () => {
    // Both stage. They need different fixes, so they must not read alike.
    seedProposal({
      photo_name: "a.jpg",
      failure_reason: "empty-text raw=object",
      would_auto_write: false,
    });
    seedProposal({
      photo_name: "b.jpg",
      stage_reason: "could not tell what the photo shows",
      would_auto_write: false,
    });

    const failed = parse(await server.invoke("list_photo_proposals", { failed_only: true }));
    expect(failed.count).toBe(1);
    expect(failed.proposals[0].photo_name).toBe("a.jpg");
  });

  it("filters to what would have been written", async () => {
    seedProposal({
      photo_name: "yes.jpg",
      business_name: "X",
      confidence: 1,
      would_auto_write: true,
    });
    seedProposal({ photo_name: "no.jpg", confidence: 0, would_auto_write: false });

    const yes = parse(await server.invoke("list_photo_proposals", { would_auto_write: true }));
    expect(yes.proposals.map((p: { photo_name: string }) => p.photo_name)).toEqual(["yes.jpg"]);
  });

  it("says why zero is zero", async () => {
    const out = parse(await server.invoke("list_photo_proposals", {}));
    expect(out.count).toBe(0);
    // "No proposals" and "the pipeline is switched off" are different facts.
    expect(out.note).toMatch(/PHOTO_VISION_ENABLED/);
  });

  it("surfaces an unparseable payload rather than dropping the row", async () => {
    db.insert(adminActions)
      .values({
        action: BOOTH_PROPOSED_ACTION,
        actorUserId: null,
        targetType: "inbound_email",
        targetId: "x",
        payloadJson: "{not json",
        createdAt: new Date("2026-08-16T02:00:00Z"),
      })
      .run();

    const out = parse(await server.invoke("list_photo_proposals", {}));
    // A writer change that broke the record format must be visible, not silent.
    expect(out.count).toBe(1);
    expect(out.proposals[0].rationale).toMatch(/did not parse/);
  });
});
