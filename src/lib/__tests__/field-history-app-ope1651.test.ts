/**
 * OPE-1651 — field-level edit history, app side.
 *
 * Acceptance from the ticket:
 *   - a self-edit from a vendor account writes rows attributed to that
 *     vendor's user;
 *   - an image upload (the `request_image_upload_slot` → upload pipeline path)
 *     writes a row for the image column;
 *   - a no-op write writes no row.
 *
 * Runs on the MCP harness's schema (it loads drizzle/0420 itself), so the
 * table under test is the migration prod runs, not a hand copy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createTestDb } from "../../../mcp-server/__tests__/setup-db";
import { entityFieldHistory, events, promoters, users, vendors } from "@/lib/db/schema";

let db: ReturnType<typeof createTestDb>["db"];
const VENDOR_USER = "u-vendor-owner";

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({
    ok: true,
    userId: VENDOR_USER,
    email: "owner@example.com",
  })),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@/lib/indexnow", () => ({
  indexNowUrlFor: () => "https://meetmeatthefair.com/x",
  pingIndexNow: vi.fn(async () => undefined),
}));
vi.mock("@/lib/completeness", () => ({
  recomputeVendorCompleteness: vi.fn(async () => undefined),
  recomputeEventCompleteness: vi.fn(async () => undefined),
}));

import { PATCH as vendorProfilePatch } from "@/app/api/vendor/profile/route";
import { writeImageWithHistory } from "@/lib/upload-image-pipeline";

function history() {
  return db.select().from(entityFieldHistory).all();
}

function patchReq(body: unknown) {
  return new NextRequest("https://meetmeatthefair.com/api/vendor/profile", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(users).values({ id: VENDOR_USER, email: "owner@example.com", role: "VENDOR" }).run();
  db.insert(vendors)
    .values({
      id: "v-1",
      userId: VENDOR_USER,
      businessName: "Acme Soap",
      slug: "acme-soap" as never,
      description: "Old blurb.",
      city: "Bangor",
    })
    .run();
});

describe("OPE-1651 — vendor self-edit writes history attributed to the vendor's user", () => {
  it("writes one row per changed field, actor = the vendor's user id", async () => {
    const res = await vendorProfilePatch(patchReq({ description: "New blurb.", city: "Bangor" }));
    expect(res.status).toBe(200);

    const rows = history();
    // city was resent unchanged → no row for it; description changed → one row.
    expect(rows).toEqual([
      expect.objectContaining({
        entityType: "vendor",
        entityId: "v-1",
        field: "description",
        oldValue: "Old blurb.",
        newValue: "New blurb.",
        actor: VENDOR_USER,
        source: "api:PATCH /api/vendor/profile",
      }),
    ]);
  });

  it("a no-op resubmit writes NO row — landmark: the save returned 200", async () => {
    const res = await vendorProfilePatch(patchReq({ description: "Old blurb." }));
    expect(res.status).toBe(200);
    expect(history()).toHaveLength(0);
  });
});

describe("OPE-1651 — the image-upload write records what it replaced", () => {
  beforeEach(() => {
    db.insert(promoters)
      .values({ id: "p-1", companyName: "P", slug: "p" as never })
      .run();
    db.insert(events)
      .values({
        id: "ev-1",
        name: "Downeast Fair",
        slug: "downeast-fair" as never,
        promoterId: "p-1",
        imageUrl: "https://cdn.meetmeatthefair.com/old.jpg",
      })
      .run();
  });

  it("writes an image_url row with the old and new URL and the upload surface", async () => {
    await writeImageWithHistory(
      db as never,
      "event",
      "ev-1",
      { imageUrl: "https://cdn.meetmeatthefair.com/new.jpg" },
      "mcp-server",
      "admin-upload-image-slot"
    );
    const [ev] = db.select().from(events).all();
    expect(ev.imageUrl).toBe("https://cdn.meetmeatthefair.com/new.jpg");
    expect(history()).toEqual([
      expect.objectContaining({
        entityType: "event",
        entityId: "ev-1",
        field: "image_url",
        oldValue: "https://cdn.meetmeatthefair.com/old.jpg",
        newValue: "https://cdn.meetmeatthefair.com/new.jpg",
        actor: "mcp-server",
        source: "upload:admin-upload-image-slot",
      }),
    ]);
  });

  it("an upload with no user id is attributed to system:<surface>", async () => {
    await writeImageWithHistory(
      db as never,
      "event",
      "ev-1",
      { imageUrl: "https://cdn.meetmeatthefair.com/new.jpg" },
      "",
      "photo-autowrite"
    );
    expect(history()[0].actor).toBe("system:photo-autowrite");
  });

  it("re-uploading the same URL writes no row; a missing target writes no row", async () => {
    await writeImageWithHistory(
      db as never,
      "event",
      "ev-1",
      { imageUrl: "https://cdn.meetmeatthefair.com/old.jpg" },
      "u-admin",
      "x"
    );
    await writeImageWithHistory(
      db as never,
      "event",
      "no-such-event",
      { imageUrl: "https://cdn.meetmeatthefair.com/new.jpg" },
      "u-admin",
      "x"
    );
    expect(history()).toHaveLength(0);
  });
});
