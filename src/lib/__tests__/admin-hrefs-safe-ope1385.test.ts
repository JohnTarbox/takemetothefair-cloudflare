/**
 * OPE-1385 — admin surfaces render stored URLs through `safeHref()`.
 *
 * OPE-1368 (#1604) added `safeHref` and routed every PUBLIC render of a stored
 * URL through it, but the admin pages kept rendering raw values: a vendor
 * website, an inbound email's parsed URL, a scraped `source_url`, a schema.org
 * `ticketUrl`, an analytics conversion's client-posted `destinationUrl`. A
 * `javascript:` value there executes in an ADMIN session, which is the worst
 * place for it.
 *
 * Keyed on the ACT, not on a list of field names: every `href={…}` JSX
 * attribute under `src/app/admin` and `src/components/admin` is classified, and
 * anything that is not provably safe must either go through `safeHref(...)` or
 * be a reasoned exemption below WITH ITS OCCURRENCE COUNT — so a new raw
 * `href={row.website}` fails, and so does a second use of an exempted
 * expression (it has to be re-reviewed, not inherited).
 *
 * Provably safe without review:
 *   - a string literal, or a template literal whose leading literal text is a
 *     root path ("/…" but not "//"), a query ("?…"), a fragment ("#…"),
 *     `mailto:` / `tel:`, or a fixed `https://` origin;
 *   - `safeHref(...)`;
 *   - a conditional whose two branches are each safe.
 *
 * Parsed with the TypeScript compiler, not grepped, so a multi-line
 * `href={\n cond ? a : b \n}` is classified like any other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = [join(ROOT, "src", "app", "admin"), join(ROOT, "src", "components", "admin")];

/**
 * `<file>::<expression text>` → how many times it may appear, and why it is
 * safe. Every entry here is a value BUILT BY CODE (an internal route, an
 * internal API path, a data: URL we construct) or one already checked by an
 * equivalent http(s)-only guard — never a stored, user-supplied URL.
 */
