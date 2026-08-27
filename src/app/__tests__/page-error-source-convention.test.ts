/**
 * OPE-574 — a page fetcher that logs under the wrong source is not monitored.
 *
 * The page-error canary (`mcp-server/src/page-error-canary.ts`) counts rows
 * whose `source` matches SQL `LIKE 'app/%page.tsx:%'`. That pattern is the
 * entire contract between a page's error handling and the alerting that
 * watches it — and nothing enforced it.
 *
 * Measured on prod 2026-08-27: `app/search/page` had **4 rows** written and
 * never counted, because the string lacked the `.tsx:<fn>` suffix. The rows
 * exist, they look fine in a query, and the canary is structurally incapable of
 * seeing them. That is the OPE-488 detector-scope family: the write succeeded,
 * so nothing anywhere reports a problem.
 *
 * This is a source-level check on purpose. The alternative — asserting the
 * canary's SQL matches a literal — tests the pattern against itself and would
 * stay green while every call site drifted away from it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

/** The canary's SQL `LIKE 'app/%page.tsx:%'`, as a JS predicate. */
const matchesCanary = (source: string) => /^app\/.*page\.tsx:.+$/.test(source);

const APP_DIR = resolve(__dirname, "..");

/** Every `source: "app/..."` literal inside a page component. */
function findPageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findPageFiles(full));
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

function collectPageSources(): { file: string; source: string }[] {
  const files = findPageFiles(APP_DIR);
  const out: { file: string; source: string }[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/source:\s*"(app\/[^"]+)"/g)) {
      out.push({ file: file.replace(`${APP_DIR}/`, ""), source: m[1] });
    }
  }
  return out;
}

describe("page-level logError sources are visible to the canary", () => {
  const sources = collectPageSources();

  it("finds a meaningful number of sources — guards against a vacuous pass", () => {
    // If the collector breaks (a path change, a formatting change), every
    // assertion below passes over an empty list and this file becomes
    // decorative. Fail loudly instead.
    expect(sources.length).toBeGreaterThan(10);
  });

  it("every one matches the canary's LIKE 'app/%page.tsx:%'", () => {
    const invisible = sources.filter((s) => !matchesCanary(s.source));
    // Named in the failure so the fix is obvious: the source needs a
    // `.tsx:<functionName>` suffix.
    expect(invisible.map((s) => `${s.file} → ${s.source}`)).toEqual([]);
  });

  it("the predicate actually rejects the real prod offender", () => {
    // ⚠️ Without this, a predicate that returned true for everything would make
    // the assertion above pass forever. This is the shape the canary could not
    // see, taken verbatim from error_logs.
    expect(matchesCanary("app/search/page")).toBe(false);
    expect(matchesCanary("app/api/admin/analytics/gsc-metrics/sync:ga4")).toBe(false);
    expect(matchesCanary("app/events/page.tsx:getEvents")).toBe(true);
    expect(matchesCanary("app/events/[slug]/page.tsx:getEvent")).toBe(true);
  });
});
