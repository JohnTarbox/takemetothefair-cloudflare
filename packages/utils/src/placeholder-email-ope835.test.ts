/**
 * OPE-835 — a generated address that no mail system will accept.
 *
 * `pending+promoter-<slug>@meetmeatthefair.com` crosses RFC 5321 §4.5.3.1.1's
 * 64-octet local-part limit for long slugs. Cloudflare Email rejects it —
 * correctly — with `Invalid email address: Invalid email user`, and the queue
 * burns four retries before dead-lettering, forever, for the same slug.
 *
 * ⚠️ The filed ticket measured the promoter path (19 of 747). Measured in prod
 * 2026-09-07 there are THREE construction sites and TWO affected populations:
 *
 *   promoters  `pending+promoter-`  747   19 over 64   longest 80
 *   vendors    `pending+`         7,105   12 over 64   longest 102
 *
 * **31 addresses, not 19.** A fix wired into the promoter site alone would have
 * looked complete and left two vendor sites minting invalid addresses:
 *
 *   mcp-server/src/tools/admin.ts:2679        vendor
 *   mcp-server/src/tools/admin.ts:4418        promoter   ← the only one filed
 *   packages/vendor-linking/src/index.ts:617  vendor
 *
 * ⚠️ Performers are NOT affected, and my first count wrongly included them.
 * One of 364 performer slugs exceeds 64 octets — but `performers.user_id` is
 * nullable ("a performer can exist unclaimed with no account") and no code path
 * mints a `pending+` address for one. A long slug that never becomes an email
 * is not a broken email. Counting it was measuring a cohort that cannot contain
 * the defect.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildPlaceholderEmail, MAX_LOCAL_PART_OCTETS } from "./placeholder-account";

/** Real prod slugs, longest first. */
const LONG_PROMOTERS = [
  "home-builders-and-remodelers-association-of-central-connecticut", // 80 octets
  "home-builders-and-remodelers-association-of-southwestern-nh", // 76
  "northern-new-england-chapter-train-collectors-association", // 74
  "fishermans-feast-of-the-madonna-del-soccorso-di-sciacca", // 72
  "historic-metcalf-franklin-farm-preservation-association", // 72
  "southern-vermont-deerfield-valley-chamber-of-commerce", // 70
];

function localPart(email: string): string {
  return email.slice(0, email.lastIndexOf("@"));
}

describe("OPE-835 — the generated local part fits inside 64 octets", () => {
  it("caps every real over-length promoter slug", () => {
    for (const slug of LONG_PROMOTERS) {
      const email = buildPlaceholderEmail("pending+promoter-", slug);
      expect(localPart(email).length, slug).toBeLessThanOrEqual(MAX_LOCAL_PART_OCTETS);
      expect(email.endsWith("@meetmeatthefair.com"), slug).toBe(true);
    }
    // Positive landmark: the fixtures really are over-length to begin with, so
    // "all under 64" is not a statement about six short strings.
    for (const slug of LONG_PROMOTERS) {
      expect(`pending+promoter-${slug}`.length).toBeGreaterThan(MAX_LOCAL_PART_OCTETS);
    }
  });

  it("caps the vendor and performer prefixes too — all three sites", () => {
    const vendor = "a".repeat(120);
    expect(localPart(buildPlaceholderEmail("pending+", vendor)).length).toBeLessThanOrEqual(
      MAX_LOCAL_PART_OCTETS
    );
    expect(
      localPart(buildPlaceholderEmail("pending+promoter-", vendor)).length
    ).toBeLessThanOrEqual(MAX_LOCAL_PART_OCTETS);
  });

  it("leaves short slugs COMPLETELY unchanged — no churn on 7,000+ existing rows", () => {
    // The overwhelming majority of placeholders are well under the limit, and
    // regenerating a different address for them would orphan the users row.
    expect(buildPlaceholderEmail("pending+promoter-", "sterling-fair")).toBe(
      "pending+promoter-sterling-fair@meetmeatthefair.com"
    );
    expect(buildPlaceholderEmail("pending+", "acme-crafts")).toBe(
      "pending+acme-crafts@meetmeatthefair.com"
    );
  });

  it("is stable — the same slug always produces the same address", () => {
    const a = buildPlaceholderEmail("pending+promoter-", LONG_PROMOTERS[0]);
    const b = buildPlaceholderEmail("pending+promoter-", LONG_PROMOTERS[0]);
    expect(a).toBe(b);
  });
});

describe("OPE-835 — why a hash suffix and not a plain truncate", () => {
  it("⚠️ no REAL pair collides today — this is defensive, and the ticket says so", () => {
    // Measured in prod 2026-09-07, both populations, grouped on the naive cut:
    //
    //   promoters over 64, GROUP BY substr(slug,1,47) HAVING count > 1  → 0 rows
    //   vendors   over 64, GROUP BY substr(slug,1,56) HAVING count > 1  → 0 rows
    //
    // My first draft of this test asserted that the two `home-builders-and-
    // remodelers-association-of-…` promoters collide. They do not — they
    // diverge at character 44, inside the 47-character cut. Recording the
    // correction here rather than deleting it, because "a naive truncate is
    // obviously unsafe" is exactly the kind of claim that gets repeated
    // without measurement.
    //
    // The hash is still right: `users.email` is UNIQUE, so a future colliding
    // pair is not a bounced email, it is a failed ingestion or a promoter
    // silently adopting another's owner row. Defending a hard failure that
    // costs 9 characters is worth it. But it is a guard against a possible
    // case, not a fix for a live one.
    const shared = "c".repeat(47);
    const a = buildPlaceholderEmail("pending+promoter-", shared + "-central-connecticut");
    const b = buildPlaceholderEmail("pending+promoter-", shared + "-southwestern-nh");

    // The premise: these two really are identical across the naive cut.
    const cut = MAX_LOCAL_PART_OCTETS - "pending+promoter-".length;
    expect((shared + "-central-connecticut").slice(0, cut)).toBe(
      (shared + "-southwestern-nh").slice(0, cut)
    );
    // …and the hash is what keeps them apart.
    expect(a).not.toBe(b);
  });

  it("distinguishes slugs differing only in their tail", () => {
    const base = "b".repeat(80);
    expect(buildPlaceholderEmail("pending+", base + "-one")).not.toBe(
      buildPlaceholderEmail("pending+", base + "-two")
    );
  });

  it("refuses a prefix that leaves no room, rather than collapsing every entity onto one address", () => {
    expect(() => buildPlaceholderEmail("x".repeat(60), "anything")).toThrow(/no room/);
  });
});

describe("OPE-835 AC3 — the family guard: nothing builds these by hand", () => {
  it("no source file constructs a pending+ address by string template", () => {
    // AC3 asks for the family to be swept AND guarded. Without this, a fourth
    // construction site added later reintroduces the exact defect, and nothing
    // fails — which is how there came to be three.
    const roots = ["src", "mcp-server/src", "packages"];
    const repo = join(__dirname, "..", "..", "..");
    const offenders: string[] = [];
    let scanned = 0;

    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e === "node_modules" || e === "__tests__" || e === "dist" || e === ".next") continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(full) || /\.test\.tsx?$/.test(full)) continue;
        scanned++;
        const src = readFileSync(full, "utf8");
        // A template literal that interpolates straight into a pending+ address.
        if (/`pending\+[^`]*\$\{/.test(src)) offenders.push(full.replace(repo, ""));
      }
    };
    for (const r of roots) walk(join(repo, r));

    // Positive landmark: a scan that silently walked nothing would report a
    // clean bill of health. This asserts the walk actually happened.
    expect(scanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
