/**
 * OPE-325 — the poster classifier's hand-off dropped the content type.
 *
 * First evidence, 2026-08-24 02:09:32Z: the observability shipped in #1008 made
 * `mcp:photo-intake:poster-classify` write the first row that source has ever
 * produced, and it named its own branch —
 *
 *   extract-image returned non-OK, status 400,
 *   "'image.png' is application/octet-stream — images only."
 *
 * `new Blob([bytes])` has `type === ""`, so the multipart part went out as
 * `application/octet-stream` and `/api/admin/import-url/extract-image` rejected
 * it at `route.ts:55` (`f.type.toLowerCase().startsWith("image/")`).
 *
 * The type was never lost at rest — the stored ref, `fetch_inbound_attachment`
 * and `upload_event_image` all report `image/png` for that same object. It was
 * lost only here, with the correct value sitting in the ref.
 *
 * These exercise the REAL `buildExtractImageForm`, which is why it was
 * extracted: a test that rebuilt the FormData itself would pin a copy and stay
 * green against the shipped code.
 */
import { describe, it, expect } from "vitest";
import { buildExtractImageForm, imageRefs } from "../src/email-handlers/photo-intake.js";

const bytes = () => new Uint8Array([1, 2, 3, 4]).buffer;

/** The route's own check, mirrored so the assertion is about what it does. */
const routeAccepts = (f: File) => f.type.toLowerCase().startsWith("image/");

describe("the part carries the stored mimeType", () => {
  it("sends image/png for the specimen that produced the 400", async () => {
    const form = buildExtractImageForm(bytes(), {
      key: "inbound-attachments/x/0-image.png",
      name: "image.png",
      mimeType: "image/png",
      size: 2_738_813,
    });
    const f = form.get("images") as File;
    expect(f.type).toBe("image/png");
    expect(routeAccepts(f)).toBe(true);
  });

  it("is format-independent — the JPEG half of the held set passes too", async () => {
    // The falsifiable prediction on the ticket: if the type is lost in the
    // hand-off rather than at rest, JPEGs fail identically. 6 of the 13 held
    // attachments are Facebook-CDN JPEGs.
    const form = buildExtractImageForm(bytes(), {
      key: "inbound-attachments/y/0-fb.jpg",
      name: "1234567890_1234567890.jpg",
      mimeType: "image/jpeg",
      size: 5_490_946,
    });
    const f = form.get("images") as File;
    expect(f.type).toBe("image/jpeg");
    expect(routeAccepts(f)).toBe(true);
  });

  it("keeps the attachment's own filename", async () => {
    const form = buildExtractImageForm(bytes(), {
      key: "k",
      name: "poster-2026.png",
      mimeType: "image/png",
      size: 10,
    });
    expect((form.get("images") as File).name).toBe("poster-2026.png");
  });

  it("falls back to a name only when the ref has none", async () => {
    const form = buildExtractImageForm(bytes(), {
      key: "k",
      name: "",
      mimeType: "image/png",
      size: 10,
    });
    // The old fallback was "poster.jpg" — a .jpg name on PNG bytes. The route
    // reads the TYPE, so this never mattered functionally, but a mismatched
    // name is a false clue for the next person reading a log line.
    expect((form.get("images") as File).name).toBe("poster.png");
  });

  it("reproduces the failure when the type is dropped — this is the regression", async () => {
    // What the code did before: no type option at all.
    const form = new FormData();
    form.append("images", new Blob([bytes()]), "image.png");
    const f = form.get("images") as File;
    expect(f.type).toBe("");
    expect(routeAccepts(f)).toBe(false);
  });
});

describe("the filter upstream makes this safe", () => {
  it("only ever hands image/* refs to the form builder", () => {
    const refs = [
      { key: "a", name: "a.pdf", mimeType: "application/pdf", size: 1 },
      { key: "b", name: "b.png", mimeType: "image/png", size: 1 },
      { key: "c", name: "c.txt", mimeType: "text/plain", size: 1 },
    ];
    const kept = imageRefs(refs);
    expect(kept.map((r) => r.mimeType)).toEqual(["image/png"]);
    // So buildExtractImageForm cannot set a type the route would refuse.
    for (const r of kept) {
      expect(routeAccepts(buildExtractImageForm(bytes(), r).get("images") as File)).toBe(true);
    }
  });
});
