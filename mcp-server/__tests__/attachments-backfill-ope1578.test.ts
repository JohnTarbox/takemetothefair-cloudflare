/**
 * OPE-1578 — the UMF shape: parts lost to the old cap, recovered from the .eml
 * we kept. Real MIME parsed by postal-mime, real SQL.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { backfillSkippedAttachments } from "../src/attachments-backfill.js";
import { imageRefs } from "../src/email-handlers/photo-intake.js";
import { inboundEmails } from "../src/schema.js";
import { media } from "./helpers/magic-bytes.js";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

function eml(parts: Array<{ name: string; type: string; bytes: Uint8Array }>): Uint8Array {
  const b = "BOUND";
  const body = parts
    .map(
      (p) =>
        `--${b}\r\nContent-Type: ${p.type}; name="${p.name}"\r\n` +
        `Content-Disposition: attachment; filename="${p.name}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${b64(p.bytes)}\r\n`
    )
    .join("");
  return new TextEncoder().encode(
    `From: a@b.test\r\nSubject: packet\r\nMIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n` +
      `--${b}\r\nContent-Type: text/plain\r\n\r\nhi\r\n${body}--${b}--\r\n`
  );
}

const GROUP = "inbound-attachments/g1/";
const EML_KEY = `${GROUP}0-forward.eml`;

function bucketWith(objects: Record<string, Uint8Array>) {
  const puts: Array<{ key: string; type?: string; disposition?: string }> = [];
  const store = new Map(Object.entries(objects));
  return {
    puts,
    bucket: {
      head: async (k: string) => (store.has(k) ? {} : null),
      get: async (k: string) => {
        const v = store.get(k);
        return v ? { arrayBuffer: async () => v.buffer.slice(0) } : null;
      },
      put: async (
        k: string,
        v: Uint8Array,
        o?: { httpMetadata?: { contentType?: string; contentDisposition?: string } }
      ) => {
        store.set(k, v);
        puts.push({
          key: k,
          type: o?.httpMetadata?.contentType,
          disposition: o?.httpMetadata?.contentDisposition,
        });
      },
    } as unknown as R2Bucket,
  };
}

const PNG = new Uint8Array(media("image/png", 200) as ArrayBuffer);
const PDF = new Uint8Array(media("application/pdf", 200) as ArrayBuffer);
const realSkip = (index: number, name: string, mimeType: string) => ({
  index,
  name,
  mimeType,
  size: 200,
  reason: "over-count-cap",
  furniture: false,
});

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];

function seed(skips: unknown[], id = "ie-1") {
  raw["prepare"](
    `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, status,
       created_at, attachment_count, attachment_refs, attachment_skips)
     VALUES (?, 1787000000, 'a@b.test', 'submit@x.test', 's', 'submit', 'done', 1787000000, 3, ?, ?)`
  ).run(
    id,
    JSON.stringify([{ key: EML_KEY, name: "forward.eml", mimeType: "message/rfc822", size: 9 }]),
    JSON.stringify(skips)
  );
}

const readRow = async (id = "ie-1") => {
  const [r] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id));
  return {
    refs: JSON.parse(r.attachmentRefs ?? "[]") as Array<Record<string, unknown>>,
    skips: JSON.parse(r.attachmentSkips ?? "[]") as Array<Record<string, unknown>>,
  };
};

const packet = eml([
  { name: "Application.png", type: "image/png", bytes: PNG },
  { name: "License.pdf", type: "application/pdf", bytes: PDF },
]);

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

describe("backfillSkippedAttachments (OPE-1578)", () => {
  it("dry-run reports what it would store and changes nothing", async () => {
    seed([
      realSkip(1, "Application.png", "image/png"),
      realSkip(6, "License.pdf", "application/pdf"),
    ]);
    const { bucket, puts } = bucketWith({ [EML_KEY]: packet });

    const r = await backfillSkippedAttachments(db, bucket, "ie-1", false);

    expect(r.committed).toBe(false);
    expect(r.candidates).toBe(2);
    expect(r.items.map((i) => i.outcome)).toEqual(["would-store", "would-store"]);
    expect(puts).toHaveLength(0);
    expect((await readRow()).refs).toHaveLength(1);
  });

  it("commit stores each part under the capture rules and repoints the row", async () => {
    seed([
      realSkip(1, "Application.png", "image/png"),
      realSkip(6, "License.pdf", "application/pdf"),
    ]);
    const { bucket, puts } = bucketWith({ [EML_KEY]: packet });

    const r = await backfillSkippedAttachments(db, bucket, "ie-1", true);

    expect(r.committed).toBe(true);
    expect(puts).toEqual([
      { key: `${GROUP}1-Application.png`, type: "image/png", disposition: "attachment" },
      { key: `${GROUP}6-License.pdf`, type: "application/pdf", disposition: "attachment" },
    ]);
    const { refs, skips } = await readRow();
    expect(refs.map((x) => x.name)).toEqual(["forward.eml", "Application.png", "License.pdf"]);
    expect(refs[1].ocrSkipped).toBe(true);
    expect(skips.every((s) => s.reason === "ocr-skipped:over-count-cap")).toBe(true);
  });

  it("is idempotent: a second commit finds nothing to do", async () => {
    seed([realSkip(1, "Application.png", "image/png")]);
    const { bucket, puts } = bucketWith({ [EML_KEY]: packet });

    await backfillSkippedAttachments(db, bucket, "ie-1", true);
    const again = await backfillSkippedAttachments(db, bucket, "ie-1", true);

    expect(again.candidates).toBe(0);
    expect(puts).toHaveLength(1);
    expect((await readRow()).refs).toHaveLength(2);
  });

  it("never overwrites an object already at the key", async () => {
    seed([realSkip(1, "Application.png", "image/png")]);
    const { bucket, puts } = bucketWith({
      [EML_KEY]: packet,
      [`${GROUP}1-Application.png`]: PNG,
    });

    const r = await backfillSkippedAttachments(db, bucket, "ie-1", true);

    expect(r.items[0].outcome).toBe("already-exists");
    expect(puts).toHaveLength(0);
  });

  it("refuses a part whose bytes are not an allowed type, whatever it declares", async () => {
    seed([realSkip(1, "evil.png", "image/png")]);
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    const { bucket, puts } = bucketWith({
      [EML_KEY]: eml([{ name: "evil.png", type: "image/png", bytes: html }]),
    });

    const r = await backfillSkippedAttachments(db, bucket, "ie-1", true);

    expect(r.items[0].outcome).toBe("unrecognized-content");
    expect(puts).toHaveLength(0);
    expect(r.committed).toBe(false);
  });

  it("ignores signature furniture", async () => {
    seed([{ ...realSkip(1, "icon.png", "image/png"), furniture: true }]);
    const { bucket } = bucketWith({ [EML_KEY]: packet });

    expect((await backfillSkippedAttachments(db, bucket, "ie-1", true)).candidates).toBe(0);
  });

  it("names a missing part rather than claiming success", async () => {
    seed([realSkip(1, "NotThere.png", "image/png")]);
    const { bucket } = bucketWith({ [EML_KEY]: packet });

    const r = await backfillSkippedAttachments(db, bucket, "ie-1", true);

    expect(r.items[0].outcome).toBe("not-found-in-eml");
    expect(r.committed).toBe(false);
  });
});

describe("the photo lane leaves past-cap files alone (OPE-1578)", () => {
  it("imageRefs drops ocrSkipped refs", () => {
    const base = { name: "a", mimeType: "image/png", size: 1 };
    const out = imageRefs([
      { ...base, key: "read" },
      { ...base, key: "unread", ocrSkipped: true },
    ]);
    expect(out.map((r) => r.key)).toEqual(["read"]);
  });
});
