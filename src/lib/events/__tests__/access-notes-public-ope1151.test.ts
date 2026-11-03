/**
 * OPE-1151 — `access_notes` renders on EVERY event that has it; the private
 * notes table is unreachable from the main app.
 *
 * Root cause, from source: the only reader of `access_notes` on the page was
 * `formatAudienceBadge` (event-audience.ts), which returns null at PUBLIC +
 * OPEN and folds the note into the badge only for MEMBERS + OPEN under 50
 * characters. Source-level page assertions because the page is a server
 * component over live D1; anchored on CALL syntax, never a bare symbol (the
 * import line would match that).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import { publicAccessNotes } from "../public-access-notes";

const ROOT = join(__dirname, "../../../..");
const eventPage = readFileSync(join(ROOT, "src/app/events/[slug]/page.tsx"), "utf8");

describe("publicAccessNotes", () => {
  it("returns trimmed text, and null for empty / whitespace / null", () => {
    expect(publicAccessNotes("  Seniors 62+ $10.  ")).toBe("Seniors 62+ $10.");
    expect(publicAccessNotes("   ")).toBeNull();
    expect(publicAccessNotes(null)).toBeNull();
    expect(publicAccessNotes(undefined)).toBeNull();
  });
});

describe("the event page renders access_notes independent of audience/access", () => {
  const calls = eventPage.match(/publicAccessNotes\(([^)]*)\)/g) ?? [];

  it("renders from event.accessNotes, exactly once", () => {
    expect(calls).toEqual(["publicAccessNotes(event.accessNotes)"]);
  });

  it("sits in the admission block, outside any audience/access condition", () => {
    const at = eventPage.indexOf("publicAccessNotes(event.accessNotes)");
    // The enclosing block: from the price line to the render call.
    const priceAt = eventPage.lastIndexOf(
      "formatPrice(event.ticketPriceMinCents, event.ticketPriceMaxCents)",
      at
    );
    expect(priceAt).toBeGreaterThan(-1);
    expect(at - priceAt).toBeLessThan(1200);
    const block = eventPage.slice(priceAt, at);
    expect(block).not.toMatch(
      /primaryAudience|publicAccess|formatAudienceBadge|hasNonDefaultAudience/
    );
  });
});

describe("private event notes cannot reach a public serializer", () => {
  it("the events table carries no internal-notes column", () => {
    // A column here would ride every full-row select and eventJoinProjection
    // onto public pages, the RSC payload and public APIs (the OPE-1084 class).
    // Private notes live in `event_internal_notes`.
    const cols = Object.values(getTableColumns(events)).map((c) => c.name);
    expect(cols).toContain("access_notes"); // landmark
    expect(cols.filter((n) => /internal/i.test(n))).toEqual([]);
  });

  it("no main-app source file references the private table", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const code = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          if (/eventInternalNotes|event_internal_notes/.test(code)) hits.push(p);
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(hits).toEqual([]);
  });
});
