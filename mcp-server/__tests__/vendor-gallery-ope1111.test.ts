/**
 * OPE-1111 — a vendor's gallery is public, and `get_vendor_details` says so.
 *
 * ── What actually broke ───────────────────────────────────────────────────
 *
 * The gallery was never unwired. `getVendorGallery` read `vendor_photos`
 * correctly from 2026-08-30 onward; the vendor page fetched the photos and
 * then rendered them inside `{isEnhanced && …}`. Enhanced Profile is a $29/yr
 * tier with **2 members out of 7,331 vendors**, and all 26 vendors who had
 * ever uploaded a photo were outside it. So the gate's pass rate over its
 * entire life was zero: 72 photos, 26 makers, nothing ever shown.
 *
 * Meanwhile the upload path was not gated at all. Any claimed vendor could
 * fill a gallery that could not be displayed to anyone, including herself.
 * The first report came from the maker who uploaded one — three minutes after
 * claiming her listing — not from us.
 *
 * ── Why the tests below are shaped this way ───────────────────────────────
 *
 * A DB assertion would have passed every day for those 23 days: the rows were
 * there and correct. So the tests that matter here are the ones that ask what
 * a PUBLIC READER returns, and they pin the tier-independence explicitly —
 * because "gallery comes back" is satisfied by a fixture that happens to be
 * enhanced, and that is precisely the bug walking back in.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPublicTools } from "../src/tools/public.js";
import { users, vendors, vendorPhotos } from "../src/schema.js";
import { unsafeSlug } from "@takemetothefair/utils";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerPublicTools(server as never, db);
  db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
});

/** A claimed, NON-enhanced vendor — the shape all 26 real ones have. */
function seedVendor(over: Record<string, unknown> = {}) {
  db.insert(vendors)
    .values({
      id: "ven-1",
      userId: "u-v",
      businessName: "7th Star Bags",
      slug: unsafeSlug("7th-star-bags"),
      claimed: true,
      enhancedProfile: false,
      ...over,
    })
    .run();
}

function seedPhoto(over: Record<string, unknown> = {}) {
  db.insert(vendorPhotos)
    .values({
      id: "p-1",
      vendorId: "ven-1",
      photoUrl: "https://cdn.meetmeatthefair.com/v/honey-bee-bag.jpg",
      altText: "Honey Bee hexagon crossbody bag",
      sortOrder: 0,
      isFeatured: false,
      // NOT NULL on the real table with no DB default. Omitting them here is
      // a fixture bug that surfaces as a constraint error, not as a finding.
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    })
    .run();
}

const body = (r: { content: { text?: string }[] }) => JSON.parse(r.content[0].text ?? "{}");

const read = (slug = "7th-star-bags") =>
  server.invoke("get_vendor_details", { slug }) as Promise<{ content: { text?: string }[] }>;

describe("OPE-1111 — the public reader returns the gallery", () => {
  it("ACCEPTANCE: a NON-enhanced claimed vendor's photo comes back", async () => {
    seedVendor();
    seedPhoto();

    const res = body(await read());

    expect(res.galleryCount).toBe(1);
    expect(res.gallery).toHaveLength(1);
    expect(res.gallery[0].url).toBe("https://cdn.meetmeatthefair.com/v/honey-bee-bag.jpg");
    // alt text is an acceptance criterion in its own right — it is what a
    // screen reader announces and what a crawler reads.
    expect(res.gallery[0].alt).toBe("Honey Bee hexagon crossbody bag");
  });

  it("LANDMARK: the enhanced vendor gets exactly the same answer", async () => {
    // Without this, every assertion above is satisfied by a reader that still
    // consults the tier and simply has a lucky fixture. The whole defect was
    // a tier-dependent gallery, so tier-independence is the property to pin,
    // and it can only be pinned by comparing the two.
    seedVendor({ enhancedProfile: true });
    seedPhoto();

    const enhanced = body(await read());
    expect(enhanced.galleryCount).toBe(1);
    expect(enhanced.gallery[0].url).toBe("https://cdn.meetmeatthefair.com/v/honey-bee-bag.jpg");
  });

  it("an empty gallery is [] and 0, never an absent key", async () => {
    // The reader's SILENCE is what hid this for 23 days: a missing field and
    // an empty gallery read identically, so no check could tell "this vendor
    // has no photos" from "this surface has no opinion about photos".
    seedVendor();

    const res = body(await read());
    expect(res).toHaveProperty("gallery");
    expect(res.gallery).toEqual([]);
    expect(res.galleryCount).toBe(0);
  });
});

describe("OPE-1111 — ordering and tombstones survive the move to the reader", () => {
  it("a featured photo leads, whatever its sort_order", async () => {
    seedVendor();
    seedPhoto({ id: "p-1", photoUrl: "https://cdn/x/first.jpg", sortOrder: 0, isFeatured: false });
    seedPhoto({ id: "p-2", photoUrl: "https://cdn/x/hero.jpg", sortOrder: 5, isFeatured: true });

    const res = body(await read());
    expect(res.gallery.map((g: { url: string }) => g.url)).toEqual([
      "https://cdn/x/hero.jpg",
      "https://cdn/x/first.jpg",
    ]);
  });

  it("a soft-deleted photo is not public", async () => {
    seedVendor();
    seedPhoto({ id: "p-1", photoUrl: "https://cdn/x/live.jpg" });
    seedPhoto({ id: "p-2", photoUrl: "https://cdn/x/gone.jpg", deletedAt: new Date() });

    const res = body(await read());
    expect(res.galleryCount).toBe(1);
    expect(res.gallery[0].url).toBe("https://cdn/x/live.jpg");
  });
});

describe("OPE-1111 — the legacy column still renders", () => {
  it("falls back to gallery_images when the table has no rows", async () => {
    // The backfill that would retire this column is STOP-gated and unapproved,
    // so a vendor whose only photos live in the JSON must keep showing them.
    seedVendor({
      galleryImages: JSON.stringify([{ url: "https://cdn/x/legacy.jpg", alt: "Legacy booth" }]),
    });

    const res = body(await read());
    expect(res.galleryCount).toBe(1);
    expect(res.gallery[0].url).toBe("https://cdn/x/legacy.jpg");
    expect(res.gallery[0].isLegacy).toBe(true);
  });

  it("one table row makes the vendor migrated — the legacy JSON is ignored, not merged", async () => {
    // Merging would double-render anything the eventual backfill copies
    // across, and a duplicated photo is worse than an un-migrated one.
    seedVendor({
      galleryImages: JSON.stringify([{ url: "https://cdn/x/legacy.jpg", alt: "Legacy booth" }]),
    });
    seedPhoto({ photoUrl: "https://cdn/x/table.jpg" });

    const res = body(await read());
    expect(res.galleryCount).toBe(1);
    expect(res.gallery[0].url).toBe("https://cdn/x/table.jpg");
  });
});
