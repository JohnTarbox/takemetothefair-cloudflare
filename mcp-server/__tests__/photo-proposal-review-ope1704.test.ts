/**
 * OPE-1704 — `review_photo_proposal` + `list_photo_proposals({ status })`.
 *
 * On 2026-11-22 the booth-photo queue held 63 staged proposals and nothing over
 * MCP could close one. Six Makers Market booths had been cleared by hand and
 * still read as waiting, so "what's left?" had no answer. These tests pin the
 * ticket's five acceptance clauses, plus the two ways the fix could quietly
 * not work: a decision made in the admin UI not counting here, and `limit`
 * truncating before the status filter.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, eventVendors, events, promoters, users, vendors } from "../src/schema.js";
import { BOOTH_PROPOSED_ACTION, PERFORMER_PROPOSED_ACTION } from "../src/photo/booth-pipeline.js";
import { PHOTO_RESOLVED_ACTION } from "../src/photo/repoint.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;
/** Every upload the approve path sent to the main app: target + role. */
let uploads: Array<{ targetId: string; role: string }>;

beforeEach(() => {
  ({ db } = createTestDb());
  uploads = [];
  const env = {
    MAIN_APP_URL: "https://meetmeatthefair.com",
    INTERNAL_API_KEY: "k",
    VENDOR_ASSETS: {
      get: async () => ({
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        httpMetadata: { contentType: "image/jpeg" },
      }),
    },
    MAIN_APP: {
      fetch: async (req: Request) => {
        if (req.url.endsWith("/api/admin/upload-image-bytes")) {
          const form = await req.formData();
          uploads.push({
            targetId: String(form.get("target_id")),
            role: String(form.get("image_role")),
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, env as never);
  mockIndexNowFetch();
  db.insert(users)
    .values({ id: "u-admin", email: "admin@example.test", role: "ADMIN" } as never)
    .run();
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p1" }).run();
  db.insert(events)
    .values({
      id: "mm",
      name: "Makers Market Christmas Arts & Craft Show",
      slug: "makers-market-2026",
      promoterId: "p1",
      status: "APPROVED",
    })
    .run();
});

function seedProposal(
  id: string,
  over: Record<string, unknown> = {},
  at = new Date("2026-11-22T15:00:00Z"),
  action = BOOTH_PROPOSED_ACTION
) {
  db.insert(adminActions)
    .values({
      id,
      action,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: `snap-${id}`,
      payloadJson: JSON.stringify({
        event_id: "mm",
        photo_key: `inbound-attachments/snap-${id}/0.jpg`,
        photo_name: "0.jpg",
        ...over,
      }),
      createdAt: at,
    } as never)
    .run();
}

function seedVendor(id: string, businessName: string, extra: Record<string, unknown> = {}) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.test`, role: "VENDOR" } as never)
    .run();
  db.insert(vendors)
    .values({ id, userId: `u-${id}`, businessName, slug: id, ...extra } as never)
    .run();
}

const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const review = (args: Record<string, unknown>) => server.invoke("review_photo_proposal", args);
const list = async (args: Record<string, unknown> = {}) =>
  parse(await server.invoke("list_photo_proposals", args));
const resolutionRows = (proposalId: string) =>
  db
    .select()
    .from(adminActions)
    .where(eq(adminActions.action, PHOTO_RESOLVED_ACTION))
    .all()
    .filter((r) => r.targetId === proposalId);
const vendorCount = () => db.select().from(vendors).all().length;
const linksOn = (eventId: string) =>
  db.select().from(eventVendors).where(eq(eventVendors.eventId, eventId)).all();

describe("list_photo_proposals status filter", () => {
  it("returns only OPEN proposals by default, and reports each row's status", async () => {
    seedProposal("a", { business_name: "Alpha Pottery" });
    seedProposal("b", { business_name: "Beta Soaps" });
    await review({ proposal_id: "b", decision: "reject", note: "not a booth" });

    const open = await list();
    expect(open.status_filter).toBe("open");
    expect(open.proposals.map((p: { id: string }) => p.id)).toEqual(["a"]);
    expect(open.proposals[0].status).toBe("open");

    const all = await list({ status: "all" });
    const byId = Object.fromEntries(all.proposals.map((p: { id: string }) => [p.id, p]));
    expect(byId.a.status).toBe("open");
    expect(byId.b).toMatchObject({
      status: "rejected",
      resolved_by: "u-admin",
      resolution_note: "not a booth",
    });

    expect((await list({ status: "rejected" })).proposals.map((p: { id: string }) => p.id)).toEqual(
      ["b"]
    );
    expect((await list({ status: "approved" })).count).toBe(0);
  });

  it("counts a decision made in the ADMIN UI route as resolved", async () => {
    seedProposal("ui", { business_name: "Gamma Glass" });
    // Exactly the row shape booth-proposals/resolve/route.ts writes.
    db.insert(adminActions)
      .values({
        action: PHOTO_RESOLVED_ACTION,
        actorUserId: "u-admin",
        targetType: "admin_action",
        targetId: "ui",
        payloadJson: JSON.stringify({ resolution: "approved", vendor_id: "v-g" }),
        createdAt: new Date("2026-11-22T16:00:00Z"),
      } as never)
      .run();

    expect((await list()).count).toBe(0);
    const approved = await list({ status: "approved" });
    expect(approved.proposals[0]).toMatchObject({ id: "ui", resolved_vendor_id: "v-g" });

    const again = parse(await review({ proposal_id: "ui", decision: "reject" }));
    expect(again).toMatchObject({ already_resolved: true, resolution: "approved" });
  });

  it("applies `limit` AFTER the status filter, not before", async () => {
    // Three newer resolved rows would fill a limit:1 page if the filter ran in memory.
    seedProposal("old-open", {}, new Date("2026-08-16T00:00:00Z"));
    for (const id of ["r1", "r2", "r3"]) {
      seedProposal(id, {}, new Date("2026-11-22T12:00:00Z"));
      await review({ proposal_id: id, decision: "already_handled" });
    }
    const out = await list({ limit: 1 });
    expect(out.proposals.map((p: { id: string }) => p.id)).toEqual(["old-open"]);
  });
});

describe("review_photo_proposal — approve", () => {
  it("an unreadable sign is refused without a name, and writes nothing", async () => {
    seedProposal("t1", { business_name: null, stage_kind: "booth_name_unreadable" });
    const before = vendorCount();
    const r = await review({ proposal_id: "t1", decision: "approve" });
    expect(isError(r)).toBe(true);
    expect(parse(r).code).toBe("no_name");
    expect(vendorCount()).toBe(before);
    expect(resolutionRows("t1")).toHaveLength(0);
    expect((await list()).count).toBe(1);
  });

  it("with a business_name override: creates the vendor, links it CONFIRMED, sets the logo, leaves the open list", async () => {
    // The House of Tiberius specimen: a clear carved sign the model could not read.
    seedProposal("14313d82", {
      business_name: null,
      stage_kind: "booth_name_unreadable",
      confidence: 0.8,
    });
    const r = parse(
      await review({
        proposal_id: "14313d82",
        decision: "approve",
        business_name: "House of Tiberius Leather Co.",
      })
    );
    expect(r).toMatchObject({ ok: true, already_resolved: false, resolution: "approved" });
    expect(r.detail).toMatchObject({ was_created: true, photo_written_as: "logo", hero_set: true });

    const [v] = db.select().from(vendors).where(eq(vendors.id, r.detail.vendor_id)).all();
    expect(v.businessName).toBe("House of Tiberius Leather Co.");
    const [link] = linksOn("mm");
    expect(link).toMatchObject({
      vendorId: v.id,
      status: "CONFIRMED",
      participationType: "EXHIBITOR",
    });
    expect(uploads).toEqual([{ targetId: v.id, role: "logo" }]);

    expect((await list()).count).toBe(0);
    expect((await list({ status: "approved" })).proposals[0].resolved_vendor_id).toBe(v.id);
  });

  it("a vendor that already has a logo gets the photo in its GALLERY; the logo is untouched", async () => {
    seedVendor("v-delta", "Delta Woodworks", { logoUrl: "https://cdn.example/delta-logo.webp" });
    seedProposal("t2", { business_name: "Delta Woodworks" });
    const r = parse(await review({ proposal_id: "t2", decision: "approve" }));
    expect(r.detail).toMatchObject({
      vendor_id: "v-delta",
      was_created: false,
      photo_written_as: "gallery",
      hero_set: false,
    });
    expect(uploads).toEqual([{ targetId: "v-delta", role: "gallery" }]);
    const [v] = db.select().from(vendors).where(eq(vendors.id, "v-delta")).all();
    expect(v.logoUrl).toBe("https://cdn.example/delta-logo.webp");
  });

  it("dedups strictly: a near-miss name does NOT link a different vendor", async () => {
    seedVendor("v-eps", "Epsilon Candles");
    seedProposal("t3", { business_name: "Epsilon Candle Co" });
    const r = parse(await review({ proposal_id: "t3", decision: "approve" }));
    expect(r.detail.vendor_id).not.toBe("v-eps");
    expect(r.detail.was_created).toBe(true);
  });

  it("vendor_id links THAT vendor, even when the model read another name", async () => {
    seedVendor("v-zeta", "Zeta Farm Stand");
    seedProposal("t4", { business_name: "Welcome" });
    const before = vendorCount();
    const r = parse(await review({ proposal_id: "t4", decision: "approve", vendor_id: "v-zeta" }));
    expect(r.detail).toMatchObject({ vendor_id: "v-zeta", match_basis: "id", was_created: false });
    expect(vendorCount()).toBe(before);
    expect(linksOn("mm").map((l) => l.vendorId)).toEqual(["v-zeta"]);
  });

  it("vendor_id follows a merge redirect, and refuses a deleted vendor", async () => {
    seedVendor("v-live", "Eta Jewelry");
    seedVendor("v-alias", "Eta Jewellery", {
      redirectToVendorId: "v-live",
      deletedAt: new Date("2026-10-01T00:00:00Z"),
    });
    seedVendor("v-gone", "Theta Gone", { deletedAt: new Date("2026-10-01T00:00:00Z") });
    seedProposal("t5", { business_name: "Eta" });
    seedProposal("t6", { business_name: "Theta" });

    const r = parse(await review({ proposal_id: "t5", decision: "approve", vendor_id: "v-alias" }));
    expect(r.detail.vendor_id).toBe("v-live");

    const gone = await review({ proposal_id: "t6", decision: "approve", vendor_id: "v-gone" });
    expect(isError(gone)).toBe(true);
    expect(resolutionRows("t6")).toHaveLength(0);
  });

  it("a performer proposal cannot be approved here (it can be closed)", async () => {
    seedProposal("perf", { performer_name: "The Fiddlers" }, undefined, PERFORMER_PROPOSED_ACTION);
    const r = await review({ proposal_id: "perf", decision: "approve", business_name: "X" });
    expect(isError(r)).toBe(true);
    expect(parse(r).code).toBe("not_booth");
    expect(vendorCount()).toBe(0);
    const closed = parse(await review({ proposal_id: "perf", decision: "already_handled" }));
    expect(closed.resolution).toBe("already_handled");
  });
});

describe("review_photo_proposal — reject / already_handled / once only", () => {
  it("already_handled closes the hand-cleared Makers Market rows and writes nothing else", async () => {
    const ids = ["mm1", "mm2", "mm3", "mm4", "mm5", "mm6"];
    for (const id of ids) seedProposal(id, { business_name: `Booth ${id}` });
    const vendorsBefore = vendorCount();
    for (const id of ids) {
      const r = parse(
        await review({
          proposal_id: id,
          decision: "already_handled",
          note: "cleared by hand 11-22",
        })
      );
      expect(r.resolution).toBe("already_handled");
    }
    expect(vendorCount()).toBe(vendorsBefore);
    expect(linksOn("mm")).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect((await list()).count).toBe(0);
    expect((await list({ status: "already_handled" })).count).toBe(6);
  });

  it("a second resolve is a no-op that returns the FIRST decision", async () => {
    seedProposal("twice", { business_name: "Iota Quilts" });
    const first = parse(await review({ proposal_id: "twice", decision: "approve" }));
    const vendorsAfterFirst = vendorCount();
    const second = parse(await review({ proposal_id: "twice", decision: "reject" }));
    expect(second).toMatchObject({
      ok: true,
      already_resolved: true,
      resolution: "approved",
    });
    expect(second.detail.vendor_id).toBe(first.detail.vendor_id);
    expect(resolutionRows("twice")).toHaveLength(1);
    expect(vendorCount()).toBe(vendorsAfterFirst);
    expect(uploads).toHaveLength(1);
  });

  it("refuses an id that is not a photo proposal, and approve-only args on a reject", async () => {
    const r = await review({ proposal_id: "nope", decision: "reject" });
    expect(isError(r)).toBe(true);
    expect(parse(r).code).toBe("not_found");

    seedProposal("k", { business_name: "Kappa" });
    const bad = await review({ proposal_id: "k", decision: "reject", vendor_id: "v-x" });
    expect(isError(bad)).toBe(true);
    expect(resolutionRows("k")).toHaveLength(0);
  });
});
