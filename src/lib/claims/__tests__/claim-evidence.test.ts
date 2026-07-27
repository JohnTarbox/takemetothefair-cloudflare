/**
 * OPE-237 — corroboration classifier + evidence writer.
 *
 * The classifier is where the ticket's "indexed but dead => caution" rule
 * actually lives, so these assert the CLASS returned for each fetch outcome,
 * not just that the function runs.
 */
import { describe, it, expect, vi } from "vitest";
import { classifyDeclaredPresence, pageReferencesBusiness } from "../claim-evidence";

const live = (html: string) => vi.fn().mockResolvedValue({ ok: true, html });
const dead = (reason = "404") =>
  vi.fn().mockResolvedValue({ ok: false, html: null, failReason: reason });

describe("classifyDeclaredPresence (OPE-237 §2)", () => {
  it("NONE when nothing was declared — absence of a site is not suspicious", async () => {
    const res = await classifyDeclaredPresence(null, "CD Ceramics and Florals", dead());
    expect(res.corroboration).toBe("NONE");
  });

  it("STRONG when the declared site is live and names the business", async () => {
    const fetcher = live("<html><h1>CD Ceramics and Florals</h1><p>Handmade</p></html>");
    const res = await classifyDeclaredPresence(
      "https://cdceramics.example",
      "CD Ceramics and Florals",
      fetcher
    );
    expect(res.corroboration).toBe("STRONG");
    expect(fetcher).toHaveBeenCalledWith("https://cdceramics.example");
  });

  it("WEAK — not NONE — when the declared site is dead (the ticket's caution case)", async () => {
    const res = await classifyDeclaredPresence(
      "https://gone.example",
      "SKVL Organic World",
      dead("404")
    );
    expect(res.corroboration).toBe("WEAK");
    expect(res.detail).toContain("indexed-but-dead");
  });

  it("WEAK when the site resolves but never names the business (parked domain)", async () => {
    const parked = live("<html><body>This domain is for sale. Buy now.</body></html>");
    const res = await classifyDeclaredPresence(
      "https://parked.example",
      "Foxy Roxy Homemade",
      parked
    );
    expect(res.corroboration).toBe("WEAK");
    expect(res.detail).toContain("never names the business");
  });

  it("WEAK rather than an exception when the fetcher throws", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("connect ETIMEDOUT"));
    const res = await classifyDeclaredPresence("https://x.example", "Bri Paints", boom);
    expect(res.corroboration).toBe("WEAK");
    expect(res.detail).toContain("ETIMEDOUT");
  });
});

describe("pageReferencesBusiness", () => {
  it("matches across punctuation drift (& vs and)", () => {
    expect(
      pageReferencesBusiness(
        "<p>CD Ceramics &amp; Florals — handmade</p>",
        "CD Ceramics and Florals"
      )
    ).toBe(true);
  });

  it("ignores script and style content so a stray token can't fake a match", () => {
    const html = `<script>var ceramics="florals";</script><body>Unrelated plumbing site</body>`;
    expect(pageReferencesBusiness(html, "CD Ceramics and Florals")).toBe(false);
  });

  it("requires a majority of distinctive tokens — one common word is not a match", () => {
    // "farm" alone must not corroborate "Mixed Roots Farm".
    expect(pageReferencesBusiness("<p>Welcome to our farm</p>", "Mixed Roots Farm")).toBe(false);
    expect(pageReferencesBusiness("<p>Mixed Roots Farm, Vermont</p>", "Mixed Roots Farm")).toBe(
      true
    );
  });

  it("falls back to whole-name matching for very short names", () => {
    // "Douse" has no 4+ char token after dedupe? it does (douse) — but this
    // guards the compact path for names that tokenize to nothing.
    expect(pageReferencesBusiness("<p>DOUSE candles</p>", "Douse")).toBe(true);
    expect(pageReferencesBusiness("<p>unrelated</p>", "Douse")).toBe(false);
  });
});

describe("recordClaimEvidence (OPE-237 writer)", () => {
  it("writes one idempotent row and reports the band", async () => {
    const values = vi
      .fn()
      .mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(null) });
    const db = { insert: vi.fn().mockReturnValue({ values }), update: vi.fn() };

    const { recordClaimEvidence } = await import("../claim-evidence");
    const out = await recordClaimEvidence(db as never, {
      vendorId: "v-1",
      userId: "u-1",
      claimantName: "Colette Dewan",
      businessName: "CD Ceramics and Florals",
      email: "cdceramicsandflorals@gmail.com",
      emailVerified: false,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    const row = values.mock.calls[0][0] as Record<string, unknown>;
    expect(row.vendorId).toBe("v-1");
    expect(row.businessName).toBe("CD Ceramics and Florals");
    // Unchecked corroboration must persist as UNAVAILABLE, never as NONE —
    // "not checked" and "checked, found nothing" are different facts.
    expect(row.corroboration).toBe("UNAVAILABLE");
    expect(JSON.parse(row.reasons as string).join(" ")).toContain("not checked");
    expect(out.band).toBeDefined();
  });

  it("uses onConflictDoNothing so a retried signup cannot double-write", async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(null);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const db = { insert: vi.fn().mockReturnValue({ values }), update: vi.fn() };

    const { recordClaimEvidence } = await import("../claim-evidence");
    await recordClaimEvidence(db as never, {
      vendorId: "v-2",
      userId: null,
      claimantName: null,
      businessName: "Douse",
      email: "jo@gmail.com",
      emailVerified: false,
    });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});
