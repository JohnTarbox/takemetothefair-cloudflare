/**
 * OPE-860 — the URL-health classifier, pinned against the real specimens.
 *
 * ⚠️ Amendment H, and this suite's whole reason for being strict.
 *
 * The ticket asks explicitly: *"point it at these two known-bad domains and
 * watch it go red, then at a known-good organizer URL and watch it stay green.
 * A green run over a set with no known-bad member proves nothing."*
 *
 * So the known-good case is not decoration. A classifier that returns
 * `no_event_signal` for literally everything satisfies every "detects the bad
 * page" assertion in this file, and would be worse than no classifier at all —
 * it would bury the two real findings under 135 false ones. The `ok` cases are
 * the positive landmark that makes the negative ones mean something.
 */
import { describe, it, expect } from "vitest";
import { classifyUrlHealth, isActionable, visibleText } from "../url-health";

/**
 * Specimen A — `ledyardfair.org`. Ledyard Fair Inc dissolved 18 Nov 2024; the
 * domain now serves a content site describing itself as the fair's "official
 * information hub" with no dates, no hours, no admission and no vendor terms.
 *
 * Reproduced faithfully in the property that matters: it is fair-shaped prose,
 * long, confident, on-topic, and contains nothing an event page would contain.
 * It even carries a month name in a byline, which is exactly the trap — a
 * single weak signal must not be enough to read as healthy.
 */
const LEDYARD_REPURPOSED = `<!doctype html><html><head>
<title>Ledyard Fair — The official information hub for the annual Ledyard Fair</title>
</head><body>
<h1>The official information hub for the annual Ledyard Fair</h1>
<p>Welcome to the premier destination for everything about the beloved Ledyard
tradition. Our team of writers brings you stories, history and community voices
from one of the region's best-loved gatherings.</p>
<div class="stats"><span>23+ Years of Tradition</span><span>3K+ Annual Fair Visitors</span>
<span>50+ Community Partners</span></div>
<h2>Latest from our contributors</h2>
<article><h3>The history of agricultural traditions in our community</h3>
<p class="byline">By a Staff Writer, posted December</p>
<p>Agricultural gatherings have long been the heart of rural life, bringing
neighbours together across generations to celebrate the harvest and share in
the craft of the land. This piece explores that heritage and what it has meant
to the families who built it over more than two decades of celebration.</p></article>
<article><h3>Meet the Director</h3><p class="byline">By a Staff Writer</p>
<p>Our Director reflects on community, continuity, and the people who make the
tradition what it is today.</p></article>
</body></html>`;

/**
 * Specimen B — `clintonlionsagfair207.com`, hijacked to gambling SEO spam.
 *
 * The fixture keeps the ORIGINAL fair's 2019 meta-keywords, which the live site
 * still carries. They must not read as a live event signal.
 *
 * ⚠️ Correction, found by mutation: I originally wrote that the `<head>` strip
 * in `visibleText()` was what saved us here. It is not — the generic
 * `<[^>]+>` strip already deletes a `<meta>` element whole, attributes
 * included, so meta content never reaches the text under either
 * implementation. Deleting the `<head>` line left this test green. The case
 * that line really defends is a hijack that keeps the original `<title>`, and
 * it is pinned separately in the `visibleText` block below.
 */
const CLINTON_HIJACKED = `<!doctype html><html><head>
<title>DRAGON222 Link Alternatif Situs Slot Gacor Hari Ini</title>
<meta name="keywords" content="Clinton, Lions, Fair, Ag, Agricultural, Maine, July 2019, admission, vendors">
<meta name="description" content="Situs slot gacor terpercaya">
</head><body>
<h1>DRAGON222 Link Alternatif</h1>
<p>Situs slot gacor hari ini dengan link alternatif terpercaya dan proses
deposit yang cepat serta layanan pelanggan yang tersedia sepanjang waktu untuk
seluruh member setia kami di seluruh wilayah.</p>
<p>Daftar sekarang dan dapatkan bonus new member untuk permainan pilihan anda
dengan berbagai provider ternama yang telah bekerja sama dengan kami.</p>
</body></html>`;

