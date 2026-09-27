/**
 * OPE-1171 — what a PUBLIC reader says about each gallery photo's text.
 *
 * OPE-1111's acceptance asked for photos "with `alt` text" and was called
 * green on the strength of the images rendering. On 2026-09-27, 104 of 105
 * live vendor photos rendered `alt=""`. These tests ask the reader, not the
 * table, because a table check was exactly what passed while the page failed.
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
  db.insert(vendors)
    .values({
      id: "ven-1",
      userId: "u-v",
      businessName: "7th Star Bags",
      slug: unsafeSlug("7th-star-bags"),
      claimed: true,
    })
    .run();
});

let n = 0;
function seedPhoto(over: Record<string, unknown>) {
  n += 1;
  db.insert(vendorPhotos)
    .values({
      id: `p-${n}`,
      vendorId: "ven-1",
      photoUrl: `https://cdn.meetmeatthefair.com/v/${n}.jpg`,
      sortOrder: n,
      isFeatured: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    })
    .run();
}

const read = async () => {
  const r = (await server.invoke("get_vendor_details", { slug: "7th-star-bags" })) as {
    content: { text?: string }[];
  };
  return { raw: r.content[0].text ?? "", body: JSON.parse(r.content[0].text ?? "{}") };
};

describe("OPE-1171 — gallery alt is never blank on a public reader", () => {
  it("falls back from a blank alt to the caption", async () => {
    seedPhoto({ altText: "", caption: "Honey Bee- hexagon shaped crossbody bag" });
    const { body } = await read();
    expect(body.gallery[0].alt).toBe("Honey Bee- hexagon shaped crossbody bag");
  });

  it("falls back to '<vendor> photo N', numbered in display order", async () => {
    seedPhoto({ altText: null, caption: null });
    seedPhoto({ altText: "   ", caption: "  " });
    const { body } = await read();
    expect(body.gallery.map((g: { alt: string }) => g.alt)).toEqual([
      "7th Star Bags photo 1",
      "7th Star Bags photo 2",
    ]);
    // A whitespace caption is no caption — it must not render an empty figcaption.
    expect(body.gallery[1].caption).toBeUndefined();
  });

  it("keeps a written alt as-is", async () => {
    seedPhoto({ altText: "Blue tote", caption: "Booth" });
    const { body } = await read();
    expect(body.gallery[0].alt).toBe("Blue tote");
    expect(body.gallery[0].caption).toBe("Booth");
  });

  it("decodes stored HTML entities, which React would otherwise show literally", async () => {
    seedPhoto({ altText: null, caption: "Petal &amp; Pearl jewelry" });
    const { body } = await read();
    expect(body.gallery[0].caption).toBe("Petal & Pearl jewelry");
    expect(body.gallery[0].alt).toBe("Petal & Pearl jewelry");
  });
});

describe("OPE-1171 — source_note never leaves the building", () => {
  it("is absent from the payload, while the caption beside it is present", async () => {
    seedPhoto({
      caption: "7th Star Bags booth",
      sourceNote: "SENTINEL-From vendor's Facebook page, 2026-09-22",
    });
    const { raw, body } = await read();
    // Landmark: the row WAS read, so the absence below is about the column,
    // not about an empty gallery.
    expect(body.gallery).toHaveLength(1);
    expect(body.gallery[0].caption).toBe("7th Star Bags booth");
    expect(raw).not.toContain("SENTINEL");
  });
});
