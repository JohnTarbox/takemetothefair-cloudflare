#!/usr/bin/env tsx
/**
 * OPE-1380 — guard the per-request nonce CSP routes.
 *
 * The nonce policy (src/lib/csp.ts) only works when three separate pieces of
 * config agree, and each one fails SILENTLY when it drifts:
 *
 *   1. The page renders per request. A statically rendered / ISR page bakes
 *      its HTML once, with no nonce, and `'strict-dynamic'` then blocks every
 *      script on it — a dead page with a green build. So no page or layout
 *      under a protected directory may export `revalidate`,
 *      `generateStaticParams`, or a `dynamic` other than "force-dynamic", and
 *      every page must sit under a layout (or be one) exporting
 *      `dynamic = "force-dynamic"`.
 *   2. Middleware runs on the page (`config.matcher`) and selects the nonce
 *      policy for it (`isNonceCspPath`). A page outside either silently keeps
 *      the public `'unsafe-inline'` policy — or, because of (3), NO policy.
 *   3. next.config.mjs EXCLUDES the page from the public policy, and excludes
 *      exactly the NONCE_CSP_PREFIXES list — an extra entry would leave a page
 *      with no CSP at all, a missing one would send two policies.
 *
 * "Protected directory" is declared HERE, independently of the prefix list,
 * so a new page under one of them (say `(auth)/magic-link`) fails CI until the
 * prefix list, the matcher and next.config are extended to cover it.
 *
 * Usage: npx tsx scripts/check-nonce-csp-routes.ts   (exit 0 clean, 1 offenders)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
// Must precede the next/* import below — see the module header (OPE-1403).
import "./lib/async-local-storage-global";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { createRequire } from "node:module";
import { NONCE_CSP_PREFIXES, isNonceCspPath } from "../src/lib/csp";

// Next's own compiler for a next.config `headers()` source — the function that
// writes the routes-manifest regex OpenNext matches at runtime.
const { buildCustomRoute } = createRequire(import.meta.url)("next/dist/lib/build-custom-route") as {
  buildCustomRoute: (
    type: "header",
    route: { source: string; headers: unknown[] }
  ) => { regex: string };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP = join(ROOT, "src", "app");

/** App directories whose every page must get the nonce policy. */
export const PROTECTED_DIRS = [
  "admin",
  "(auth)",
  "vendor",
  "promoter",
  "suggest-event",
  "dashboard",
  "verify-email",
];

/** Public pages that must KEEP the next.config policy (and not get a nonce). */
const PUBLIC_SAMPLES = [
  "/",
  "/about",
  "/events",
  "/events/some-fair",
  "/vendors",
  "/vendors/some-vendor",
  "/promoters/some-org",
  "/venues/some-venue",
  "/blog/some-post",
  "/vendor-guide",
  "/for-vendors",
  "/submit-event/tok",
];

const SEGMENT_FILES = new Set(["page.tsx", "page.ts", "layout.tsx", "layout.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SEGMENT_FILES.has(name)) out.push(p);
  }
  return out;
}

/** /app/(auth)/reset-password/[token]/page.tsx → /reset-password/x */
export function urlForPage(file: string): string {
  const segs = relative(APP, dirname(file))
    .split(sep)
    .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"))
    .flatMap((s) => {
      if (/^\[\[\.\.\..+\]\]$/.test(s)) return [];
      if (/^\[\.\.\..+\]$/.test(s)) return ["x", "y"];
      if (/^\[.+\]$/.test(s)) return ["x"];
      return [s];
    });
  return "/" + segs.join("/");
}

interface SegmentConfig {
  revalidate: boolean;
  generateStaticParams: boolean;
  dynamic: string | null;
}

/** The segment-config exports a page/layout declares, read from the AST. */
export function segmentConfig(source: string): SegmentConfig {
  const sf = ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: SegmentConfig = { revalidate: false, generateStaticParams: false, dynamic: null };
  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const note = (name: string, init?: ts.Expression) => {
    if (name === "revalidate") out.revalidate = true;
    if (name === "generateStaticParams") out.generateStaticParams = true;
    if (name === "dynamic") {
      out.dynamic = init && ts.isStringLiteralLike(init) ? init.text : "<non-literal>";
    }
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) note(d.name.text, d.initializer);
      }
    } else if (ts.isFunctionDeclaration(st) && isExported(st) && st.name) {
      note(st.name.text);
    } else if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) note(el.name.text);
    }
  }
  return out;
}

/** `config.matcher` string literals from src/middleware.ts, read from the AST. */
export function middlewareMatchers(source: string): string[] {
  const sf = ts.createSourceFile("m.ts", source, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "config") continue;
      if (!d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
      for (const p of d.initializer.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "matcher" &&
          ts.isArrayLiteralExpression(p.initializer)
        ) {
          return p.initializer.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
        }
      }
    }
  }
  return [];
}

/** NONCE_CSP_EXCLUDED_SOURCE from next.config.mjs. */
export function excludedSource(nextConfig: string): string | null {
  return /NONCE_CSP_EXCLUDED_SOURCE\s*=\s*"([^"]+)"/.exec(nextConfig)?.[1] ?? null;
}

