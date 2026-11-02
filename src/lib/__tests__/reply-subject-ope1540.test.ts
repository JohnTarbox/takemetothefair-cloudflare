/**
 * OPE-1540 — no outbound path may build a reply subject as `Re: ${subject}`.
 * Six paths did (the MCP reply tool, the admin reply route, the admin page's
 * two prefills, the auto-reply builder and the promoter follow-up draft), and
 * every reply into an ongoing thread went out as "Re: Re: …". They now call
 * `replySubject()` from @takemetothefair/utils, which adds the prefix only when
 * one is not already there.
 *
 * A structural guard rather than a fix-list: it scans every source file, so a
 * seventh path written the old way goes red without anyone remembering this bug.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = ["src", "mcp-server/src", "packages"];
// `Re: ${…}` as a template literal, or "Re: " + … as a concatenation.
const HAND_BUILT_RE = /`Re: \$\{|["']Re: ["']\s*\+/;
// The one place allowed to build it.
const HELPER = "packages/utils/src/email-thread.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("OPE-1540 reply subjects", () => {
  const files = SCAN_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));

  it("no source file hand-builds a `Re: ` subject outside replySubject()", () => {
    // Positive landmarks (v3.8): the scan examined the tree, and the pattern
    // still matches the helper itself, so a regex that silently stopped
    // matching cannot report a clean bill of health.
    expect(files.length).toBeGreaterThan(500);
    expect(HAND_BUILT_RE.test(readFileSync(join(ROOT, HELPER), "utf8"))).toBe(true);
    const offenders = files
      .map((f) => relative(ROOT, f))
      .filter((f) => f !== HELPER && HAND_BUILT_RE.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the paths fixed by OPE-1540 import the shared helper", () => {
    // Matched on the import, because the admin page aliases it (a state
    // variable there is already called `replySubject`).
    const IMPORTS_HELPER =
      /import\s*\{[^}]*\breplySubject\b[^}]*\}\s*from\s*"@takemetothefair\/utils"/;
    const users = files
      .filter((f) => IMPORTS_HELPER.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(users).toEqual(
      expect.arrayContaining([
        "mcp-server/src/tools/reply-to-inbound-email.ts",
        "mcp-server/src/email-reply-builder.ts",
        "src/app/api/admin/inbound-emails/[id]/reply/route.ts",
        "src/app/admin/inbound-emails/page.tsx",
        "packages/db-schema/src/promoter-outreach-state.ts",
      ])
    );
  });
});
