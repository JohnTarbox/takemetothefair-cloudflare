/**
 * OPE-1269 — a review of a JSON-LD-sourced candidate compares like with like.
 *
 * The regression test is id 10950: Bay State Savings Bank's `(508) 890-9640`
 * read as a digit transposition of a visible number, when the bank's JSON-LD
 * publishes it as one of ten branch lines. Fixture modelled on that page.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  annotateForReview,
  checkAgainstHtml,
  checkCandidateStructuredData,
  structuredDataValues,
  valueMatches,
  JSONLD_EVIDENCE_NOTE,
  VERIFY_MAX_ROWS,
} from "../src/enrichment/structured-data-check.js";

const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

/** Visible text shows three tel: links; the ten-line list is only in JSON-LD. */
const BAY_STATE = `<html><head>${ld({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "BankOrCreditUnion", name: "Bay State Bank", telephone: "+15088909090" },
    ...["+15088909640", "+15088909641", "+15088909642"].map((t, i) => ({
      "@type": "BankOrCreditUnion",
      name: `Bay State Bank — Branch ${i}`,
      telephone: t,
    })),
  ],
})}</head><body><a href="tel:8002448161">(800) 244-8161</a><a href="tel:5088909090">(508) 890-9090</a></body></html>`;

describe("ACCEPTANCE — id 10950 reads found, not mismatch", () => {
  it("the proposed branch line is found in the JSON-LD, whatever its formatting", () => {
    const r = checkAgainstHtml("contact_phone", "(508) 890-9640", BAY_STATE);
    expect(r.status).toBe("found");
    expect(r.values).toContain("+15088909640");
  });

  it("landmark: a number that is NOT published reads not_found, with the published values shown", () => {
    const r = checkAgainstHtml("contact_phone", "(508) 890-9604", BAY_STATE);
    expect(r.status).toBe("not_found");
    expect(r.values.length).toBeGreaterThan(1);
  });
});

describe("could-not-look is never not_found (the robots.txt-timeout specimen)", () => {
  it("a timeout is fetch_failed", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const r = await checkCandidateStructuredData("https://x.example/", "contact_phone", "1", {
      fetchImpl,
    });
    expect(r.status).toBe("fetch_failed");
    expect(r.detail).toBe("timed out reading source_url");
  });

  it("a 403 is fetch_failed with the status", async () => {
    const fetchImpl = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    const r = await checkCandidateStructuredData("https://x.example/", "contact_phone", "1", {
      fetchImpl,
    });
    expect(r).toMatchObject({ status: "fetch_failed", detail: "HTTP 403 from source_url" });
  });

  it("a page with no JSON-LD is no_structured_data — distinct from not_found", () => {
    expect(
      checkAgainstHtml("contact_phone", "(207) 659-6457", "<p>call (207) 659-6457</p>").status
    ).toBe("no_structured_data");
  });

  it("a field with no structured-data key is not_applicable, and is never fetched", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await checkCandidateStructuredData("https://x.example/", "description", "x", {
      fetchImpl,
    });
    expect(r.status).toBe("not_applicable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the field rules", () => {
  it("phones match on the last 10 digits; vanity letters are not guessed", () => {
    expect(valueMatches("contact_phone", "(207) 659-6457", ["(207) 659-6457"])).toBe(true);
    expect(valueMatches("contact_phone", "(207) 763-3891", ["2077633891"])).toBe(true);
    expect(valueMatches("contact_phone", "(800) 370-7463", ["+1-800-370-7463"])).toBe(true);
  });

  it("emails ignore case and mailto:", () => {
    expect(valueMatches("contact_email", "Info@Farm.com", ["mailto:info@farm.com"])).toBe(true);
  });

  it("social links: every proposed link must be published (scheme/www/slash-insensitive)", () => {
    const sameAs = ["https://facebook.com/Biwaa", "https://www.instagram.com/biwaa/"];
    expect(
      valueMatches(
        "social_links",
        JSON.stringify({ facebook: "https://www.facebook.com/Biwaa/" }),
        sameAs
      )
    ).toBe(true);
    expect(
      valueMatches(
        "social_links",
        JSON.stringify({
          facebook: "https://www.facebook.com/Biwaa/",
          instagram: "https://www.instagram.com/explore/tags/biwaa/",
        }),
        sameAs
      )
    ).toBe(false);
  });

  it("values are found in nested nodes (contactPoint, location.address)", () => {
    const html = ld({
      "@type": "Organization",
      contactPoint: { "@type": "ContactPoint", telephone: "+1-603-456-2443", email: "hi@farm.com" },
      location: {
        address: {
          "@type": "PostalAddress",
          streetAddress: "109 Apremont Way",
          addressLocality: "Westfield",
        },
      },
    });
    expect(structuredDataValues(html, "contact_phone")).toEqual(["+1-603-456-2443"]);
    expect(checkAgainstHtml("contact_email", "hi@farm.com", html).status).toBe("found");
    expect(checkAgainstHtml("address", "109 apremont  way", html).status).toBe("found");
    expect(checkAgainstHtml("city", "Westfield", html).status).toBe("found");
  });
});

describe("annotateForReview — every jsonld row says what counts as evidence", () => {
  const row = (i: number, method = "jsonld") => ({
    id: i,
    field: "contact_phone",
    proposed_value: "(508) 890-9640",
    source_url: `https://s${i}.example/`,
    extraction_method: method,
  });

  it("jsonld rows carry the evidence note; others do not; nothing is fetched without verify", async () => {
    const out = await annotateForReview([row(1), row(2, "tel")], false);
    expect(out[0].evidence_note).toBe(JSONLD_EVIDENCE_NOTE);
    expect(out[1].evidence_note).toBeUndefined();
    expect(out[0].structured_data_check).toBeUndefined();
  });

  it("verify checks the first VERIFY_MAX_ROWS rows and marks the rest not_checked", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(BAY_STATE, { status: 200 })
    ) as unknown as typeof fetch;
    const rows = Array.from({ length: VERIFY_MAX_ROWS + 3 }, (_, i) => row(i));
    const out = await annotateForReview(rows, true, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(VERIFY_MAX_ROWS);
    expect(
      out
        .slice(0, VERIFY_MAX_ROWS)
        .every((r) => (r.structured_data_check as { status: string }).status === "found")
    ).toBe(true);
    expect(out.slice(VERIFY_MAX_ROWS).every((r) => r.structured_data_check === "not_checked")).toBe(
      true
    );
  });
});

describe("all three review tools use it (source-level — one helper, no drift)", () => {
  for (const f of [
    "admin-enrichment-review",
    "admin-promoter-enrichment-review",
    "admin-performer-enrichment-review",
  ]) {
    it(f, () => {
      const src = readFileSync(`${__dirname}/../src/tools/${f}.ts`, "utf8");
      expect(src).toContain("candidates: await annotateForReview(");
      expect(src).toContain("params.verify_structured_data ?? false");
      expect(src).toContain("verify_structured_data: z");
      expect(src).toContain("OPE-1269 — REVIEW EVIDENCE");
    });
  }
});
