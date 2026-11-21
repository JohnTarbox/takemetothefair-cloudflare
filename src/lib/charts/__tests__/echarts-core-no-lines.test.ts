/**
 * OPE-1577 — GHSA-fgmj-fm8m-jvvx (echarts < 6.1.0) is accepted only because the
 * vulnerable Lines series is never registered. This keeps that reason true.
 * See docs/audits/dependency-audit-acceptances.md.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../../../components/admin/charts/echarts-core.ts"),
  "utf8"
);

describe("echarts registration (OPE-1577)", () => {
  it("registers the line chart (landmark: this reads the real module)", () => {
    expect(source).toMatch(/\bLineChart\b/);
  });

  it("never registers the Lines series the advisory is about", () => {
    expect(source).not.toMatch(/\bLinesChart\b/);
  });
});
