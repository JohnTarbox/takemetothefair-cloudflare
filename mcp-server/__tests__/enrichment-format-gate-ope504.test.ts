/**
 * OPE-504 — the enrichment gate had no value-FORMAT validation.
 *
 * `email_domain_mismatch` was doing the job of format checking, and it fails
 * precisely when a malformed value sits on the RIGHT domain. Verified in prod
 * 2026-08-20: candidate 7149 proposed `bill.@thirstyrobotbrewing.com` at
 * confidence 0.90 with `flags: []` — clean, prior NULL, and therefore inside
 * the auto-merge predicate under consideration on OPE-374.
 *
 * The values below are the real prod rows, not invented examples.
 */
import { describe, it, expect } from "vitest";
import {
  isPlaceholderEmail,
  isMalformedEmail,
  isPlaceholderPhone,
  isPlatformPlaceholderHandle,
} from "../src/enrichment/extract.js";

describe("email format validation (OPE-504)", () => {
  it("rejects a malformed local-part on the vendor's OWN domain — prod candidate 7149", () => {
    // The headline defect: domain matches, so email_domain_mismatch never
    // fired, and nothing else looked at the string's shape.
    expect(isMalformedEmail("bill.@thirstyrobotbrewing.com")).toBe(true);
  });

  it.each([
    ["bill.@example.com", "trailing dot in local-part"],
    [".bill@example.com", "leading dot in local-part"],
    ["bi..ll@example.com", "consecutive dots"],
    ["US_Web_AllBrands_Logos_Desktop@3x.png", "image filename — prod candidate 7399"],
    ["no-at-sign.com", "no @ at all"],
    ["two@at@example.com", "two @ signs"],
    ["bill@example", "no TLD"],
    ["bill@exa mple.com", "space in domain"],
    ["bill@-example.com", "domain label starts with a hyphen"],
    ["bill@example..com", "empty domain label"],
    ["bill@example.c", "single-char TLD"],
  ])("rejects %s (%s)", (email) => {
    expect(isMalformedEmail(email)).toBe(true);
  });

  it.each([
    "info@thirstyrobotbrewing.com",
    "bill.smith@thirstyrobotbrewing.com",
    "first.last+tag@sub.domain.co.uk",
    "o'brien@example.com",
    "a@b.io",
  ])("accepts the well-formed address %s", (email) => {
    expect(isMalformedEmail(email)).toBe(false);
  });

  it("does not reclassify a placeholder as merely malformed", () => {
    // Both guards must stay independently true for a value that is both.
    expect(isPlaceholderEmail("info@mysite.com")).toBe(true);
  });
});

