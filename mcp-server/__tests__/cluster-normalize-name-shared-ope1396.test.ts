/**
 * OPE-1396 (DUP4) — in-batch clustering normalizes names with the SAME function
 * the cross-catalog dedup uses (`normalizeName` in
 * packages/utils/src/duplicates.ts, behind `findDuplicate`).
 *
 * It used to import a local "byte-identical" shim
 * (mcp-server/src/email-handlers/normalize-name-shim.ts) that was not
 * identical: it turned punctuation runs into a SPACE and kept Unicode letters,
 * where utils DELETES every non-[a-z0-9] character. So the two halves of the
 * pipeline disagreed about whether two names were the same event.
 *
 * The cases below pin where clustering behaviour CHANGED with the switch, so a
 * reader sees the trade explicitly rather than discovering it later:
 *   - apostrophes: "Smith's Fair" ≡ "Smiths Fair" now (shim: "smith s" ≠ "smiths")
 *   - intra-word punctuation joins words: "Arts-and-Crafts Fair" is one token
 *     "artsandcrafts", so it no longer clusters with "Arts and Crafts Fair"
 *     (the shim split it into four tokens and clustered them).
 *   - non-ASCII letters are dropped: "Café Fest" → "caf fest".
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeName } from "@takemetothefair/utils";
import { namesDenoteSameEvent } from "../src/email-handlers/cluster-candidates.js";

describe("cluster-candidates uses the shared normalizeName", () => {
  it("apostrophe variants are one event (utils deletes, shim spaced)", () => {
    expect(namesDenoteSameEvent("Smith's Harvest Fair", "Smiths Harvest Fair")).toBe(true);
  });

  it("agrees with utils on the cases where the old shim differed", () => {
    expect(normalizeName("Arts-and-Crafts Fair")).toBe("artsandcrafts fair");
    expect(normalizeName("Café Fest")).toBe("caf fest");
    // Behaviour change, recorded: hyphenated vs spaced spellings no longer cluster.
    expect(namesDenoteSameEvent("Arts-and-Crafts Fair", "Arts and Crafts Fair")).toBe(false);
  });

  it("no second normalizeName is defined anywhere in mcp-server/src", () => {
    const root = join(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          /\.ts$/.test(name) &&
          /function\s+normalizeName\b/.test(readFileSync(full, "utf8"))
        )
          offenders.push(full);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
