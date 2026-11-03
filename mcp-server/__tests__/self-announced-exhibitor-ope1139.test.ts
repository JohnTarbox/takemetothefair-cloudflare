/**
 * OPE-1139 — an exhibitor's own "visit us at Booth N" email records the
 * exhibitor. John's ruling (2026-09-30, option A): an existing vendor matched
 * exactly is linked live; a business not yet a vendor is STAGED, never created.
 *
 * The body below is the specimen's stored text (inbound 0cb048f4, Central
 * Coating Technologies' Constant Contact campaign), verbatim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventVendors, events, exhibitorProposals, promoters, vendors } from "../src/schema.js";
import {
  detectSelfAnnouncement,
  exhibitorIdentity,
  recordSelfAnnouncedExhibitor,
} from "../src/email-handlers/self-announcement.js";

const SPECIMEN =
  "Email from Central Coating Technologies Central Coating Technologies: Please be our guest at the Design 2 Part Show September 30th and October 1st in Marlborough   Come Visit Us at the 2026 D2P New England Trade Show Sept. 30th and Oct. 1st! Visit us at Booth 510 Click on the link below for FREE Registration FREE Registration Here Download Our Line Card! Central Coating Technologies, Inc. www.centralcoating.com   Central Coating Technologies | 165 Shrewsbury Street | West Boylston, MA 01583 US Unsubscribe | Update Profile | Constant Contact Data Notice";
const ORGANIZER_PROMO =
  "The 2026 D2P New England Trade Show returns Sept. 30th and Oct. 1st in Marlborough with 300 exhibitors. Register free today!";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const deps = {
  actorUserId: null,
  recomputeVendorCompleteness: vi.fn(async () => undefined),
  logEnrichment: vi.fn(async () => undefined),
};
const VERIFIED = {
  originalSenderAddress: "info@centralcoating.com",
  originalSenderAuth: "verified",
  originalSenderDomainAligned: 1,
};

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p1", companyName: "D2P", slug: "d2p" }).run();
  for (const id of ["d2p-2026", "other-show"]) {
    db.insert(events)
      .values({ id, name: id, slug: id, promoterId: "p1", status: "APPROVED" })
      .run();
  }
});
afterEach(() => mock.restore());

const linkRow = (eventId: string) =>
  db
    .select({
      vendorId: eventVendors.vendorId,
      booth: eventVendors.boothInfo,
      status: eventVendors.status,
    })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, eventId))
    .all();

describe("OPE-1139 detection and identity (pure)", () => {
  it("the specimen is a self-announcement for exactly Booth 510", () => {
    expect(detectSelfAnnouncement(SPECIMEN)).toEqual({
      phrase: "Come Visit Us",
      boothInfo: "Booth 510",
    });
  });
  it("an organizer's promo with no first person does not trigger", () => {
    expect(detectSelfAnnouncement(ORGANIZER_PROMO)).toBeNull();
  });
  it("first person without any exhibit/booth context does not trigger", () => {
    expect(detectSelfAnnouncement("Visit us at our website for spring hours!")).toBeNull();
  });
  it("several booth numbers name no booth rather than guessing", () => {
    expect(
      detectSelfAnnouncement("See us at Booth 12 in Boston and Booth 40 in Hartford")?.boothInfo
    ).toBeNull();
  });
  it("identity comes from the original sender's domain and the CAN-SPAM footer", () => {
    expect(exhibitorIdentity("info@centralcoating.com", SPECIMEN)).toEqual({
      domain: "centralcoating.com",
      website: "https://centralcoating.com",
      businessName: "Central Coating Technologies",
      city: "West Boylston",
      state: "MA",
    });
  });
  it("a freemail or our own domain never names a business (the forwarder is not the exhibitor)", () => {
    expect(exhibitorIdentity("jtarboxme@gmail.com", SPECIMEN)).toBeNull();
    expect(exhibitorIdentity("john@meetmeatthefair.com", SPECIMEN)).toBeNull();
  });
});

describe("OPE-1139 recordSelfAnnouncedExhibitor (test schema)", () => {
  it("ACCEPTANCE: an existing vendor on the sender's domain is linked live — CONFIRMED, Booth 510", async () => {
    await server.invoke("create_or_link_vendor", {
      event_id: "other-show",
      business_name: "Central Coating Technologies, Inc.",
      website: "https://www.centralcoating.com",
      dedup_strategy: "strict",
    });
    const before = db.select().from(vendors).all().length;

    const out = await recordSelfAnnouncedExhibitor(
      db,
      { eventId: "d2p-2026", inboundEmailId: "0cb048f4", body: SPECIMEN, ...VERIFIED },
      deps
    );
    expect(out).toMatchObject({ kind: "linked", matchedBy: "domain" });
    expect(db.select().from(vendors).all().length).toBe(before); // nothing created
    expect(linkRow("d2p-2026")).toEqual([
      { vendorId: (out as { vendorId: string }).vendorId, booth: "Booth 510", status: "CONFIRMED" },
    ]);

    // Idempotent: a workflow retry links nothing new.
    const again = await recordSelfAnnouncedExhibitor(
      db,
      { eventId: "d2p-2026", inboundEmailId: "0cb048f4", body: SPECIMEN, ...VERIFIED },
      deps
    );
    expect(again.kind).toBe("already_linked");
    expect(linkRow("d2p-2026")).toHaveLength(1);
  });

  it("ACCEPTANCE: a business that is not a vendor is STAGED, and no vendor row is created", async () => {
    const out = await recordSelfAnnouncedExhibitor(
      db,
      { eventId: "d2p-2026", inboundEmailId: "0cb048f4", body: SPECIMEN, ...VERIFIED },
      deps
    );
    expect(out).toMatchObject({ kind: "proposed", reason: "no_match" });
    expect(db.select().from(vendors).all()).toHaveLength(0);
    expect(linkRow("d2p-2026")).toHaveLength(0);
    const [p] = db.select().from(exhibitorProposals).all();
    expect(p).toMatchObject({
      eventId: "d2p-2026",
      inboundEmailId: "0cb048f4",
      businessName: "Central Coating Technologies",
      website: "https://centralcoating.com",
      boothInfo: "Booth 510",
      status: "pending",
    });
    // A replay stages nothing twice.
    await recordSelfAnnouncedExhibitor(
      db,
      { eventId: "d2p-2026", inboundEmailId: "0cb048f4", body: SPECIMEN, ...VERIFIED },
      deps
    );
    expect(db.select().from(exhibitorProposals).all()).toHaveLength(1);
  });

  it("declines an unverified or unaligned original sender, writing nothing", async () => {
    for (const fwd of [
      { ...VERIFIED, originalSenderAuth: "unverifiable_inline_forward" },
      { ...VERIFIED, originalSenderAuth: "failed" },
      { ...VERIFIED, originalSenderDomainAligned: 0 },
      { ...VERIFIED, originalSenderAuth: null },
    ]) {
      const out = await recordSelfAnnouncedExhibitor(
        db,
        { eventId: "d2p-2026", inboundEmailId: "x", body: SPECIMEN, ...fwd },
        deps
      );
      expect(out).toEqual({ kind: "declined", reason: "original_sender_not_verified" });
    }
    expect(db.select().from(exhibitorProposals).all()).toHaveLength(0);
  });

  it("declines an organizer promo even from a verified sender", async () => {
    const out = await recordSelfAnnouncedExhibitor(
      db,
      { eventId: "d2p-2026", inboundEmailId: "x", body: ORGANIZER_PROMO, ...VERIFIED },
      deps
    );
    expect(out.kind).toBe("declined");
    expect(db.select().from(exhibitorProposals).all()).toHaveLength(0);
  });
});

describe("OPE-1139 review_exhibitor_proposal", () => {
  const body = (res: unknown) =>
    JSON.parse((res as { content: { text: string }[] }).content[0].text);

  it("approve creates-or-links the vendor as CONFIRMED with the staged booth; reject writes no vendor", async () => {
    await recordSelfAnnouncedExhibitor(
      db,
      { eventId: "d2p-2026", inboundEmailId: "0cb048f4", body: SPECIMEN, ...VERIFIED },
      deps
    );
    const [{ id }] = db.select({ id: exhibitorProposals.id }).from(exhibitorProposals).all();
    const listed = body(await server.invoke("list_exhibitor_proposals", {}));
    expect(listed.count).toBe(1);

    const res = body(
      await server.invoke("review_exhibitor_proposal", { proposal_id: id, decision: "approve" })
    );
    expect(res).toMatchObject({
      ok: true,
      status: "approved",
      vendor_created: true,
      booth_info: "Booth 510",
    });
    expect(linkRow("d2p-2026")).toEqual([
      { vendorId: res.vendor_id, booth: "Booth 510", status: "CONFIRMED" },
    ]);
    // A second decision is refused, not repeated.
    expect(
      body(
        await server.invoke("review_exhibitor_proposal", { proposal_id: id, decision: "reject" })
      ).ok
    ).toBe(false);

    // A rejected proposal writes nothing to vendors.
    await recordSelfAnnouncedExhibitor(
      db,
      {
        eventId: "other-show",
        inboundEmailId: "e2",
        body: SPECIMEN.replace(/Central Coating Technologies/g, "Acme Plating"),
        ...VERIFIED,
        originalSenderAddress: "info@acmeplating.com",
      },
      deps
    );
    const [acme] = db
      .select({ id: exhibitorProposals.id })
      .from(exhibitorProposals)
      .where(
        and(eq(exhibitorProposals.eventId, "other-show"), eq(exhibitorProposals.status, "pending"))
      )
      .all();
    const vendorsBefore = db.select().from(vendors).all().length;
    expect(
      body(
        await server.invoke("review_exhibitor_proposal", {
          proposal_id: acme.id,
          decision: "reject",
        })
      ).status
    ).toBe("rejected");
    expect(db.select().from(vendors).all().length).toBe(vendorsBefore);
  });
});