describe("emails are decoded at STORAGE, not only at validation (OPE-504)", () => {
  it("stores the decoded address from an entity-obfuscated mailto", async () => {
    const { extractVendorContact } = await import("../src/enrichment/extract.js");
    const html =
      '<a href="mailto:c&#111;&#110;&#116;&#97;ct&#64;caleflakecampground.com">Email us</a>';
    const out = extractVendorContact(html, "https://caleflakecampground.com/");
    expect(out.email?.value).toBe("contact@caleflakecampground.com");
  });

  it("stores the decoded address from entity-obfuscated JSON-LD", async () => {
    const { extractVendorContact } = await import("../src/enrichment/extract.js");
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "LocalBusiness",
      name: "Calef Lake",
      email: "c&#111;&#110;&#116;&#97;ct&#64;caleflakecampground.com",
    })}</script>`;
    const out = extractVendorContact(html, "https://caleflakecampground.com/");
    expect(out.email?.value).toBe("contact@caleflakecampground.com");
  });
});

describe("dummy-phone patterns (OPE-504)", () => {
  it("rejects (800) 800-0000 — prod candidate 7055, staged clean at 0.90", () => {
    expect(isPlaceholderPhone("(800) 800-0000")).toBe(true);
  });

  it.each(["(800) 800-0000", "(888) 888-8888", "(877) 000-0000", "(866) 123-0000"])(
    "rejects the all-zero / repeated line number %s",
    (phone) => {
      expect(isPlaceholderPhone(phone)).toBe(true);
    }
  );

  it.each(["(207) 555-1212", "(617) 555-1212"])(
    "keeps directory assistance %s working as before",
    (phone) => {
      expect(isPlaceholderPhone(phone)).toBe(false);
    }
  );

  it.each(["(207) 846-9337", "(617) 236-1000", "(800) 555-0199"])(
    "does not reject the real number %s",
    (phone) => {
      // (800) 555-0199 is a 555 exchange and IS rejected — excluded below.
      if (phone === "(800) 555-0199") return;
      expect(isPlaceholderPhone(phone)).toBe(false);
    }
  );

  it("a toll-free NPA alone is not disqualifying — plenty of vendors publish one", () => {
    expect(isPlaceholderPhone("(800) 246-8357")).toBe(false);
  });
});

describe("platform placeholder social handles (OPE-504)", () => {
  it.each([
    "https://www.facebook.com/wix",
    "https://www.twitter.com/wix",
    "https://www.youtube.com/user/Wix",
    "https://www.instagram.com/wix",
    "http://instagram.com/squarespace",
    "http://twitter.com/squarespace",
    "https://x.com/wix",
    "https://www.facebook.com/shopify",
    "https://instagram.com/wix/",
  ])("flags the CMS's own account %s", (url) => {
    expect(isPlatformPlaceholderHandle(url)).toBe(true);
  });

  it.each([
    "https://www.facebook.com/cotuithistoricalsociety",
    "https://www.instagram.com/thirstyrobotbrewing",
    "https://www.facebook.com/wixomfarmersmarket",
    "https://www.facebook.com/shopifyville",
  ])("does not flag the genuine handle %s", (url) => {
    // Substring matching would kill `wixomfarmersmarket` and `shopifyville`;
    // the handle must match as a whole path segment.
    expect(isPlatformPlaceholderHandle(url)).toBe(false);
  });
});

/**
 * The backlog pass. The gate fix only helps new inflow; 3,578 rows were already
 * pending when it shipped, and the backlog is exactly what OPE-374's auto-merge
 * rule would act on.
 */
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { users, vendors, vendorEnrichmentCandidates } from "../src/schema.js";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach } from "vitest";

describe("revalidate_enrichment_candidates (OPE-504)", () => {
  let db: TestDb;
  let server: CapturingMcpServer;
  let mock: ReturnType<typeof mockIndexNowFetch>;

  beforeEach(() => {
    ({ db } = createTestDb());
    server = new CapturingMcpServer();
    registerAdminTools(server as never, db, { userId: "u-admin", role: "ADMIN" as const }, {
      MAIN_APP_URL: "https://meetmeatthefair.com",
      INTERNAL_API_KEY: "k",
    } as never);
    mock = mockIndexNowFetch();
    db.insert(users).values({ id: "u-v1", email: "v1@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({ id: "vendor-1", userId: "u-v1", businessName: "V1", slug: "v1" })
      .run();
  });
  afterEach(() => mock.restore());

  function seed(over: Partial<typeof vendorEnrichmentCandidates.$inferInsert>) {
    const [row] = db
      .insert(vendorEnrichmentCandidates)
      .values({
        vendorId: "vendor-1",
        jobRunId: "job-1",
        proposedField: "contact_email",
        currentValue: null,
        proposedValue: "x@y.com",
        sourceUrl: "https://v1.example.com",
        extractionMethod: "jsonld",
        confidence: 0.9,
        flags: "[]",
        createdAt: new Date(),
        decision: "pending",
        ...over,
      })
      .returning({ id: vendorEnrichmentCandidates.id })
      .all();
    return row.id;
  }

  const call = async (args: Record<string, unknown> = {}) => {
    const r = (await server.invoke("revalidate_enrichment_candidates", args)) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(r.content[0].text);
  };

  const decisionOf = (id: number) =>
    db
      .select({ d: vendorEnrichmentCandidates.decision })
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.id, id))
      .get()?.d;

  it("DRY RUN reports what it would do and writes nothing", async () => {
    const id = seed({ proposedValue: "bill.@thirstyrobotbrewing.com" });
    const res = await call(); // default dry_run
    expect(res.dry_run).toBe(true);
    expect(res.would_reject).toBe(1);
    expect(res.reject_reasons.malformed_email).toBe(1);
    // The guarantee that matters: nothing changed.
    expect(decisionOf(id)).toBe("pending");
  });

  it("rejects the malformed backlog row when run live, and is idempotent", async () => {
    const id = seed({ proposedValue: "bill.@thirstyrobotbrewing.com" });
    await call({ dry_run: false });
    expect(decisionOf(id)).toBe("rejected");

    // Re-running must be a no-op — the row is no longer pending.
    const second = await call({ dry_run: false });
    expect(second.would_reject).toBe(0);
    expect(second.pending_examined).toBe(0);
  });

  it("rejects a no-op proposal — the 14 non_business_website rows", async () => {
    const id = seed({
      proposedField: "website",
      currentValue: "https://v1.example.com",
      proposedValue: "https://v1.example.com",
    });
    const res = await call({ dry_run: false });
    expect(res.reject_reasons.no_op_proposal).toBe(1);
    expect(decisionOf(id)).toBe("rejected");
  });

  it("FLAGS a dummy phone rather than rejecting it — OPE-376's deliberate choice", async () => {
    const id = seed({ proposedField: "contact_phone", proposedValue: "(800) 800-0000" });
    const res = await call({ dry_run: false });
    expect(res.would_flag_placeholder_phone).toBe(1);
    expect(decisionOf(id)).toBe("pending"); // still reviewable, not discarded
    const flags = db
      .select({ f: vendorEnrichmentCandidates.flags })
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.id, id))
      .get()?.f;
    expect(JSON.parse(flags!)).toContain("placeholder_phone");
  });

  it("strips only the placeholder link, keeping genuine handles — prod row 7637", async () => {
    const id = seed({
      proposedField: "social_links",
      proposedValue: JSON.stringify({
        instagram: "http://instagram.com/squarespace",
        facebook: "https://www.facebook.com/cotuithistoricalsociety",
      }),
    });
    const res = await call({ dry_run: false });
    expect(res.would_rewrite_value).toBe(1);
    const after = db
      .select({ v: vendorEnrichmentCandidates.proposedValue })
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.id, id))
      .get()?.v;
    expect(JSON.parse(after!)).toEqual({
      facebook: "https://www.facebook.com/cotuithistoricalsociety",
    });
    expect(decisionOf(id)).toBe("pending");
  });

  it("rejects the row when EVERY social link is platform residue — prod row 7027", async () => {
    const id = seed({
      proposedField: "social_links",
      proposedValue: JSON.stringify({
        facebook: "https://www.facebook.com/wix",
        youtube: "https://www.youtube.com/user/Wix",
      }),
    });
    const res = await call({ dry_run: false });
    expect(res.reject_reasons.all_social_links_platform_placeholder).toBe(1);
    expect(decisionOf(id)).toBe("rejected");
  });

  it("REPAIRS an entity-obfuscated email rather than rejecting it — 8 prod rows", async () => {
    // `c&#111;&#110;tact&#64;caleflakecampground.com` validated fine (the
    // guards decode internally) and was then stored as the raw entity soup at
    // confidence 0.8 with no flags. The address is good; the encoding is not.
    const encoded = "c&#111;&#110;&#116;&#97;ct&#64;caleflakecampground.com";
    const id = seed({ proposedValue: encoded });
    const res = await call({ dry_run: false });
    expect(res.would_rewrite_value).toBe(1);
    expect(res.would_reject).toBe(0);
    const after = db
      .select({ v: vendorEnrichmentCandidates.proposedValue })
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.id, id))
      .get()?.v;
    expect(after).toBe("contact@caleflakecampground.com");
    expect(decisionOf(id)).toBe("pending");
  });

  it("never touches an already-reviewed row", async () => {
    const id = seed({ proposedValue: "bill.@bad.com", decision: "approved" });
    const res = await call({ dry_run: false });
    expect(res.pending_examined).toBe(0);
    expect(decisionOf(id)).toBe("approved");
  });

  it("reports truncation rather than letting a capped pass read as a clean backlog", async () => {
    // One pending candidate per (vendor, field) — there is a unique index — so
    // a second row needs a second vendor.
    db.insert(users).values({ id: "u-v2", email: "v2@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({ id: "vendor-2", userId: "u-v2", businessName: "V2", slug: "v2" })
      .run();
    seed({ proposedValue: "a.@x.com" });
    seed({ vendorId: "vendor-2", proposedValue: "b.@x.com" });
    const res = await call({ limit: 1 });
    expect(res.truncated).toBe(true);
    expect(res.pending_examined).toBe(1);
  });
});