/** A real organizer page: says when, says what it costs, says who can exhibit. */
const HEALTHY_FAIR_PAGE = `<!doctype html><html><head><title>Hebron Harvest Fair</title></head>
<body><h1>Hebron Harvest Fair</h1>
<p>Join us September 4 through September 7, 2026 at the Hebron fairgrounds for
four days of agricultural exhibits, live music on the grandstand and the
midway.</p>
<p>Admission is $12 at the gate; children under 8 are free. Hours are 8am to
10pm daily. Parking is free.</p>
<p>Vendors and exhibitors: applications for the 2026 season are open now.</p>
</body></html>`;

/** The same fair, but machine-readable. The strongest single signal. */
const JSONLD_PAGE = `<!doctype html><html><body>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Event","name":"Some Fair",
 "startDate":"2026-09-12"}
</script>
<p>Short page.</p></body></html>`;

const reached = (html: string, status = 200) => ({ reachedOrigin: true, status, html });

describe("OPE-860 — the two real specimens are detected", () => {
  it("specimen A: the repurposed ledyardfair.org reads no_event_signal", () => {
    const r = classifyUrlHealth(reached(LEDYARD_REPURPOSED));
    expect(r.verdict).toBe("no_event_signal");
  });

  it("specimen A is caught DESPITE being long, on-topic, confident prose", () => {
    // Positive landmark: the page really is substantial. If a future edit made
    // this fixture short, the length short-circuit would catch it for the wrong
    // reason and this suite would still pass.
    const text = visibleText(LEDYARD_REPURPOSED);
    expect(text.length).toBeGreaterThan(600);
    expect(text).toContain("Ledyard");
    expect(classifyUrlHealth(reached(LEDYARD_REPURPOSED)).verdict).toBe("no_event_signal");
  });

  it("specimen A's lone month-name byline is not enough to pass", () => {
    // "posted December" is the only date-ish token on the page. This is the
    // exact assertion that forces the >= 2 signals rule; drop that rule and
    // this is the test that goes red.
    const r = classifyUrlHealth(reached(LEDYARD_REPURPOSED));
    expect(r.signals).toContain("month-name");
    expect(r.signals.length).toBeLessThan(2);
  });

  it("specimen B: the hijacked clintonlionsagfair207.com reads no_event_signal", () => {
    expect(classifyUrlHealth(reached(CLINTON_HIJACKED)).verdict).toBe("no_event_signal");
  });

  it("specimen B is NOT rescued by the fair's own stale 2019 meta-keywords", () => {
    // The keywords are genuinely present in the markup — assert that first, or
    // this test could pass because the fixture lost them.
    expect(CLINTON_HIJACKED).toContain("July 2019");
    expect(CLINTON_HIJACKED).toContain("admission");
    // …and absent from what the classifier actually reads.
    const text = visibleText(CLINTON_HIJACKED);
    expect(text).not.toContain("2019");
    expect(text).not.toContain("admission");
    expect(classifyUrlHealth(reached(CLINTON_HIJACKED)).verdict).toBe("no_event_signal");
  });

  it("both specimens are actionable", () => {
    expect(isActionable(classifyUrlHealth(reached(LEDYARD_REPURPOSED)).verdict)).toBe(true);
    expect(isActionable(classifyUrlHealth(reached(CLINTON_HIJACKED)).verdict)).toBe(true);
  });
});

