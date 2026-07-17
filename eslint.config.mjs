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
            "Use createSlug() from @takemetothefair/utils instead of inline /[^a-z0-9]+/ regex. The slugify library handles & → \"and\", apostrophes, and accented chars; this regex doesn't. See issue #120.",
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
            "Use createSlug() from @takemetothefair/utils instead of inline /[^a-z0-9]+/ regex. The slugify library handles & → \"and\", apostrophes, and accented chars; this regex doesn't. See issue #120.",
        },
        {
          selector:
            "JSXElement[openingElement.name.name=/^(button|a)$/] > JSXElement[openingElement.name.name='svg']",
          message:
            "Use IconButton (state changes) or IconLink (navigation) from @/components/ui/icon-button instead of raw <button><svg/>.",
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
    ignores: [
      ".next/**",
      ".vercel/**",
      ".open-next/**",
      "node_modules/**",
      "packages/**/dist/**",
    ],
  },
];
