/**
 * OPE-1360 CI guard — every `application/ld+json` emitter must serialise
 * through `safeJsonLd` (src/lib/seo/safe-json-ld.ts).
 *
 * For EACH `application/ld+json` occurrence in a non-test src/**\/*.tsx file,
 * the `__html:` value of the following dangerouslySetInnerHTML must be either
 * a direct `safeJsonLd(...)` call or an identifier bound by
 * `const <id> = safeJsonLd(...)`. Keyed per emitter (not per file), so a file
 * with two emitters where only one is safe still fails.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../..");

function listEmitterFiles(): string[] {
  const all = fs.readdirSync(SRC, { recursive: true }) as string[];
  return all
    .filter((p) => p.endsWith(".tsx"))
    .filter((p) => !p.split(path.sep).includes("__tests__") && !/\.(test|spec)\.tsx$/.test(p))
    .map((p) => path.join(SRC, p))
    .filter((abs) => fs.readFileSync(abs, "utf8").includes("application/ld+json"));
}

/** Returns a list of violation messages for one file's source. */
function findJsonLdViolations(src: string, label: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("application/ld+json");
  while (idx !== -1) {
    const rest = src.slice(idx);
    const m = rest.match(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([A-Za-z_$][\w$]*)(\s*\()?/);
    if (!m || m.index! > 600) {
      out.push(`${label}: ld+json emitter without a nearby dangerouslySetInnerHTML __html`);
    } else {
      const [, ident, call] = m;
      const ok = call
        ? ident === "safeJsonLd"
        : new RegExp(`const\\s+${ident}\\s*=\\s*safeJsonLd\\(`).test(src);
      if (!ok) out.push(`${label}: __html is \`${ident}${call ? "(" : ""}\`, not safeJsonLd`);
    }
    idx = src.indexOf("application/ld+json", idx + 1);
  }
  return out;
}

describe("JSON-LD emitters use safeJsonLd (OPE-1360)", () => {
  const files = listEmitterFiles();

  it("finds the known emitters (guard is not vacuous)", () => {
    // 12 seo components + series landing page as of OPE-1360.
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  it("every application/ld+json emitter serialises via safeJsonLd", () => {
    const violations = files.flatMap((f) =>
      findJsonLdViolations(fs.readFileSync(f, "utf8"), path.relative(SRC, f))
    );
    expect(violations).toEqual([]);
  });

  it("the matcher rejects bare JSON.stringify and ad-hoc .replace", () => {
    const bare = `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(x) }} />`;
    const adhoc = `const json = JSON.stringify(s).replace(/</g, "\\\\u003c");
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />`;
    const good = `const html = safeJsonLd(s);
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: html }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(y) }} />`;
    expect(findJsonLdViolations(bare, "bare")).toHaveLength(1);
    expect(findJsonLdViolations(adhoc, "adhoc")).toHaveLength(1);
    expect(findJsonLdViolations(good, "good")).toEqual([]);
  });
});
