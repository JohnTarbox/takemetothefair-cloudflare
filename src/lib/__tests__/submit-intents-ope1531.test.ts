/**
 * OPE-1531 — no reader may filter the submit pipeline on `intent = 'submit'`
 * alone. `submit` is only the submit@ address-fallback intent; a confident
 * classifier stores `new_event`, and both run the same pipeline. Filtering on
 * `submit` alone silently drops every confidently-classified submission
 * (OPE-1530: heartbeat red ~22d on a live lane; OPE-1531: sender quality and
 * source-quality yield).
 *
 * A structural guard rather than a fix-list: it scans every source file, so a
 * new reader written the old way goes red without anyone remembering this bug.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SUBMIT_PIPELINE_INTENTS } from "@takemetothefair/constants";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = ["src", "mcp-server/src"];
const SUBMIT_ONLY = /eq\(\s*inboundEmails\.intent\s*,\s*["']submit["']\s*\)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("OPE-1531 submit-pipeline intent readers", () => {
  const files = SCAN_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));

  it("the shared constant names both intents", () => {
    expect([...SUBMIT_PIPELINE_INTENTS].sort()).toEqual(["new_event", "submit"]);
  });

  it("no source file filters inbound_emails on intent='submit' alone", () => {
    // Positive landmark (v3.8): a scan that stopped finding files would report
    // a clean bill of health, so assert it actually examined the tree.
    expect(files.length).toBeGreaterThan(500);
    const offenders = files
      .filter((f) => SUBMIT_ONLY.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the readers fixed by OPE-1531 use the shared constant", () => {
    const users = files
      .filter((f) => /SUBMIT_PIPELINE_INTENTS\]/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(users).toEqual(
      expect.arrayContaining([
        "mcp-server/src/tools/admin-email-senders.ts",
        "src/app/api/admin/inbound-emails/senders/route.ts",
        "src/app/admin/source-quality/page.tsx",
      ])
    );
  });
});
