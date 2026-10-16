// @vitest-environment node
/**
 * OPE-1385 follow-up — every Tailwind `content` glob must match real files.
 *
 * tailwind.config.ts pointed at `../mcw-calendar-grid/dist/**\/*.js`, a sibling
 * checkout that exists in no worktree and not in CI. Tailwind does not warn about
 * a glob that matches nothing, so the classes used only inside
 * @johntarbox/calendar-grid (bg-gray-50, text-gray-500, border-gray-100, ...)
 * were silently missing from every production build.
 */
import { describe, it, expect } from "vitest";
import fg from "fast-glob";
import path from "node:path";
import config from "../../../tailwind.config";

const ROOT = path.resolve(__dirname, "../../..");

function contentGlobs(): string[] {
  const content = config.content;
  const files = Array.isArray(content) ? content : content.files;
  return files.filter((f): f is string => typeof f === "string");
}

// Globs reaching OUTSIDE src/ (packages, sibling checkouts) are the ones that
// rot silently. The in-src defaults are exempt: `./src/pages/**` is the
// create-next-app default and matches nothing in an App Router project, harmlessly.
const externalGlobs = () => contentGlobs().filter((g) => !g.startsWith("./src/"));

describe("tailwind content globs", () => {
  it("has at least one glob outside src/ to check", () => {
    expect(externalGlobs().length).toBeGreaterThan(0);
  });

  it.each(externalGlobs())("%s matches at least one file", (glob) => {
    const matches = fg.sync(glob, { cwd: ROOT, dot: false });
    expect(matches.length).toBeGreaterThan(0);
  });

  it("scans the installed @johntarbox/calendar-grid package", () => {
    const globs = contentGlobs();
    expect(globs.some((g) => g.includes("node_modules/@johntarbox/calendar-grid/"))).toBe(true);
  });
});