export function checkNonceCspRoutes(opts: {
  middlewareSource: string;
  nextConfigSource: string;
  files: { path: string; source: string }[];
}): string[] {
  const problems: string[] = [];
  const matcher = middlewareMatchers(opts.middlewareSource);
  if (matcher.length === 0) problems.push("src/middleware.ts: could not read config.matcher");
  const mwMatches = (url: string) =>
    unstable_doesMiddlewareMatch({
      config: { matcher },
      url: `https://meetmeatthefair.com${url}`,
    });

  const source = excludedSource(opts.nextConfigSource);
  let publicCspApplies: (url: string) => boolean = () => true;
  if (!source) {
    problems.push("next.config.mjs: NONCE_CSP_EXCLUDED_SOURCE not found");
  } else {
    const re = new RegExp(buildCustomRoute("header", { source, headers: [] }).regex);
    publicCspApplies = (url) => re.test(url);
    if (!opts.nextConfigSource.includes("source: NONCE_CSP_EXCLUDED_SOURCE")) {
      problems.push(
        "next.config.mjs: the public CSP rule no longer uses NONCE_CSP_EXCLUDED_SOURCE"
      );
    }
    const listed = /\(\?:([^)]+)\)\(\?:\/\|\$\)/.exec(source)?.[1]?.split("|") ?? [];
    const expected = NONCE_CSP_PREFIXES.map((p) => p.slice(1));
    const extra = listed.filter((p) => !expected.includes(p));
    const missing = expected.filter((p) => !listed.includes(p));
    if (extra.length || missing.length) {
      problems.push(
        `next.config.mjs NONCE_CSP_EXCLUDED_SOURCE drifted from NONCE_CSP_PREFIXES — ` +
          `extra: [${extra.join(", ")}] (those pages get NO CSP), missing: [${missing.join(", ")}] (two CSPs)`
      );
    }
  }

  for (const prefix of NONCE_CSP_PREFIXES) {
    for (const url of [prefix, `${prefix}/x`]) {
      if (!mwMatches(url)) problems.push(`middleware matcher does not run on ${url}`);
      if (publicCspApplies(url)) problems.push(`next.config public CSP still applies to ${url}`);
    }
  }
  for (const url of PUBLIC_SAMPLES) {
    if (isNonceCspPath(url)) problems.push(`public page ${url} selected for the nonce policy`);
    if (!publicCspApplies(url)) problems.push(`public page ${url} lost the next.config CSP`);
  }

  const byPath = new Map(opts.files.map((f) => [f.path, f.source]));
  // A layout's segment config reaches every page below it; a page's reaches
  // only itself — an ANCESTOR's page.tsx says nothing about this page.
  const forceDynamic = (dir: string, names: string[]) =>
    names.some((n) => {
      const src = byPath.get(join(dir, n));
      return src !== undefined && segmentConfig(src).dynamic === "force-dynamic";
    });

  for (const { path, source: src } of opts.files) {
    const rel = relative(ROOT, path);
    const cfg = segmentConfig(src);
    if (cfg.revalidate)
      problems.push(`${rel}: exports \`revalidate\` (a nonce route must not be cached)`);
    if (cfg.generateStaticParams)
      problems.push(`${rel}: exports \`generateStaticParams\` (prerendered HTML carries no nonce)`);
    if (cfg.dynamic !== null && cfg.dynamic !== "force-dynamic")
      problems.push(
        `${rel}: exports dynamic = "${cfg.dynamic}" (must be "force-dynamic" or absent)`
      );

    if (!/\/page\.tsx?$/.test(path)) continue;
    const url = urlForPage(path);
    if (!isNonceCspPath(url))
      problems.push(`${rel}: ${url} is under a protected directory but not in NONCE_CSP_PREFIXES`);
    if (!mwMatches(url)) problems.push(`${rel}: middleware matcher does not run on ${url}`);
    if (publicCspApplies(url))
      problems.push(`${rel}: next.config public CSP still applies to ${url}`);

    let dir = dirname(path);
    let covered = forceDynamic(dir, ["page.tsx", "page.ts"]);
    while (!covered && dir.startsWith(APP)) {
      if (forceDynamic(dir, ["layout.tsx", "layout.ts"])) {
        covered = true;
        break;
      }
      dir = dirname(dir);
    }
    if (!covered) problems.push(`${rel}: no layout above it exports dynamic = "force-dynamic"`);
  }
  return problems;
}

function main() {
  const files: { path: string; source: string }[] = [];
  for (const d of PROTECTED_DIRS) {
    const abs = join(APP, d);
    if (!existsSync(abs)) {
      console.error(`protected directory src/app/${d} does not exist — update PROTECTED_DIRS`);
      process.exit(1);
    }
    for (const p of walk(abs)) files.push({ path: p, source: readFileSync(p, "utf8") });
  }
  const problems = checkNonceCspRoutes({
    middlewareSource: readFileSync(join(ROOT, "src", "middleware.ts"), "utf8"),
    nextConfigSource: readFileSync(join(ROOT, "next.config.mjs"), "utf8"),
    files,
  });
  const pages = files.filter((f) => /\/page\.tsx?$/.test(f.path)).length;
  if (problems.length === 0) {
    console.log(
      `OK ${pages} pages under ${PROTECTED_DIRS.length} protected directories render per request and get the nonce CSP.`
    );
    process.exit(0);
  }
  console.error(`Nonce-CSP route guard (OPE-1380): ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nSee src/lib/csp.ts. A protected page must render per request, be matched by the\n" +
      "middleware, be in NONCE_CSP_PREFIXES, and be excluded from next.config's public CSP."
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
