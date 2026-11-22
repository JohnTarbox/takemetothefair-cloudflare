/**
 * OPE-1697 — on 2026-11-21 the Snap page auto-pinned the nearer of two
 * same-day fairs ~350 m apart (Makers Market @ South Portland High School vs
 * First Light Church), and 11 of 13 photos auto-wrote CONFIRMED vendor links to
 * the wrong roster. The pin travelled as the `photos+<slug>@` override, which
 * skips every GPS check, so nothing on the server could object.
 *
 * These replay that geometry against a real SQLite:
 *   - the guard (`snapChoiceAmbiguity`) calls it ambiguous unless a person PICKED
 *   - the pipeline, told to hold, stages the would-write instead of writing
 *   - `repoint_photo_intake` moves the staged proposal and the written link
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import {
  adminActions,
  eventDays,
  eventVendors,
  events,
  inboundEmails,
  promoters,
  users,
  vendors,
  venues,
} from "../src/schema.js";
import { snapChoiceAmbiguity } from "../src/email-handlers/photo-intake.js";
import { runBoothPipeline, type BoothPipelineEnv } from "../src/photo/booth-pipeline.js";
import { repointPhotoIntake } from "../src/photo/repoint.js";
import { registerAdminTools } from "../src/tools/admin.js";
import type { CaptureMeta } from "../src/photo/snap-intake.js";
import type { Db } from "../src/db.js";

const DAY = "2026-11-21";
/** The re-geocoded SPHS pin, and the church ~335 m away (525 vs 637 Highland Ave). */
const SPHS = { latitude: 43.6220144, longitude: -70.2683686 };
const CHURCH = { latitude: 43.6232, longitude: -70.2645 };
const MM = "31e76477-e49d-4e27-805a-e496e5f6a5e6"; // Makers Market (the right fair)
const FL = "bf82e162-4cc6-44df-8bf6-8ecefc31cf95"; // First Light (the wrong one)

let db: TestDb;

function seedFairs() {
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(venues)
    .values([
      {
        id: "v-sphs",
        name: "South Portland High School",
        slug: "sphs",
        address: "Highland Ave",
        zip: "04106",
        city: "South Portland",
        state: "ME",
        ...SPHS,
      },
      {
        id: "v-church",
        name: "First Light Church",
        slug: "first-light",
        address: "Highland Ave",
        zip: "04106",
        city: "South Portland",
        state: "ME",
        ...CHURCH,
      },
    ] as never)
    .run();
  db.insert(events)
    .values([
      {
        id: MM,
        name: "Makers Market Christmas Arts & Craft Show 2026",
        slug: "makers-market-2026",
        promoterId: "p1",
        venueId: "v-sphs",
        status: "APPROVED",
        startDate: new Date(`${DAY}T00:00:00Z`),
        endDate: new Date(`${DAY}T00:00:00Z`),
      },
      {
        id: FL,
        name: "First Light Church Christmas Craft Fair",
        slug: "first-light-church-christmas-craft-fair",
        promoterId: "p1",
        venueId: "v-church",
        status: "APPROVED",
        startDate: new Date(`${DAY}T00:00:00Z`),
        endDate: new Date(`${DAY}T00:00:00Z`),
      },
    ] as never)
    .run();
  db.insert(eventDays)
    .values([
      { id: "d-mm", eventId: MM, date: DAY },
      { id: "d-fl", eventId: FL, date: DAY },
    ] as never)
    .run();
}

const meta = (over: Partial<CaptureMeta> = {}): CaptureMeta => ({
  client_id: "c1",
  captured_at: `${DAY}T13:34:00Z`,
  location: { ...SPHS, accuracy_m: 25 },
  location_source: "device",
  taken_on_local_date: DAY,
  event_id: FL,
  event_slug: "first-light-church-christmas-craft-fair",
  note: null,
  actor: "admin@example.test",
  ...over,
});

beforeEach(() => {
  ({ db } = createTestDb());
  seedFairs();
});

