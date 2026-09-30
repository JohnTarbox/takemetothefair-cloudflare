import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// FlatCompat lets us reuse Next.js's legacy `extends`-based shareable
// configs (eslint-config-next) inside ESLint 9's flat config format.
// Without this adapter, we'd have to wait for Next.js to publish a
// flat-config-native version of eslint-config-next.
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // OPE-902 — type-aware promise rules, scoped to the two directories where a
  // dropped `await` is a security bug rather than a latency bug.
  //
  // The motivating defect: `src/lib/api-auth.ts` did
  //     const ok = timingSafeEqualString(internalKey, expected);
  // without `await`. `ok` was a Promise, so `!ok` was always false and the
  // OPE-258 refusal log never ran ONCE. The function still returned the right
  // answer, because callers awaited what it handed back — so the only symptom
  // was a security log that was silently empty. Nothing in the suite could see
  // it; only a rule that knows `timingSafeEqualString` returns a Promise can.
  //
  // Scoped rather than repo-wide on purpose: these rules need type information
  // (`projectService`), which is slow, and a repo-wide switch-on would bury the
  // signal in pre-existing React/event-handler noise. src/lib and mcp-server/src
  // are where the secrets are compared.
  {
    // OPE-994 — widened from the 5 secret-comparison files. Measured
    // 2026-09-13 over src/lib + src/app/api + mcp-server/src: 35 s wall, 4.1 GB
    // peak RSS — it OOMed only because the default Node heap is ~2 GB. The lint
    // script runs with NODE_OPTIONS=--max-old-space-size=6144 (package.json);
    // the CI runner has 7 GB. It found one real floating promise on arrival
    // (admin events/[id]/vendors trackVendorStatusChange), now awaited.
    // ⚠️ `void x()` is an explicit ignore to this rule, so it does NOT flag the
    // `void logError(...)` shape — review those by hand.
    // ⚠️ OPE-1019 — `.catch(handler)` is ALSO "handled" to no-floating-promises,
    // and no option changes that (checkThenables / ignoreVoid do not). That is
    // how `triggerCorrelation(id).catch(...)` in src/app/api/report-problem sat
    // inside this scope, un-awaited and un-registered, and was never flagged.
    // `local/no-catch-only-promise` below closes that one shape: a statement
    // that is nothing but `x.catch(...)`. It does NOT see `x.then(a, b)` or a
    // promise passed to a function that drops it — review those by hand. An
    // assigned promise (`const work = x.catch(...)`, then `ctx.waitUntil(work)`)
    // is the pattern it steers toward and is not flagged.
    // OPE-1019 — packages/*/src added to BOTH the lint script and this block:
    // `timingSafeEqualString` (the helper OPE-902 exists to await) lives in
    // packages/utils, which was never linted at all.
    // OPE-1105 — src/middleware.ts added: it runs on EVERY request and does
    // fire-and-forget D1 work (correctly inside ctx.waitUntil today), and it
    // matched none of the globs above, so the rule meant for exactly this
    // could not see it. scripts/ and e2e/ are deliberately NOT linted (a
    // recorded decision, OPE-1105): neither runs in a Worker, so the
    // floating-promise class this block exists for cannot reach production
    // from them; scripts are one-shot operator tools and e2e runs under
    // Playwright's own TS pipeline. Revisit if a script becomes a cron.
    files: [
      "src/lib/**/*.ts",
      "src/app/api/**/*.ts",
      "src/middleware.ts",
      "mcp-server/src/**/*.ts",
      "packages/*/src/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      local: {
        rules: {
          "no-catch-only-promise": {
            meta: { type: "problem", schema: [] },
            create: (context) => ({
              "ExpressionStatement > CallExpression[callee.type='MemberExpression'][callee.property.name='catch']":
                (node) =>
                  context.report({
                    node,
                    message:
                      "A promise whose only handling is .catch() still floats: on Workers the runtime may tear it down when the response is sent. Await it, or assign it and register it with ctx.waitUntil (see scheduleRefusalRecord in src/lib/api-auth.ts). OPE-1019.",
                  }),
            }),
          },
        },
      },
    },
    rules: {
      "local/no-catch-only-promise": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // The half that catches the OPE-902 shape: a Promise used where a
        // boolean was meant.
        { checksConditionals: true, checksVoidReturn: false },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // Catch handcrafted "slug from name" regex chains. The exact pattern
      // /[^a-z0-9]+/ produces a different result than canonical createSlug()
      // (the slugify library handles & → "and", apostrophes, accented chars
      // correctly; the regex doesn't). This divergence silently created
      // duplicate venue rows in production — see issue #120.
      //
      // Brand-typed Slug already prevents the bug at storage time (#123/#124),
      // but this lint rule additionally catches the `unsafeSlug(naiveChain(x))`
      // loophole where the cast hides the algorithmic mismatch.
      //
      // Allowlist: `createSlugFromName` in @takemetothefair/utils is the
      // canonical legacy implementation and disables this rule inline.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[regex.pattern='[^a-z0-9]+']",
          message:
            'Use createSlug() from @takemetothefair/utils instead of inline /[^a-z0-9]+/ regex. The slugify library handles & → "and", apostrophes, and accented chars; this regex doesn\'t. See issue #120.',
        },
        // Cohort 5 follow-up (2026-06-01) — flag raw <button><svg/></button>
        // and <a><svg/></a> patterns. Cohort 5 (PR #293) shipped IconButton +
        // IconLink primitives with REQUIRED aria-label via the type system;
        // this rule catches the AST shape where someone hand-rolls a
        // svg-only button outside the primitive. Doesn't catch Lucide-
        // component children (<Trash2/> etc) because those render as
        // JSXElement[openingElement.name.name='Trash2'], not 'svg' — a
        // future enhancement could match by Capital-name convention but
        // would need careful tuning. For now this catches the literal
        // raw-svg case that the email originally flagged.
        {
          selector:
            "JSXElement[openingElement.name.name=/^(button|a)$/] > JSXElement[openingElement.name.name='svg']",
          message:
            "Use IconButton (state changes) or IconLink (navigation) from @/components/ui/icon-button instead of raw <button><svg/> — the primitive enforces aria-label at the type level (WCAG 4.1.2) and a ≥24px hit area (WCAG 2.2 AA 2.5.8).",
        },
        // Design System keystone PR 5 (2026-06-07) — flag raw hex color
        // literals in component/route code. Every brand color and surface
        // tone is defined as a CSS var in src/app/globals.css, exposed as
        // a Tailwind utility via theme.extend.colors. A hex literal in
        // .tsx/.ts code means either (a) bypassing the token layer
        // (silently breaks dark mode), or (b) a defensible escape hatch
        // that should be allowlisted explicitly.
        //
        // Allowlist (overridden in the per-file rules block below):
        //   - src/app/global-error.tsx — renders ABOVE the root layout;
        //     defensive inline styles must survive even if globals.css
        //     fails to load.
        //   - src/app/admin/**/*.tsx — admin dashboards use hex for chart
        //     visualization colors (axes, plot lines) where Tailwind
        //     utilities don't fit the SVG attribute syntax.
        //   - src/lib/newsletter-masthead.ts — email HTML. Mail clients
        //     support neither CSS custom properties nor <style> blocks
        //     (Gmail strips them), so the brand band MUST inline raw hex.
        //     It is deliberately NOT theme-aware: the masthead is the
        //     same green in the inbox and on the web archive (OPE-234).
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message:
            "Raw hex color literals bypass the design system tokens (see src/app/globals.css). Use a Tailwind utility backed by a semantic token (bg-primary / text-foreground / bg-muted / etc.) or, for inline styles, var(--<token>) so dark-mode applies automatically. If this is a defensible escape hatch (chart viz, defensive inline styling above the root layout), file an allowlist override.",
        },
        // OPE-242 (2026-07-17) — FAM-EMPTY-COLLECTION prevention. `arr.reduce(fn)`
        // with NO initial value throws "Reduce of empty array with no initial
        // value" the day `arr` is empty — a state-dependent crash that passes in
        // dev/staging (table has rows) and only fires in prod on a cold-start
        // empty table (OPE-58 was exactly this on /admin/vendor-claim-leaderboard).
        // Pass an initial value (`.reduce(fn, 0)` / `.reduce(fn, {})`), or if the
        // receiver is provably non-empty (literal array, or a length===0 guard
        // above), disable this line with a one-line "// eslint-disable-next-line
        // no-restricted-syntax — empty-safe because …" so the reviewer sees the
        // justification. Highest-risk on server-rendered admin dashboards.
        {
          selector: "CallExpression[callee.property.name='reduce'][arguments.length=1]",
          message:
            "reduce() without an initial value throws on an empty array (FAM-EMPTY-COLLECTION, OPE-242). Pass an initial value, e.g. .reduce(fn, 0). If the array is provably non-empty, add `// eslint-disable-next-line no-restricted-syntax — empty-safe because <reason>`.",
        },
      ],
    },
  },
  // Hex-literal allowlist overrides — these files have legitimate
  // reasons to use raw hex. Disabling the rule via the per-file shape
  // (not eslint-disable-line comments) keeps the allowlist auditable
  // in one place.
  {
    files: ["src/app/global-error.tsx", "src/app/admin/**/*.tsx", "src/lib/newsletter-masthead.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        // Keep the slug-regex + raw-svg-in-button rules; just drop the
        // hex-literal rule. (Inheriting from parent would re-enable it;
        // FlatConfig requires re-specifying the array minus the entry
        // we want to silence.)
        {
          selector: "Literal[regex.pattern='[^a-z0-9]+']",
          message:
            'Use createSlug() from @takemetothefair/utils instead of inline /[^a-z0-9]+/ regex. The slugify library handles & → "and", apostrophes, and accented chars; this regex doesn\'t. See issue #120.',
        },
        {
          selector:
            "JSXElement[openingElement.name.name=/^(button|a)$/] > JSXElement[openingElement.name.name='svg']",
          message:
            "Use IconButton (state changes) or IconLink (navigation) from @/components/ui/icon-button instead of raw <button><svg/>.",
        },
        // OPE-242 — re-declared here (FlatConfig replaces, not merges, the array)
        // so admin dashboards — the HIGHEST-risk empty-collection surface — are
        // still covered by the reduce-without-initial-value guard.
        {
          selector: "CallExpression[callee.property.name='reduce'][arguments.length=1]",
          message:
            "reduce() without an initial value throws on an empty array (FAM-EMPTY-COLLECTION, OPE-242). Pass an initial value, e.g. .reduce(fn, 0). If the array is provably non-empty, add `// eslint-disable-next-line no-restricted-syntax — empty-safe because <reason>`.",
        },
      ],
    },
  },
  {
    files: ["src/lib/logger.ts", "src/lib/scrapers/**/*", "scripts/**/*", "src/test/**/*"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: [".next/**", ".vercel/**", ".open-next/**", "node_modules/**", "packages/**/dist/**"],
  },
];
