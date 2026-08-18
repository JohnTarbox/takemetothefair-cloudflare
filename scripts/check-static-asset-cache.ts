/**
 * OPE-476 — guard that `/_next/static/**` keeps its `immutable` cache header.
 *
 * ## Why this is a source guard and not only a live probe
 *
 * The regression this catches is an edit to `public/_headers`, and that edit is
 * visible in the diff of the PR that makes it. Catching it there costs one
 * file read; catching it in production costs a deploy plus however long until
 * someone looks. `verify-production.ts` also asserts the live header, but that
 * workflow runs weekly and with `continue-on-error: true`, so it reports rather
 * than gates. This is the gate.
 *
 * ## What it actually asserts
 *
 * 1. A rule for the `/_next/static/` prefix exists and sets `immutable` with a
 *    long `max-age`. A short one would technically pass a "header present"
 *    check while restoring the round trip this ticket removed.
 *
 * 2. No BROADER rule sets `Cache-Control`. This is the non-obvious half.
 *    Cloudflare's `_headers` does not resolve conflicts by specificity — a
 *    request matching several rules "inherits all rules' headers", and a header
 *    appearing twice has "the values joined with a comma separator". So a
 *    well-meaning `Cache-Control` on `/*` would not be overridden by the
 *    specific rule; it would be CONCATENATED with it, yielding
 *    `public, max-age=0, must-revalidate, public, max-age=31536000, immutable`.
 *    Browsers take the first `max-age` they parse, so the asset would silently
 *    revert to revalidating on every request — with both rules present in the
 *    file and looking correct to a reader.
 *
 * 3. The long cache is scoped to content-addressed paths only. `/_next/image`
 *    and page HTML are not content-addressed; an `immutable` rule reaching them
 *    would pin stale content in browsers with no way to invalidate it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HEADERS_FILE = join(process.cwd(), "public", "_headers");

/** The prefix whose filenames are content-hashed, so an immutable cache is sound. */
const IMMUTABLE_PREFIX = "/_next/static/";

/** A year. Anything materially shorter re-introduces the revalidation round trip. */
const MIN_MAX_AGE = 31_536_000;

/**
 * Paths that must never receive a long cache, expressed as the rule patterns
 * that would reach them. Not content-addressed: `/_next/image` is keyed by
 * query string over a mutable source, and HTML is the thing that points at the
 * hashed filenames in the first place — pin it and a deploy never lands.
 */
const NEVER_IMMUTABLE = ["/_next/image", "/"];

interface Rule {
  pattern: string;
  headers: Map<string, string>;
  line: number;
}

/**
 * Parse Cloudflare's `_headers` format: a rule line in column 0, its headers
 * indented beneath it, `#` comments and blank lines ignored.
 */
function parseHeadersFile(text: string): Rule[] {
  const rules: Rule[] = [];
  let current: Rule | null = null;

  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.trimStart().startsWith("#")) return;

    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: new Map(), line: i + 1 };
      rules.push(current);
      return;
    }
    if (!current) return; // indented line before any rule — not ours to interpret
    const idx = line.indexOf(":");
    if (idx === -1) return;
    current.headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  });

  return rules;
}

/** Does `pattern` (a `_headers` glob, where `*` spans path separators) match `path`? */
function matches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function main() {
  const rules = parseHeadersFile(readFileSync(HEADERS_FILE, "utf8"));
  const errors: string[] = [];

  // A representative asset. Real shape, so a rule that only matched the
  // directory itself would not satisfy this.
  const sampleAsset = `${IMMUTABLE_PREFIX}chunks/webpack-0123456789abcdef.js`;

  const matching = rules.filter((r) => matches(r.pattern, sampleAsset));
  const withCacheControl = matching.filter((r) => r.headers.has("cache-control"));

  if (withCacheControl.length === 0) {
    errors.push(
      `No rule in public/_headers sets Cache-Control for ${sampleAsset}.\n` +
        `  Workers Static Assets then applies its default, "public, max-age=0, must-revalidate",\n` +
        `  which makes the browser revalidate every content-hashed chunk, stylesheet and font\n` +
        `  on every navigation. Expected a rule:\n` +
        `      ${IMMUTABLE_PREFIX}*\n` +
        `        Cache-Control: public, max-age=${MIN_MAX_AGE}, immutable`
    );
  } else if (withCacheControl.length > 1) {
    // The comma-join trap. Two matching rules do not override; they concatenate.
    errors.push(
      `${withCacheControl.length} rules set Cache-Control for ${sampleAsset}:\n` +
        withCacheControl.map((r) => `      line ${r.line}: ${r.pattern}`).join("\n") +
        `\n  Cloudflare joins duplicate headers from multiple matching rules with a comma\n` +
        `  rather than letting the more specific rule win, so these do not override each\n` +
        `  other — they concatenate, and the browser honours whichever max-age it parses\n` +
        `  first. Keep exactly one Cache-Control rule matching this prefix.`
    );
  } else {
    const value = withCacheControl[0].headers.get("cache-control")!;
    const maxAge = /max-age=(\d+)/.exec(value);
    if (!/\bimmutable\b/.test(value)) {
      errors.push(
        `Cache-Control for ${IMMUTABLE_PREFIX} is "${value}" — missing "immutable".\n` +
          `  Without it browsers still revalidate on reload even inside max-age.`
      );
    }
    if (!maxAge || Number(maxAge[1]) < MIN_MAX_AGE) {
      errors.push(
        `Cache-Control for ${IMMUTABLE_PREFIX} is "${value}" — max-age is below ${MIN_MAX_AGE}.\n` +
          `  Filenames here are content-hashed, so there is no reason to expire them early.`
      );
    }
  }

  // Nothing that is NOT content-addressed may inherit a long cache.
  for (const path of NEVER_IMMUTABLE) {
    for (const rule of rules) {
      if (!matches(rule.pattern, path)) continue;
      const value = rule.headers.get("cache-control");
      if (value && /\bimmutable\b/.test(value)) {
        errors.push(
          `Rule "${rule.pattern}" (line ${rule.line}) applies an immutable Cache-Control to ${path}.\n` +
            `  Only ${IMMUTABLE_PREFIX} is content-addressed. An immutable cache on HTML or\n` +
            `  /_next/image pins stale content in browsers with no way to invalidate it.`
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("Static asset cache guard FAILED (OPE-476):\n");
    for (const e of errors) console.error(`  - ${e}\n`);
    process.exit(1);
  }

  console.log(
    `Static asset cache guard passed — ${IMMUTABLE_PREFIX}* is immutable, ` +
      `and no non-content-addressed path inherits a long cache.`
  );
}

main();
