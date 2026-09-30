/**
 * OPE-409 — the image-from-URL tools read our own `inbound-attachments/` objects
 * through the R2 binding, so a WAF block on that CDN prefix cannot break poster
 * attachment. John's direction of 2026-08-27 made this the precondition for the
 * rule: a public-edge fetch would fail for every size, silently.
 */
import { describe, expect, it } from "vitest";
import {
  ownedInboundAttachmentKey,
  readInboundAttachmentAsResponse,
  type InboundAttachmentBucket,
} from "./image-fetch";

const KEY = "inbound-attachments/CAEv_qq123-mail.gmail.com/0-Fair Poster.png";

describe("ownedInboundAttachmentKey", () => {
  it("recognises our CDN inbound-attachments URL and decodes the key", () => {
    expect(
      ownedInboundAttachmentKey(
        "https://cdn.meetmeatthefair.com/inbound-attachments/CAEv_qq123-mail.gmail.com/0-Fair%20Poster.png"
      )
    ).toBe(KEY);
  });

  it("is case-insensitive on the host", () => {
    expect(
      ownedInboundAttachmentKey("https://CDN.MeetMeAtTheFair.com/inbound-attachments/g/0-a.jpg")
    ).toBe("inbound-attachments/g/0-a.jpg");
  });

  it.each([
    [
      "published derivative stays a normal fetch",
      "https://cdn.meetmeatthefair.com/events/abc/hero.webp",
    ],
    ["vendor asset stays a normal fetch", "https://cdn.meetmeatthefair.com/vendors/x/logo.webp"],
    [
      "someone else's host with the same path",
      "https://evil.example/inbound-attachments/g/0-a.jpg",
    ],
    [
      "look-alike subdomain",
      "https://cdn.meetmeatthefair.com.evil.example/inbound-attachments/g/0-a.jpg",
    ],
    ["apex, not the CDN", "https://meetmeatthefair.com/inbound-attachments/g/0-a.jpg"],
    ["bare prefix, no object", "https://cdn.meetmeatthefair.com/inbound-attachments/"],
    ["prefix only as a substring", "https://cdn.meetmeatthefair.com/x/inbound-attachments/g.jpg"],
    ["not a URL", "not a url"],
    ["non-http scheme", "ftp://cdn.meetmeatthefair.com/inbound-attachments/g/0-a.jpg"],
  ])("returns null: %s", (_label, url) => {
    expect(ownedInboundAttachmentKey(url)).toBeNull();
  });
});

describe("readInboundAttachmentAsResponse", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bucketWith = (objects: Record<string, { bytes: Uint8Array; type?: string }>) => {
    const requested: string[] = [];
    const bucket: InboundAttachmentBucket = {
      async get(key) {
        requested.push(key);
        const o = objects[key];
        if (!o) return null;
        return {
          body: new Response(o.bytes as BlobPart).body!,
          size: o.bytes.byteLength,
          httpMetadata: o.type ? { contentType: o.type } : undefined,
        };
      },
    };
    return { bucket, requested };
  };

  it("returns the object's bytes and stored content type from the binding", async () => {
    const { bucket, requested } = bucketWith({ [KEY]: { bytes: PNG, type: "image/png" } });
    const res = await readInboundAttachmentAsResponse(bucket, KEY);
    expect(requested).toEqual([KEY]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("a missing object is a 404, not a thrown error", async () => {
    const { bucket } = bucketWith({});
    const res = await readInboundAttachmentAsResponse(bucket, KEY);
    expect(res.status).toBe(404);
  });
});
