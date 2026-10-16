/**
 * OPE-1380 — the nonce-CSP route guard (scripts/check-nonce-csp-routes.ts)
 * reads segment config from the AST; pin each export shape it must catch, and
 * that it passes on the real tree.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { segmentConfig, urlForPage } from "../../../scripts/check-nonce-csp-routes";

describe("segmentConfig", () => {
  it("catches revalidate, generateStaticParams (function or const) and a non-force-dynamic `dynamic`", () => {
    expect(segmentConfig("export const revalidate = 300;").revalidate).toBe(true);
    expect(
      segmentConfig("export async function generateStaticParams() { return []; }")
        .generateStaticParams
    ).toBe(true);
    expect(
      segmentConfig("export const generateStaticParams = async () => [];").generateStaticParams
    ).toBe(true);
    expect(segmentConfig('export const dynamic = "force-static";').dynamic).toBe("force-static");
    expect(segmentConfig("const revalidate = 1; export { revalidate };").revalidate).toBe(true);
  });

  it("ignores non-exported names and prose (positive landmark: force-dynamic is read)", () => {
    const cfg = segmentConfig(
      '// export const revalidate = 300\nconst revalidate = 5;\nexport const dynamic = "force-dynamic";'
    );
    expect(cfg).toEqual({
      revalidate: false,
      generateStaticParams: false,
      dynamic: "force-dynamic",
    });
  });
});

describe("urlForPage", () => {
  it("strips route groups and samples dynamic segments", () => {
    const root = process.cwd();
    expect(urlForPage(`${root}/src/app/(auth)/reset-password/[token]/page.tsx`)).toBe(
      "/reset-password/x"
    );
    expect(urlForPage(`${root}/src/app/dashboard/page.tsx`)).toBe("/dashboard");
  });
});

describe("the guard on the real tree", () => {
  it("passes", () => {
    const r = spawnSync("npx", ["tsx", "scripts/check-nonce-csp-routes.ts"], { encoding: "utf8" });
    expect(r.stderr + r.stdout).toMatch(/^OK \d+ pages/m);
    expect(r.status).toBe(0);
  }, 60_000);
});