describe("snapChoiceAmbiguity — the 2026-11-21 geometry", () => {
  it("an un-picked upload at SPHS is ambiguous between BOTH fairs (old page build: no basis)", async () => {
    const r = await snapChoiceAmbiguity(
      db as unknown as Db,
      meta({ event_choice_basis: undefined })
    );
    expect(r.ambiguous).toBe(true);
    // Positive landmark: both fairs were found, nearest first.
    expect(r.candidates.map((c) => c.id)).toEqual([MM, FL]);
    expect(r.candidates[1].distanceMiles).toBeGreaterThan(0.15);
    expect(r.candidates[1].distanceMiles).toBeLessThan(0.3);
  });

  it("auto_single from the page is still checked — the server does not trust the page's count", async () => {
    const r = await snapChoiceAmbiguity(
      db as unknown as Db,
      meta({ event_choice_basis: "auto_single" })
    );
    expect(r.ambiguous).toBe(true);
  });

  it("a fair the person PICKED is trusted", async () => {
    const r = await snapChoiceAmbiguity(
      db as unknown as Db,
      meta({ event_choice_basis: "picked" })
    );
    expect(r.ambiguous).toBe(false);
  });

  it("one fair nearby is not ambiguous (the church fair on another day)", async () => {
    db.delete(eventDays).where(eq(eventDays.eventId, FL)).run();
    db.update(events)
      .set({
        startDate: new Date("2026-11-28T00:00:00Z"),
        endDate: new Date("2026-11-28T00:00:00Z"),
      } as never)
      .where(eq(events.id, FL))
      .run();
    const r = await snapChoiceAmbiguity(db as unknown as Db, meta());
    expect(r.ambiguous).toBe(false);
    expect(r.candidates.map((c) => c.id)).toEqual([MM]);
  });

  it("no location → not ambiguous (nothing to compare against)", async () => {
    const r = await snapChoiceAmbiguity(
      db as unknown as Db,
      meta({ location: null, location_source: "none" })
    );
    expect(r.ambiguous).toBe(false);
  });
});

