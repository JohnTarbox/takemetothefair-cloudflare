/**
 * OPE-1350 — an empty body is a transport failure, never `parked_page`.
 *
 * Specimens (prod, `events.source_url@source-agreement`, 2026-10-13):
 * thesandwichfair.com and lebanoncraftfair.com were recorded as
 * "200 with a 0-byte body and 0 chars of visible text (parked or disabled
 * site)" while serving ~1.5 MB and ~126 KB to curl with our UA, and reading
 * `ok` on every other sweep — lebanoncraftfair read `ok` again 13 s later in
 * the same run. The same shape hit `promoters.website` once
 * (newenglandhomeshows.com, 2026-10-12, 0 bytes; 58 KB live).
 *
 * The cause of the 0 bytes was the probe, not the site: both copies of it
 * (url-probe.ts, and a verbatim duplicate in the source-agreement route) read
 * the body with `res.text().catch(() => "")`, so a body read that threw — the
 * 10 s abort firing mid-body, a reset stream — became an empty 200.
 *
 * Regression control: the 7 genuinely parked promoter sites (prod rows on
 * 2026-10-15) still read `parked_page`, from their bodies as served to our UA
 * on 2026-10-15 (fixtures/ope1350).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyUrlHealth, isActionable } from "../url-health";
import { classifyVendorSite } from "../vendor-site-health";
import { probe } from "../url-probe";

const fixture = (f: string) => readFileSync(join(__dirname, "fixtures", "ope1350", f), "utf8");

describe("OPE-1350 — an empty 200 is not a parked page (classifier)", () => {
  it.each([
    ["empty string", ""],
    ["null body", null],
    ["whitespace only", " \r\n\t "],
  ])("a 200 with %s reads unreachable, not parked_page", (_label, html) => {
    const r = classifyUrlHealth({ reachedOrigin: true, status: 200, html });
    expect(r.verdict).not.toBe("parked_page");
    expect(r.verdict).toBe("unreachable");
    expect(r.signals).toEqual(["empty-body"]);
    expect(isActionable(r.verdict)).toBe(false);
  });

  it("a 200 whose body read threw reads unreachable and carries the error", () => {
    const r = classifyUrlHealth({
      reachedOrigin: true,
      status: 200,
      html: null,
      bodyReadError: "AbortError: The operation was aborted",
    });
    expect(r.verdict).toBe("unreachable");
    expect(r.signals).toEqual(["body-read-failed"]);
    expect(r.detail).toContain("AbortError");
  });

  it("a non-2xx with an empty body is still http_error (status first)", () => {
    expect(classifyUrlHealth({ reachedOrigin: true, status: 503, html: null }).verdict).toBe(
      "http_error"
    );
  });

  it("the vendor classifier keeps an empty 200 at empty_page (unchanged, not queued)", () => {
    const r = classifyVendorSite(
      { reachedOrigin: true, status: 200, html: null, finalUrl: "https://example.com/" },
      { requestedUrl: "https://example.com/", businessName: "Example Crafts" }
    );
    expect(r.verdict).toBe("empty_page");
    expect(r.signals).toContain("empty-body");
  });
});

describe("OPE-1350 — the 7 genuinely parked promoter sites still read parked_page", () => {
  it.each([
    ["norfieldgrange_com.html", 114],
    ["vacationlandent_org.html", 114],
    ["cheshiregrange_org.html", 518],
    ["grandesfestas_org.html", 642],
    ["madisonct_com.html", 1018],
    ["wethersfieldchamber_com.html", 1018],
    ["capitalquiltersguild_com.html", 1294],
  ])("%s (%i bytes) is parked_page", (file, bytes) => {
    const html = fixture(file);
    expect(new TextEncoder().encode(html).length).toBe(bytes);
    const r = classifyUrlHealth({ reachedOrigin: true, status: 200, html });
    expect(r.verdict).toBe("parked_page");
    expect(r.detail).toContain(`${bytes}-byte body`);
  });
});

describe("OPE-1350 — the probe records a failed body read instead of swallowing it", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A 200 whose headers arrive and whose body stream then errors. */
  function erroringBodyResponse(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html><body>Sandwich Fair"));
        controller.error(new Error("stream reset mid-body"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
  }

  it("a body that errors mid-stream → bodyReadError set → unreachable, never parked_page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => erroringBodyResponse())
    );
    const p = await probe("https://www.thesandwichfair.com/");
    expect(p.reachedOrigin).toBe(true);
    expect(p.status).toBe(200);
    expect(p.bodyReadError).toContain("stream reset mid-body");
    const r = classifyUrlHealth(p);
    expect(r.verdict).toBe("unreachable");
    expect(r.signals).toEqual(["body-read-failed"]);
  });

  it("a genuinely 0-byte 200 → unreachable (empty-body)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 }))
    );
    const p = await probe("https://www.lebanoncraftfair.com/");
    expect(p.bodyReadError).toBeNull();
    expect(classifyUrlHealth(p).verdict).toBe("unreachable");
  });

  it("a normal body is untouched (bodyReadError null, html passed through)", async () => {
    const html = fixture("norfieldgrange_com.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(html, { status: 200 }))
    );
    const p = await probe("https://norfieldgrange.com/");
    expect(p.bodyReadError).toBeNull();
    expect(p.html).toBe(html);
    expect(classifyUrlHealth(p).verdict).toBe("parked_page");
  });
});
