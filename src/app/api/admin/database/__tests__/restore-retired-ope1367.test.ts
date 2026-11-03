/**
 * OPE-1367 — the in-app database restore is retired. D1 Time Travel
 * (`wrangler d1 time-travel restore`, docs/d1-restore-procedure.md) is the only
 * recovery path. These assertions fail if the route, or the admin UI that
 * called it, comes back.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "../../../..");
const ROUTE_DIR = join(APP, "api/admin/database/restore");

describe("OPE-1367: /api/admin/database/restore is gone", () => {
  it("has no route handler (Next.js serves 404 for an absent route file)", () => {
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      expect(existsSync(join(ROUTE_DIR, `route.${ext}`))).toBe(false);
    }
  });

  it("the admin database page no longer calls it or offers a restore upload", () => {
    const page = readFileSync(join(APP, "admin/database/page.tsx"), "utf8");
    expect(page).not.toContain("/api/admin/database/restore");
    expect(page).not.toContain("yes-restore-database");
    expect(page).not.toMatch(/type="file"/);
    // The read-only export stays, and the page points at the recovery runbook.
    expect(page).toContain("/api/admin/database/backup");
    expect(page).toContain("docs/d1-restore-procedure.md");
  });

  it("the backup route (read-only export) still exists", () => {
    expect(existsSync(join(APP, "api/admin/database/backup/route.ts"))).toBe(true);
  });
});