function seedVendor(id: string, businessName: string, website: string | null = null) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.test`, role: "VENDOR" } as never)
    .run();
  db.insert(vendors)
    .values({ id, userId: `u-${id}`, businessName, slug: id, website } as never)
    .run();
}

describe("runBoothPipeline({ holdAutoWriteReason })", () => {
  // A booth that WOULD auto-write: an existing vendor, matched by its sign's domain.
  const env: BoothPipelineEnv = {
    AI: {
      run: async () => ({
        response: JSON.stringify({
          kind: "booth",
          name: "FirstLightNaturals.com",
          website: null,
          products: ["soap"],
          confidence: 1,
          rationale: "sign",
          identifiable_minor: false,
          mounted_on: "vendor_table_or_tent",
        }),
      }),
    },
    VENDOR_ASSETS: {
      get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
    } as unknown as R2Bucket,
    PHOTO_VISION_ENABLED: "true",
    PHOTO_AUTOWRITE_ENABLED: "true",
  };
  const photos = [{ key: "inbound-attachments/snap-x/0.jpg", name: "0.jpg" }];
  const linksOn = (eventId: string) =>
    db.select().from(eventVendors).where(eq(eventVendors.eventId, eventId)).all().length;

  beforeEach(() => seedVendor("fln", "First Light Naturals", "https://firstlightnaturals.com"));

  it("control: without a hold the same photo DOES write the link (so the hold below is load-bearing)", async () => {
    const res = await runBoothPipeline(env, db as unknown as Db, "snap-x", FL, photos);
    expect(res.autoWritten).toHaveLength(1);
    expect(linksOn(FL)).toBe(1);
  });

  it("with a hold: nothing written, the would-write is staged as event_choice_ambiguous", async () => {
    const res = await runBoothPipeline(env, db as unknown as Db, "snap-x", FL, photos, {
      holdAutoWriteReason: "fair not picked; 2 same-day fairs within 1.5 mi",
    });
    expect(res.autoWritten).toEqual([]);
    expect(linksOn(FL)).toBe(0);
    expect(res.staged).toBe(1);
    const p = JSON.parse(
      db
        .select()
        .from(adminActions)
        .all()
        .find((r) => r.action === "vendor.photo_proposed")!.payloadJson!
    );
    expect(p.stage_kind).toBe("event_choice_ambiguous");
    expect(p.would_auto_write).toBe(true);
    expect(p.stage_reason).toContain("not picked");
  });
});

describe("repoint_photo_intake — the two staged First Light proposals and a written link", () => {
  const ROW = "snap-b618e77b-1557-4209-80df-374c870b62fe";
  const PROPOSAL = "c0f1c209-a68e-4b4e-a777-18e3be9a77b1";
  const RESOLVED = "resolved-proposal";

  beforeEach(() => {
    seedVendor("wine", "Wine Ought?");
    seedVendor("mcw", "Maine Cardworks");
    seedVendor("fln", "First Light Naturals");
    db.insert(inboundEmails)
      .values({
        id: ROW,
        receivedAt: new Date(`${DAY}T13:40:00Z`),
        fromAddress: "admin@example.test",
        toAddress: "photos+first-light-church-christmas-craft-fair@meetmeatthefair.com",
        intent: "photo_intake",
        status: "replied",
        attachmentCount: 1,
        routingSource: "snap-app",
        resultingEventId: FL,
        captureMeta: JSON.stringify(meta()),
        createdAt: new Date(`${DAY}T13:40:00Z`),
      } as never)
      .run();
    const at = new Date(`${DAY}T13:41:00Z`);
    const action = (
      id: string,
      a: string,
      payload: Record<string, unknown>,
      targetId = ROW,
      targetType = "inbound_email"
    ) =>
      db
        .insert(adminActions)
        .values({
          id,
          action: a,
          actorUserId: null,
          targetType,
          targetId,
          payloadJson: JSON.stringify(payload),
          createdAt: at,
        } as never)
        .run();
    action(PROPOSAL, "vendor.photo_proposed", {
      event_id: FL,
      photo_key: "k0",
      business_name: "Wine Ought?",
    });
    action(RESOLVED, "vendor.photo_proposed", {
      event_id: FL,
      photo_key: "k1",
      business_name: "X",
    });
    action("res-1", "vendor.photo_resolved", { resolution: "rejected" }, RESOLVED, "admin_action");
    // A link this upload CREATED on First Light, and one that already existed there.
    db.insert(eventVendors)
      .values({ id: "ev-mcw", eventId: FL, vendorId: "mcw", status: "CONFIRMED" } as never)
      .run();
    db.insert(eventVendors)
      .values({ id: "ev-fln", eventId: FL, vendorId: "fln", status: "CONFIRMED" } as never)
      .run();
    action("aw-1", "vendor.photo_autowritten", {
      event_id: FL,
      photo_key: "k2",
      vendor_id: "mcw",
      business_name: "Maine Cardworks",
      was_linked: true,
      was_already_linked: false,
    });
    action("aw-2", "vendor.photo_autowritten", {
      event_id: FL,
      photo_key: "k3",
      vendor_id: "fln",
      business_name: "First Light Naturals",
      was_linked: false,
      was_already_linked: true,
    });
  });

  const vendorsOn = (eventId: string) =>
    db
      .select()
      .from(eventVendors)
      .where(eq(eventVendors.eventId, eventId))
      .all()
      .map((r) => r.vendorId)
      .sort();
  const payloadOf = (id: string) =>
    JSON.parse(db.select().from(adminActions).where(eq(adminActions.id, id)).get()!.payloadJson!);

  it("dry run reports the plan and writes nothing", async () => {
    const r = await repointPhotoIntake(db as unknown as Db, {
      proposalId: PROPOSAL,
      toEventId: MM,
      dryRun: true,
      actorUserId: "u-admin",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inbound_email_id).toBe(ROW);
    expect(r.proposals_moved).toEqual([PROPOSAL]);
    expect(r.proposals_already_resolved).toEqual([RESOLVED]);
    expect(r.links_moved.map((l) => l.vendor_id)).toEqual(["mcw"]);
    expect(r.links_added_kept_on_from.map((l) => l.vendor_id)).toEqual(["fln"]);
    expect(payloadOf(PROPOSAL).event_id).toBe(FL);
    expect(vendorsOn(FL)).toEqual(["fln", "mcw"]);
    expect(vendorsOn(MM)).toEqual([]);
  });

  it("live: proposal and created link move; the pre-existing link stays and is added; the row is re-pointed; a re-run is a no-op", async () => {
    const r = await repointPhotoIntake(db as unknown as Db, {
      proposalId: PROPOSAL,
      toEventId: MM,
      dryRun: false,
      actorUserId: "u-admin",
    });
    expect(r.ok).toBe(true);
    expect(payloadOf(PROPOSAL).event_id).toBe(MM);
    expect(payloadOf(PROPOSAL).repointed_from).toBe(FL);
    expect(payloadOf(RESOLVED).event_id).toBe(FL); // resolved: reported, not moved
    expect(vendorsOn(FL)).toEqual(["fln"]);
    expect(vendorsOn(MM)).toEqual(["fln", "mcw"]);
    const row = db.select().from(inboundEmails).where(eq(inboundEmails.id, ROW)).get()!;
    expect(row.resultingEventId).toBe(MM);
    const cm = JSON.parse(row.captureMeta!) as CaptureMeta;
    expect(cm.event_id).toBe(MM);
    expect(cm.event_choice_basis).toBe("picked");
    const audits = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "photo_intake.repointed"))
      .all();
    expect(audits).toHaveLength(1);

    const again = await repointPhotoIntake(db as unknown as Db, {
      inboundEmailId: ROW,
      toEventId: MM,
      dryRun: false,
      actorUserId: "u-admin",
    });
    expect(again.ok && again.already_on_target).toBe(true);
    expect(
      db.select().from(adminActions).where(eq(adminActions.action, "photo_intake.repointed")).all()
    ).toHaveLength(1);
    expect(vendorsOn(MM)).toEqual(["fln", "mcw"]);
  });

  it("a link already moved by hand (the 11-21 cleanup) is not duplicated", async () => {
    db.update(eventVendors)
      .set({ eventId: MM } as never)
      .where(eq(eventVendors.id, "ev-mcw"))
      .run();
    const r = await repointPhotoIntake(db as unknown as Db, {
      inboundEmailId: ROW,
      toEventId: MM,
      dryRun: false,
      actorUserId: null,
    });
    expect(r.ok && r.links_moved).toEqual([]);
    expect(vendorsOn(MM)).toEqual(["fln", "mcw"]);
  });

  it("refuses a merged target and an unknown proposal", async () => {
    db.update(events)
      .set({ mergedInto: FL } as never)
      .where(eq(events.id, MM))
      .run();
    const merged = await repointPhotoIntake(db as unknown as Db, {
      inboundEmailId: ROW,
      toEventId: MM,
      dryRun: false,
      actorUserId: null,
    });
    expect(merged.ok).toBe(false);
    const unknown = await repointPhotoIntake(db as unknown as Db, {
      proposalId: "nope",
      toEventId: FL,
      dryRun: true,
      actorUserId: null,
    });
    expect(unknown.ok).toBe(false);
  });

  it("is registered as an MCP tool and defaults to a dry run", async () => {
    const server = new CapturingMcpServer();
    registerAdminTools(server as never, db, { userId: "u-admin", role: "ADMIN" }, {
      MAIN_APP_URL: "https://meetmeatthefair.com",
      INTERNAL_API_KEY: "k",
    } as never);
    mockIndexNowFetch();
    const out = JSON.parse(
      (
        (await server.invoke("repoint_photo_intake", {
          proposal_id: PROPOSAL,
          to_event_id: MM,
        })) as {
          content: Array<{ text: string }>;
        }
      ).content[0].text
    );
    expect(out.dry_run).toBe(true);
    expect(out.proposals_moved).toEqual([PROPOSAL]);
    expect(payloadOf(PROPOSAL).event_id).toBe(FL);
  });
});
