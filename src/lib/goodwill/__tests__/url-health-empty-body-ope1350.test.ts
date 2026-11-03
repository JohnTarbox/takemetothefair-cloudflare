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
 * Regression control: the promoter sites recorded `parked_page` in prod on
 * 2026-10-15, from their bodies as served to our UA that day
 * (fixtures/ope1350). OPE-1353: only 3 of those 7 are genuinely parked; the
 * other 4 are live JS-app shells / frame pages and are pinned NOT parked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyUrlHealth, isActionable } from "../url-health";
import { classifyVendorSite } from "../vendor-site-health";
import { probe, PROBE_MAX_BYTES } from "../url-probe";
import { PROJECTED_URL_HEALTH } from "@/lib/url-health-issues";

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

// OPE-1353 — of the 7 sites OPE-1294 called parked, only 3 are: the other 4
// are a JS-app shell (×2) and a frame page (×2) wrapping a live site. Those
// now read no_event_signal (recorded, not projected to the review queue).
describe("OPE-1350/OPE-1353 — the 3 genuinely parked promoter sites still read parked_page", () => {
  it.each([
    ["norfieldgrange_com.html", 114, "lander-redirect"],
    ["vacationlandent_org.html", 114, "lander-redirect"],
    ["capitalquiltersguild_com.html", 1294, "site-disabled"],
  ])("%s (%i bytes) is parked_page via %s", (file, bytes, marker) => {
    const html = fixture(file);
    expect(new TextEncoder().encode(html).length).toBe(bytes);
    const r = classifyUrlHealth({ reachedOrigin: true, status: 200, html });
    expect(r.verdict).toBe("parked_page");
    expect(r.signals).toContain(marker);
    expect(r.detail).toContain(`${bytes}-byte body`);
  });
});

describe("OPE-1353 — the 4 live wrappers are NOT parked_page", () => {
  it.each([
    ["madisonct_com.html", 1018, "js-app-shell"],
    ["wethersfieldchamber_com.html", 1018, "js-app-shell"],
    ["cheshiregrange_org.html", 518, "frame-wrapper"],
    ["grandesfestas_org.html", 642, "frame-wrapper"],
  ])("%s (%i bytes) is no_event_signal (%s), not parked", (file, bytes, kind) => {
    const html = fixture(file);
    expect(new TextEncoder().encode(html).length).toBe(bytes);
    const r = classifyUrlHealth({ reachedOrigin: true, status: 200, html });
    expect(r.verdict).not.toBe("parked_page");
    expect(r.verdict).toBe("no_event_signal");
    expect(r.signals).toEqual([kind]);
    expect(PROJECTED_URL_HEALTH[r.verdict]).toBeUndefined();
  });

  it("a frame page names where its content lives", () => {
    expect(
      classifyUrlHealth({
        reachedOrigin: true,
        status: 200,
        html: fixture("cheshiregrange_org.html"),
      }).detail
    ).toContain("harvest/grangehome.asp?PagesID=3");
    expect(
      classifyUrlHealth({
        reachedOrigin: true,
        status: 200,
        html: fixture("grandesfestas_org.html"),
      }).detail
    ).toContain("santamariacenter.com/Sites/Grandesfestas/");
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

// OPE-1370 (SSRF6) — the probe went through bare `fetch` with redirect:
// "follow" and no guard. It now walks redirects itself, re-checking each hop.
describe("OPE-1370 — the probe is SSRF-guarded per hop and size-capped", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a public site that redirects to loopback is unreachable, and the hop is never requested", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return String(input) === "https://promoter.example.org/"
          ? new Response(null, { status: 302, headers: { location: "http://localhost./admin" } })
          : new Response("<html>internal</html>", { status: 200 });
      })
    );
    const p = await probe("https://promoter.example.org/");
    expect(p.reachedOrigin).toBe(false);
    expect(seen).toEqual(["https://promoter.example.org/"]);
  });

  it("still reports where a public redirect chain landed (OPE-988 takeover signal)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "https://old.example.org/"
          ? new Response(null, {
              status: 301,
              headers: { location: "https://parked.example.net/" },
            })
          : new Response("<html><body>for sale</body></html>", { status: 200 })
      )
    );
    const p = await probe("https://old.example.org/");
    expect(p.finalUrl).toBe("https://parked.example.net/");
    expect(p.html).toContain("for sale");
  });

  it("an oversize 2xx body is read as a capped prefix, not an error and not whole", async () => {
    let sent = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                if (sent >= 64 * 1024 * 1024) return c.close();
                sent += 1024 * 1024;
                c.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
              },
            }),
            { status: 200, headers: { "content-type": "text/html" } }
          )
      )
    );
    const p = await probe("https://huge.example.org/");
    expect(p.bodyReadError).toBeNull();
    expect(p.html?.length).toBe(PROBE_MAX_BYTES);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
  });
});
