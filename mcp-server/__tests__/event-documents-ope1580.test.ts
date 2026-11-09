/**
 * OPE-1580 — posting and withdrawing a blank vendor form.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { adminActions, eventDocuments, events, inboundEmails, venues } from "../src/schema.js";
import { postEventDocument, withdrawEventDocument } from "../src/event-documents.js";

const PDF = new TextEncoder().encode("%PDF-1.4 a blank form");
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>");
const pngChunk = (type: string, data: number[]) => [
  0,
  0,
  0,
  data.length,
  ...[...type].map((c) => c.charCodeAt(0)),
  ...data,
  0,
  0,
  0,
  0,
];
const PNG_WITH_TEXT = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...pngChunk("IHDR", [1]),
  ...pngChunk("tEXt", [65, 0, 66]),
  ...pngChunk("IEND", []),
]);

function fakeBucket(seed: Record<string, Uint8Array>) {
  const store = new Map(Object.entries(seed));
  let failDelete = false;
  const bucket = {
    get: async (key: string) => {
      const v = store.get(key);
      return v ? { arrayBuffer: async () => v.slice().buffer } : null;
    },
    put: async (key: string, value: Uint8Array) => void store.set(key, value),
    delete: async (key: string) => {
      if (failDelete) throw new Error("r2 down");
      store.delete(key);
    },
  };
  return {
    bucket: bucket as unknown as R2Bucket,
    store,
    breakDelete: () => (failDelete = true),
  };
}

const NOW = new Date("2026-11-08T20:00:00Z");
const base = {
  eventId: "ev1",
  inboundEmailId: "em1",
  attachmentIndex: 0,
  kind: "application" as const,
  displayName: "Vendor application",
  sourceOrganizer: "UMF Conferences and Events",
  postedBy: "admin1",
};

describe("OPE-1580 postEventDocument / withdrawEventDocument", () => {
  let db: TestDb;

  beforeEach(async () => {
    ({ db } = createTestDb());
    await db.insert(venues).values({
      id: "v1",
      name: "UMF",
      slug: "umf" as never,
      address: "111 South St",
      city: "Farmington",
      state: "ME",
      zip: "04938",
    } as never);
    await db.insert(events).values({
      id: "ev1",
      name: "UMF Chester Greenwood Craft Fair 2026",
      slug: "umf-2026" as never,
      promoterId: "p1",
      venueId: "v1",
      startDate: new Date("2026-12-05T12:00:00Z"),
      endDate: new Date("2026-12-05T12:00:00Z"),
      status: "APPROVED",
    } as never);
    await db.insert(inboundEmails).values({
      id: "em1",
      fromAddress: "a@example.test",
      toAddress: "submit@example.test",
      rawSize: 1,
      intent: "new_event",
      createdAt: new Date("2026-09-12T01:20:41Z"),
      receivedAt: new Date("2026-09-12T01:20:41Z"),
      attachmentRefs: JSON.stringify([
        { key: "inbound-attachments/m/0-form.pdf", name: "form.pdf", mimeType: "application/pdf" },
        { key: "inbound-attachments/m/1-evil.svg", name: "evil.png", mimeType: "image/png" },
        { key: "inbound-attachments/m/2-form.png", name: "form.png", mimeType: "image/png" },
      ]),
    } as never);
  });

  const stored = () => ({
    "inbound-attachments/m/0-form.pdf": PDF,
    "inbound-attachments/m/1-evil.svg": SVG,
    "inbound-attachments/m/2-form.png": PNG_WITH_TEXT,
  });

  it("copies the file to a new key and records it, leaving the original", async () => {
    const f = fakeBucket(stored());
    const r = await postEventDocument(db as never, f.bucket, base, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expires_at).toBe("2026-12-06T12:00:00.000Z");
    expect(r.needs_review).toBe(false);
    const [row] = await db.select().from(eventDocuments);
    expect(row.r2Key).toBe(`event-documents/ev1/${r.id}.pdf`);
    expect(row.r2Key).not.toContain("inbound-attachments");
    expect(row.year).toBe(2026);
    expect(f.store.has(row.r2Key)).toBe(true);
    expect(f.store.has("inbound-attachments/m/0-form.pdf")).toBe(true);
    const actions = await db.select().from(adminActions);
    expect(actions.map((a) => a.action)).toEqual(["event_document.posted"]);
  });

  it("refuses a disallowed file by its bytes, whatever the sender declared", async () => {
    const f = fakeBucket(stored());
    const r = await postEventDocument(db as never, f.bucket, { ...base, attachmentIndex: 1 }, NOW);
    expect(r).toMatchObject({ ok: false, error: "disallowed-type" });
    expect(await db.select().from(eventDocuments)).toHaveLength(0);
    expect([...f.store.keys()].filter((k) => k.startsWith("event-documents/"))).toHaveLength(0);
  });

  it("strips PNG metadata before the file goes public", async () => {
    const f = fakeBucket(stored());
    const r = await postEventDocument(db as never, f.bucket, { ...base, attachmentIndex: 2 }, NOW);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(eventDocuments);
    const written = f.store.get(row.r2Key)!;
    expect(written.length).toBe(PNG_WITH_TEXT.length - 15);
    expect(row.sizeBytes).toBe(written.length);
    expect(new TextDecoder("latin1").decode(written)).not.toContain("tEXt");
  });

  it("refuses to post the same attachment twice while it is live", async () => {
    const f = fakeBucket(stored());
    await postEventDocument(db as never, f.bucket, base, NOW);
    const again = await postEventDocument(db as never, f.bucket, base, NOW);
    expect(again).toMatchObject({ ok: false, error: "already-posted" });
  });

  it("refuses an event that is already over", async () => {
    const f = fakeBucket(stored());
    const after = new Date("2026-12-07T00:00:00Z");
    const r = await postEventDocument(db as never, f.bucket, base, after);
    expect(r).toMatchObject({ ok: false, error: "event-over" });
  });

  it("marks the copy for review when the organizer has its own link", async () => {
    await db.update(events).set({ applicationUrl: "https://umf.example/apply" } as never);
    const f = fakeBucket(stored());
    const r = await postEventDocument(db as never, f.bucket, base, NOW);
    expect(r).toMatchObject({ ok: true, needs_review: true });
  });

  it("withdraw marks the row and deletes the file", async () => {
    const f = fakeBucket(stored());
    const r = await postEventDocument(db as never, f.bucket, base, NOW);
    if (!r.ok) throw new Error("post failed");
    const [row] = await db.select().from(eventDocuments);
    const w = await withdrawEventDocument(
      db as never,
      f.bucket,
      { documentId: r.id, reason: "organizer asked", withdrawnBy: "admin1" },
      NOW
    );
    expect(w).toEqual({ ok: true, id: r.id, file_deleted: true });
    expect(f.store.has(row.r2Key)).toBe(false);
    const [after] = await db.select().from(eventDocuments);
    expect(after.status).toBe("withdrawn");
    expect(after.withdrawnReason).toBe("organizer asked");
  });

  it("a failed delete still withdraws the row and says so", async () => {
    const f = fakeBucket(stored());
    const r = await postEventDocument(db as never, f.bucket, base, NOW);
    if (!r.ok) throw new Error("post failed");
    f.breakDelete();
    const w = await withdrawEventDocument(
      db as never,
      f.bucket,
      { documentId: r.id, reason: "x", withdrawnBy: null },
      NOW
    );
    expect(w).toMatchObject({ ok: true, file_deleted: false });
    const [after] = await db.select().from(eventDocuments);
    expect(after.status).toBe("withdrawn");
  });
});
