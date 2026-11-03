/**
 * OPE-1293 — the Monday inventory reports dark capabilities, and a reader that
 * cannot read never reports a clean bill.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isCapabilityFlagDark } from "@takemetothefair/constants";
import {
  formatDarkCapabilitiesSection,
  readCapabilityFlags,
  resolveMcpOwnedFlags,
  type CapabilityFlagRow,
} from "../src/inventory-dark-capabilities.js";

/** A route-shaped row, as GET /api/admin/capability-flags returns it. */
const mainRow = (
  name: string,
  value: string | null,
  offIsDeliberate: boolean
): CapabilityFlagRow => ({
  name,
  worker: "main-app",
  value,
  dark: isCapabilityFlagDark(name, value),
  off_is_deliberate: offIsDeliberate,
  dark_means: `${name} is off`,
  readable_here: true,
});
const mcpRow = (name: string, offIsDeliberate = true): CapabilityFlagRow => ({
  name,
  worker: "mcp",
  value: null,
  dark: null,
  off_is_deliberate: offIsDeliberate,
  dark_means: `${name} is off`,
  readable_here: false,
});

const fakeFetch = (flags: CapabilityFlagRow[], status = 200) =>
  (async () =>
    new Response(JSON.stringify({ ok: true, flags }), { status })) as unknown as typeof fetch;

const ENV = { MAIN_APP_URL: "https://x", INTERNAL_API_KEY: "k" };

describe("ACCEPTANCE — CONDITIONAL_GET_PUBLIC_CACHE, pinned from both sides", () => {
  it('"false" → a ⚠️ NOT-deliberate line in the section', async () => {
    const read = await readCapabilityFlags(
      ENV,
      fakeFetch([mainRow("CONDITIONAL_GET_PUBLIC_CACHE", "false", false)])
    );
    const text = formatDarkCapabilitiesSection(read);
    expect(text).toContain("⚠️ CONDITIONAL_GET_PUBLIC_CACHE = false [main-app] NOT deliberate");
  });

  it('"true" → no line for it, and an explicit all-lit statement', async () => {
    const read = await readCapabilityFlags(
      ENV,
      fakeFetch([mainRow("CONDITIONAL_GET_PUBLIC_CACHE", "true", false)])
    );
    const text = formatDarkCapabilitiesSection(read);
    expect(text).not.toContain("CONDITIONAL_GET_PUBLIC_CACHE");
    expect(text).toContain("All lit — 1 of 1 on.");
  });
});

describe("a reader that cannot read never reports a clean bill", () => {
  it("a failed fetch renders UNKNOWN, not all lit", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const text = formatDarkCapabilitiesSection(await readCapabilityFlags(ENV, throwing));
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("NOT a clean bill");
    expect(text).not.toContain("All lit");
  });

  it("a non-2xx renders UNKNOWN with the status", async () => {
    const text = formatDarkCapabilitiesSection(await readCapabilityFlags(ENV, fakeFetch([], 401)));
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("HTTP 401");
  });

  it("a flag nobody resolved is UNKNOWN, and blocks the all-lit line", () => {
    const text = formatDarkCapabilitiesSection({
      ok: true,
      rows: [mainRow("A_FLAG", "true", false), { ...mcpRow("PHOTO_VISION_ENABLED"), dark: null }],
    });
    expect(text).toContain("UNKNOWN (1): PHOTO_VISION_ENABLED [mcp]");
    expect(text).not.toContain("All lit");
  });
});

describe("MCP-owned flags are resolved from THIS Worker's env with the shared rule", () => {
  it("a lit MCP flag is lit; an unset one is dark", () => {
    const rows = resolveMcpOwnedFlags([mcpRow("PHOTO_VISION_ENABLED"), mcpRow("OTHER_MCP_FLAG")], {
      PHOTO_VISION_ENABLED: "true",
    });
    expect(rows.map((r) => [r.name, r.dark])).toEqual([
      ["PHOTO_VISION_ENABLED", false],
      ["OTHER_MCP_FLAG", true],
    ]);
  });

  it("ENRICHMENT_DRY_RUN stays inverted: unset is DARK, 'false' is lit", () => {
    const [unset] = resolveMcpOwnedFlags([mcpRow("ENRICHMENT_DRY_RUN")], {});
    const [off] = resolveMcpOwnedFlags([mcpRow("ENRICHMENT_DRY_RUN")], {
      ENRICHMENT_DRY_RUN: "false",
    });
    expect(unset.dark).toBe(true);
    expect(off.dark).toBe(false);
  });
});

describe("ordering and the positive landmark", () => {
  it("NOT-deliberate first, and the count of flags examined is stated", () => {
    const text = formatDarkCapabilitiesSection({
      ok: true,
      rows: [
        mainRow("DELIBERATE_OFF", "false", true),
        mainRow("SURPRISE_OFF", "false", false),
        mainRow("LIT", "true", false),
      ],
    });
    expect(text).toContain("Dark capabilities (3 flags examined):");
    expect(text.indexOf("SURPRISE_OFF")).toBeLessThan(text.indexOf("DELIBERATE_OFF"));
  });
});

describe("wiring", () => {
  it("the Monday inventory reads the flags and puts the section in BOTH bodies", () => {
    const src = readFileSync(resolve(__dirname, "../src/weekly-inventory-notice.ts"), "utf8");
    expect(src).toContain("formatDarkCapabilitiesSection(");
    expect(src).toContain("await readCapabilityFlags(");
    expect(src).toMatch(/watchText \+\s*darkText \+/);
    expect(src).toMatch(/<pre[^`]*\$\{darkText/);
  });
});