describe("OPE-860 — a real organizer page stays green", () => {
  it("a genuine fair page reads ok", () => {
    const r = classifyUrlHealth(reached(HEALTHY_FAIR_PAGE));
    expect(r.verdict).toBe("ok");
    // Positive landmark: name WHICH signals fired. "ok" with zero signals would
    // mean the rule had inverted, and `toBe("ok")` alone would not notice.
    expect(r.signals).toEqual(expect.arrayContaining(["month-name", "year", "event-language"]));
  });

  it("a JSON-LD Event alone is sufficient, even on a near-empty page", () => {
    const r = classifyUrlHealth(reached(JSONLD_PAGE));
    expect(r.verdict).toBe("ok");
    expect(r.signals).toContain("jsonld-event");
  });

  it("is not simply returning no_event_signal for everything", () => {
    // The guard against the degenerate classifier the ticket warns about.
    const verdicts = [HEALTHY_FAIR_PAGE, JSONLD_PAGE].map(
      (h) => classifyUrlHealth(reached(h)).verdict
    );
    expect(verdicts).toEqual(["ok", "ok"]);
  });
});

describe("OPE-860 — the four outcomes fetchCanonicalDate used to collapse", () => {
  it("a transport failure is unreachable, NOT no_event_signal", () => {
    // The distinction that did not exist. A DNS failure and a casino domain
    // both used to arrive as {null, null} and increment one counter.
    const r = classifyUrlHealth({ reachedOrigin: false, status: null, html: null });
    expect(r.verdict).toBe("unreachable");
  });

  it("a transport failure is deliberately NOT actionable on its own", () => {
    // Origins blip. A queue full of transient DNS failures is a queue nobody
    // reads, which is how the two real findings would get buried.
    expect(isActionable("unreachable")).toBe(false);
  });

  it("a non-2xx is http_error and carries the status", () => {
    const r = classifyUrlHealth({ reachedOrigin: true, status: 404, html: null });
    expect(r.verdict).toBe("http_error");
    expect(r.detail).toContain("404");
    expect(isActionable("http_error")).toBe(true);
  });

  it.each([200, 204, 299])("treats %i as a reached, successful response", (status) => {
    expect(classifyUrlHealth(reached(HEALTHY_FAIR_PAGE, status)).verdict).toBe("ok");
  });

  it.each([301, 400, 403, 500, 503])("treats %i as http_error", (status) => {
    expect(classifyUrlHealth({ reachedOrigin: true, status, html: null }).verdict).toBe(
      "http_error"
    );
  });

  it("a parked domain serving an empty 200 is not 'healthy because it loaded'", () => {
    const r = classifyUrlHealth(reached("<html><body><p>Coming soon</p></body></html>"));
    expect(r.verdict).toBe("no_event_signal");
  });
});

describe("visibleText", () => {
  it("keeps a stale <title> from rescuing a hijacked page", () => {
    // The case the <head> strip actually exists for, and which neither real
    // specimen exercises — Clinton's title was replaced along with its body.
    // Found by mutation: deleting the <head> strip left every other test green,
    // so without this the line was unpinned and deletable.
    const staleTitleHijack = `<!doctype html><html><head>
      <title>Clinton Lions Agricultural Fair — July 2019 admission and vendors</title>
      </head><body><h1>DRAGON222 Link Alternatif</h1>
      <p>Situs slot gacor hari ini dengan link alternatif terpercaya dan proses
      deposit yang cepat serta layanan pelanggan sepanjang waktu untuk seluruh
      member setia kami di seluruh wilayah nusantara ini.</p></body></html>`;
    // Positive landmark: the title really does carry two signals' worth of text.
    expect(staleTitleHijack).toContain("July 2019");
    expect(staleTitleHijack).toContain("admission");
    expect(classifyUrlHealth(reached(staleTitleHijack)).verdict).toBe("no_event_signal");
  });

  it("strips script, style and head so metadata cannot fake a signal", () => {
    const html = `<html><head><meta name="keywords" content="September 2026 admission"></head>
      <body><script>var d="October 2026 tickets";</script>
      <style>.x{content:"June 2026"}</style><p>Nothing here.</p></body></html>`;
    const text = visibleText(html);
    expect(text).toBe("Nothing here.");
    expect(classifyUrlHealth(reached(html)).verdict).toBe("no_event_signal");
  });
});
