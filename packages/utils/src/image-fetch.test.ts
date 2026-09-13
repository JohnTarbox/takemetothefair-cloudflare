/**
 * OPE-968 — image fetch identity and the diagnosis of a non-image response.
 * The response shapes are the ones measured on 2026-09-13 against the Guilford
 * Fair poster URL named in the ticket.
 */
import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_FETCH_USER_AGENT,
  LEGACY_IMAGE_FETCH_USER_AGENT,
  classifyImageResponse,
  fetchImageWithFallback,
  imageFetchHeaders,
} from "./image-fetch";

const URL_ =
  "https://guilfordfair.org/wp-content/uploads/2026/09/2026-Fair-Poster-w-border-682x1024.png";
const BLOCK_PAGE = '<!DOCTYPE html><html lang="en"><head>    <meta charset="utf-8" />';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const html = (status: number) =>
  Object.defineProperty(
    new Response(BLOCK_PAGE, { status, headers: { "Content-Type": "text/html; charset=UTF-8" } }),
    "url",
    { value: URL_ }
  );
const png = () =>
  Object.defineProperty(
    new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }),
    "url",
    { value: URL_ }
  );

describe("OPE-968 — the fetcher says who it is", () => {
  it("the default UA is honest and is NOT the 'Mozilla/5.0 (compatible; …)' shape the origin blocked", () => {
    expect(IMAGE_FETCH_USER_AGENT).toContain("MeetMeAtTheFair");
    expect(IMAGE_FETCH_USER_AGENT).not.toMatch(/\(compatible/);
    expect(imageFetchHeaders(IMAGE_FETCH_USER_AGENT)).toMatchObject({
      Accept: expect.stringContaining("image/"),
    });
  });
});

describe("OPE-968 — classifyImageResponse", () => {
  it("ACCEPTANCE: a 403 HTML page is 'blocked by origin', and names status, final URL and body", () => {
    const v = classifyImageResponse({
      status: 403,
      finalUrl: URL_,
      contentType: "text/html",
      bodyHead: BLOCK_PAGE,
    });
    expect(v.kind).toBe("blocked");
    if (v.kind === "image") return;
    expect(v.message).toMatch(/blocked by origin \(HTTP 403, text\/html/);
    expect(v.message).toContain(URL_);
    expect(v.message).toContain("<!DOCTYPE html>");
    expect(v.message).not.toMatch(/Unsupported content type/);
  });

  it("ACCEPTANCE: a 200 HTML challenge (what the Worker saw) is also 'blocked', not 'unsupported type'", () => {
    expect(
      classifyImageResponse({
        status: 200,
        finalUrl: URL_,
        contentType: "text/html",
        bodyHead: BLOCK_PAGE,
      }).kind
    ).toBe("blocked");
  });

  it("HTML without a text/html header is still recognised by its body", () => {
    expect(
      classifyImageResponse({
        status: 200,
        finalUrl: URL_,
        contentType: "text/plain",
        bodyHead: "<html><body>Just a moment...</body></html>",
      }).kind
    ).toBe("blocked");
  });

  it("a real non-image asset keeps a distinct message; a 404 is an HTTP error", () => {
    expect(
      classifyImageResponse({
        status: 200,
        finalUrl: URL_,
        contentType: "text/csv",
        bodyHead: "a,b",
      })
    ).toMatchObject({
      kind: "not-image",
      message: expect.stringContaining("text/csv"),
    });
    expect(
      classifyImageResponse({
        status: 404,
        finalUrl: URL_,
        contentType: "application/json",
        bodyHead: "{}",
      })
    ).toMatchObject({
      kind: "http-error",
      message: expect.stringContaining("HTTP 404"),
    });
  });

  it("LANDMARK: a PNG is an image", () => {
    expect(
      classifyImageResponse({ status: 200, finalUrl: URL_, contentType: "image/png" }).kind
    ).toBe("image");
  });
});

describe("OPE-968 — fetchImageWithFallback", () => {
  it("honest UA succeeds → one attempt, no fallback", async () => {
    const f = vi.fn(async () => png());
    const r = await fetchImageWithFallback(f);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(IMAGE_FETCH_USER_AGENT);
  });

  it("a block on the honest UA retries ONCE with the legacy UA", async () => {
    const f = vi.fn(async (ua: string) => (ua === IMAGE_FETCH_USER_AGENT ? html(403) : png()));
    const r = await fetchImageWithFallback(f);
    expect(r).toMatchObject({ ok: true, userAgent: LEGACY_IMAGE_FETCH_USER_AGENT });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("blocked on both → the verdict and both attempts are reported", async () => {
    const r = await fetchImageWithFallback(async () => html(403));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.verdict.kind).toBe("blocked");
    expect(r.attempts).toEqual([
      `${IMAGE_FETCH_USER_AGENT} → HTTP 403 text/html`,
      `${LEGACY_IMAGE_FETCH_USER_AGENT} → HTTP 403 text/html`,
    ]);
  });

  it("a 404 is not retried — a different UA will not make a missing file appear", async () => {
    const f = vi.fn(async () =>
      Object.defineProperty(
        new Response("nope", { status: 404, headers: { "Content-Type": "application/json" } }),
        "url",
        { value: URL_ }
      )
    );
    const r = await fetchImageWithFallback(f);
    expect(r.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