const EXEMPT: Record<string, { count: number; why: string }> = {
  "src/app/admin/page.tsx::stat.href": { count: 1, why: "static dashboard tiles, internal routes" },
  "src/app/admin/layout.tsx::item.href": { count: 1, why: "static nav config, internal routes" },
  "src/app/admin/ideas/page.tsx::href": {
    count: 1,
    why: "Chip prop; callers pass /admin/ideas?… literals",
  },
  "src/app/admin/claims/page.tsx::href": {
    count: 1,
    why: "listingHref(entityType, slug) → internal public route",
  },
  "src/app/admin/source-quality/page.tsx::href": {
    count: 1,
    why: "/admin/source-quality?method=… literal",
  },
  "src/app/admin/inbound-emails/page.tsx::src": {
    count: 3,
    why: "/api/admin/inbound-emails/<id>/attachments/<i> built in-render",
  },
  "src/app/admin/inbound-emails/page.tsx::href": {
    count: 1,
    why: "result of the file's safeHttpUrl() (OPE-205 http(s)-only guard)",
  },
  "src/app/admin/inbound-emails/page.tsx::`${WORKFLOWS_DASH}/${row.workflowInstanceId}`": {
    count: 1,
    why: "WORKFLOWS_DASH is a dash.cloudflare.com constant",
  },
  "src/app/admin/inbound-emails/page.tsx::`${src}?dl=1`": {
    count: 1,
    why: "internal attachment path, as above",
  },
  "src/app/admin/coverage/page.tsx::`${detailPath}/${row.slug}`": {
    count: 1,
    why: "detailPath is a fixed public route prefix per entity type",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref("all", filter, sort)': {
    count: 1,
    why: "internal query-string builder",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref("upcoming", filter, sort)': {
    count: 1,
    why: "internal query-string builder",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref(scope, "all", sort)': {
    count: 1,
    why: "internal query-string builder",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref(scope, "uncovered", sort)': {
    count: 1,
    why: "internal query-string builder",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref(scope, "covered", sort)': {
    count: 1,
    why: "internal query-string builder",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref(scope, filter, "coverage")': {
    count: 1,
    why: "internal query-string builder",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref(scope, filter, "views")': {
    count: 1,
    why: "internal query-string builder",
  },
  'src/app/admin/coverage/page.tsx::buildCoverageHref(scope, filter, "favorites")': {
    count: 1,
    why: "internal query-string builder",
  },
  "src/app/admin/analytics/page.tsx::href": {
    count: 4,
    why: "CardLink/StatCard props (internal tab routes), the tab-bar /admin/analytics?tab= literal, and the OPE-1385 safeHref-checked targetUrl",
  },
  "src/app/admin/analytics/page.tsx::entry.href": {
    count: 1,
    why: "action-list rows; KPI_TARGETS internal routes",
  },
  "src/app/admin/analytics/page.tsx::link": {
    count: 1,
    why: "targetLink() → /admin/vendors/<id>/edit, /events/<slug>, /venues/<slug>",
  },
  "src/app/admin/analytics/page.tsx::filterUrl({ limit: n })": {
    count: 1,
    why: "/admin/analytics?tab=indexnow&… via URLSearchParams",
  },
  "src/app/admin/analytics/page.tsx::p.href": {
    count: 1,
    why: "verdict problems; internal routes",
  },
  "src/app/admin/analytics/page.tsx::reading.href": {
    count: 1,
    why: "KPI readings; internal routes",
  },
  "src/app/admin/analytics/page/page.tsx::csvHref": {
    count: 1,
    why: "data:text/csv URL we build from our own rows",
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const SAFE_PREFIX = /^(\/(?!\/)|\?|#|mailto:|tel:|https:\/\/[a-z0-9.-]+\/)/i;

export function isProvablySafe(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return isProvablySafe(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isTemplateExpression(e)) return SAFE_PREFIX.test(e.head.text);
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "safeHref") {
    return true;
  }
  if (ts.isConditionalExpression(e))
    return isProvablySafe(e.whenTrue) && isProvablySafe(e.whenFalse);
  return false;
}

/** Every non-provably-safe `href={expr}` as `<rel>::<expr text>` (one entry per occurrence). */
export function unsafeHrefs(rel: string, src: string): string[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isJsxAttribute(n) &&
      n.name.getText(sf) === "href" &&
      n.initializer &&
      ts.isJsxExpression(n.initializer) &&
      n.initializer.expression &&
      !isProvablySafe(n.initializer.expression)
    ) {
      out.push(`${rel}::${n.initializer.expression.getText(sf).replace(/\s+/g, " ")}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function scan(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      for (const key of unsafeHrefs(rel, readFileSync(file, "utf8"))) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe("OPE-1385 — admin hrefs fed by stored data go through safeHref()", () => {
  const found = scan();

  it("the scan sees the admin tree (not vacuously empty)", () => {
    // The exempt entries are all real occurrences; if the walker broke, these vanish.
    expect(found.get("src/app/admin/layout.tsx::item.href")).toBe(1);
    expect(found.size).toBeGreaterThan(10);
  });

  it("no raw, unreviewed href expression on an admin surface", () => {
    const offenders = [...found.entries()]
      .filter(([key, n]) => EXEMPT[key]?.count !== n)
      .map(
        ([key, n]) => `${key} (×${n}${EXEMPT[key] ? `, exempt for ×${EXEMPT[key].count}` : ""})`
      );
    expect(
      offenders,
      "Route these through safeHref() from @takemetothefair/utils (use { allowRelative: true } " +
        "for values that may be a site path). If the value is built by code and can never hold " +
        "a stored URL, add it to EXEMPT with its count and the reason."
    ).toEqual([]);
  });

  it("every exemption still exists (no stale entries hiding a rename)", () => {
    const stale = Object.keys(EXEMPT).filter((k) => !found.has(k));
    expect(stale).toEqual([]);
  });

  it("classifier: a raw stored-URL href is flagged; safeHref / root-path literals are not", () => {
    const src = [
      "const a = <a href={row.website}>x</a>;",
      "const b = <a href={safeHref(row.website)}>x</a>;",
      "const c = <a href={`/events/${slug}`}>x</a>;",
      "const d = <a href={`//${host}`}>x</a>;",
      'const e = <a href={ok ? "/a" : row.url}>x</a>;',
    ].join("\n");
    expect(unsafeHrefs("f.tsx", src)).toEqual([
      "f.tsx::row.website",
      "f.tsx::`//${host}`",
      'f.tsx::ok ? "/a" : row.url',
    ]);
  });
});
