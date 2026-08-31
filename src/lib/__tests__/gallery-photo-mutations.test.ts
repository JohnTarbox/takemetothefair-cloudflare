/**
 * OPE-686 — delete, promote and rotate, against a real database.
 *
 * The pure rules are tested in `@takemetothefair/db-schema`. What is proved
 * here is that both galleries actually behave that way, because `event_photos`
 * and `vendor_photos` had already drifted once: the event route hard-deleted
 * its row while its comment claimed the delete was recoverable.
 *
 * Every test runs against BOTH targets. A behaviour that holds for vendors and
 * not for events is the defect this ticket exists to close.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import {
  readGallery,
  softDeleteGalleryPhoto,
  rotateGalleryPhoto,
  type GalleryTarget,
} from "../gallery-photo-mutations";

const PHOTO_COLS = `
    id TEXT PRIMARY KEY, photo_url TEXT NOT NULL, caption TEXT, alt_text TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, photo_type TEXT NOT NULL DEFAULT 'other',
    is_featured INTEGER NOT NULL DEFAULT 0, uploaded_by TEXT,
    deleted_at INTEGER, content_sha256 TEXT, rotation INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`;

const SCHEMA_SQL = `
  CREATE TABLE event_photos (event_id TEXT, ${PHOTO_COLS});
  CREATE TABLE vendor_photos (vendor_id TEXT, ${PHOTO_COLS});
  CREATE TABLE admin_actions (
    id TEXT, action TEXT NOT NULL, actor_user_id TEXT, target_type TEXT NOT NULL,
    target_id TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: Database.Database;

const OWNER = "owner-1";

function seed(target: GalleryTarget, id: string, sortOrder: number, isFeatured = false) {
  const table = target === "event" ? "event_photos" : "vendor_photos";
  const ownerCol = target === "event" ? "event_id" : "vendor_id";
  raw
    .prepare(
      `INSERT INTO ${table} (${ownerCol}, id, photo_url, sort_order, is_featured, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0)`
    )
    .run(OWNER, id, `https://cdn.test/${id}.webp`, sortOrder, isFeatured ? 1 : 0);
}

const rowOf = (target: GalleryTarget, id: string) =>
  raw
    .prepare(
      `SELECT deleted_at, is_featured, rotation, sort_order, caption
         FROM ${target === "event" ? "event_photos" : "vendor_photos"} WHERE id = ?`
    )
    .get(id) as {
    deleted_at: number | null;
    is_featured: number;
    rotation: number;
    sort_order: number;
    caption: string | null;
  };

const audits = () =>
  raw
    .prepare("SELECT action, target_type, target_id, payload_json FROM admin_actions")
    .all() as Array<{
    action: string;
    target_type: string;
    target_id: string;
    payload_json: string;
  }>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe.each(["event", "vendor"] as const)("softDeleteGalleryPhoto — %s gallery", (target) => {
  it("tombstones the row instead of destroying it", async () => {
    // The old route ran `db.delete` while claiming the surviving R2 object made
    // the delete recoverable. It did not: restoring needed the id, caption,
    // sort order and featured flag that had just been destroyed with the row.
    seed(target, "a", 0);
    await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a" });

    expect(rowOf(target, "a").deleted_at).not.toBeNull();
    expect(await readGallery(db, target, OWNER)).toHaveLength(0);
  });

  it("promotes the next photo when the featured one is deleted", async () => {
    seed(target, "lead", 0, true);
    seed(target, "next", 1);
    seed(target, "last", 2);

    const res = await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "lead" });

    expect(res.promoted).toBe("next");
    expect(rowOf(target, "next").is_featured).toBe(1);
    expect(res.remaining.map((p) => p.id)).toEqual(["next", "last"]);
  });

  it("does not re-lead the gallery when an ordinary photo is deleted", async () => {
    seed(target, "lead", 0, true);
    seed(target, "other", 1);

    const res = await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "other" });

    expect(res.promoted).toBeNull();
    expect(rowOf(target, "lead").is_featured).toBe(1);
  });

  it("clears the featured flag on the deleted row itself", async () => {
    // A tombstone that is still `is_featured` would come back as the lead if it
    // were ever restored, silently displacing whatever took over.
    seed(target, "lead", 0, true);
    seed(target, "next", 1);
    await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "lead" });
    expect(rowOf(target, "lead").is_featured).toBe(0);
  });

  it("is idempotent — a repeat delete is a no-op, not an error", async () => {
    // An agent retrying a timed-out call should not have to tell "it failed"
    // apart from "it worked and I missed the reply".
    seed(target, "a", 0, true);
    seed(target, "b", 1);
    await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a" });
    const second = await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a" });

    expect(second.promoted).toBeNull();
    expect(second.remaining.map((p) => p.id)).toEqual(["b"]);
    // Crucially: the second call must not promote AGAIN and demote b's successor.
    expect(rowOf(target, "b").is_featured).toBe(1);
    // And it must leave no trace. Dropping the membership check produces a
    // state that LOOKS identical — the successor search finds nothing, because
    // the live gallery no longer contains the photo — but writes a second
    // `gallery.photo_deleted` row for a delete that deleted nothing. An audit
    // log that records work never done is worse than one that records none.
    expect(audits().filter((r) => r.action === "gallery.photo_deleted")).toHaveLength(1);
  });

  it("writes one admin_actions row naming the photo and the owner", async () => {
    seed(target, "a", 0);
    await softDeleteGalleryPhoto(db, {
      target,
      ownerId: OWNER,
      photoId: "a",
      actorUserId: "u-1",
      via: "mcp",
    });

    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "gallery.photo_deleted",
      target_type: target,
      target_id: OWNER,
    });
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({ photoId: "a", via: "mcp" });
  });

  it("never promotes a photo that was already deleted", async () => {
    seed(target, "lead", 0, true);
    seed(target, "gone", 1);
    seed(target, "live", 2);
    await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "gone" });

    const res = await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "lead" });
    expect(res.promoted).toBe("live");
  });
});

describe.each(["event", "vendor"] as const)("rotateGalleryPhoto — %s gallery", (target) => {
  it("accumulates relative turns", async () => {
    seed(target, "a", 0);
    expect(
      await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: 90 })
    ).toMatchObject({ rotation: 90 });
    expect(
      await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: 90 })
    ).toMatchObject({ rotation: 180 });
    expect(rowOf(target, "a").rotation).toBe(180);
  });

  it("preserves photo_id, sort_order, is_featured and caption", async () => {
    // This is the acceptance criterion. The workaround it replaces was
    // download → rotate → re-upload → delete, which minted a new URL and lost
    // the row's place in the gallery.
    seed(target, "a", 7, true);
    raw
      .prepare(
        `UPDATE ${target === "event" ? "event_photos" : "vendor_photos"} SET caption = 'ice cream stand' WHERE id = 'a'`
      )
      .run();

    await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: 270 });

    const row = rowOf(target, "a");
    expect(row).toMatchObject({ sort_order: 7, is_featured: 1, caption: "ice cream stand" });
    expect(row.rotation).toBe(270);
  });

  it("turns back losslessly", async () => {
    seed(target, "a", 0);
    await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: 90 });
    await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: -90 });
    expect(rowOf(target, "a").rotation).toBe(0);
  });

  it("refuses an angle that is not a quarter turn", async () => {
    seed(target, "a", 0);
    await expect(
      rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: 45 })
    ).rejects.toThrow(/0, 90, 180 or 270/);
    expect(rowOf(target, "a").rotation).toBe(0);
  });

  it("returns null for a photo that is not in this gallery", async () => {
    seed(target, "a", 0);
    expect(
      await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "nope", degrees: 90 })
    ).toBeNull();
  });

  it("will not rotate a tombstone", async () => {
    // readGallery excludes it, so the rotate finds nothing — the deleted photo
    // cannot be edited into a different state while invisible.
    seed(target, "a", 0);
    await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a" });
    expect(
      await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: 90 })
    ).toBeNull();
  });

  it("records the rotation with both the old and the new angle", async () => {
    seed(target, "a", 0);
    await rotateGalleryPhoto(db, { target, ownerId: OWNER, photoId: "a", degrees: 180 });
    const rot = audits().find((r) => r.action === "gallery.photo_rotated")!;
    expect(JSON.parse(rot.payload_json)).toMatchObject({ photoId: "a", from: 0, to: 180 });
  });
});

describe("readGallery", () => {
  it("orders by sort_order and excludes tombstones, on both galleries", async () => {
    for (const target of ["event", "vendor"] as const) {
      seed(target, "c", 2);
      seed(target, "a", 0);
      seed(target, "b", 1);
      await softDeleteGalleryPhoto(db, { target, ownerId: OWNER, photoId: "b" });
      expect((await readGallery(db, target, OWNER)).map((p) => p.id)).toEqual(["a", "c"]);
    }
  });

  it("does not leak one owner's photos into another's gallery", async () => {
    seed("event", "mine", 0);
    raw
      .prepare(
        `INSERT INTO event_photos (event_id, id, photo_url, sort_order, is_featured, created_at, updated_at)
         VALUES ('other-owner', 'theirs', 'u', 0, 0, 0, 0)`
      )
      .run();
    expect((await readGallery(db, "event", OWNER)).map((p) => p.id)).toEqual(["mine"]);
  });
});
