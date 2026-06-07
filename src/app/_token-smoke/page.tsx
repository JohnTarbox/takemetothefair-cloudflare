/**
 * Design System keystone — token smoke route.
 *
 * Renders every semantic token defined in src/app/globals.css as a
 * labeled swatch + Tailwind utility class. Use during PR 1 review to
 * confirm each token utility resolves correctly in dev + on a CF
 * adapter build, and to eyeball that the documented hex values match
 * what's actually rendered.
 *
 * **Throwaway** — this route exists for PR 1 validation only and is
 * deleted in PR 5 along with the keystone closure. The underscore
 * prefix follows the convention for routes that aren't part of the
 * production information architecture (Next App Router doesn't treat
 * `_` specially, but the naming flags it to readers).
 *
 * Not in sitemap (sitemap is data-driven from entity tables); the
 * `robots` metadata below adds explicit `noindex,nofollow` so any
 * external link to this URL is treated as a dev-tool, not real content.
 */

import type { Metadata } from "next";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Token smoke (PR 1 dev-only)",
  robots: { index: false, follow: false, nocache: true },
};

type Swatch = {
  /** Tailwind class to apply to the chip (e.g. `bg-primary`). */
  className: string;
  /** Token name as it appears in :root (e.g. `--primary`). */
  cssVar: string;
  /** Documented hex value (PR 1 light theme). */
  hex: string;
  /** Short note on intended role. */
  role: string;
};

const SURFACE_LAYER: Swatch[] = [
  {
    className: "bg-background",
    cssVar: "--background",
    hex: "#FAF7F2",
    role: "Page background (cream)",
  },
  { className: "bg-card", cssVar: "--card", hex: "#FFFFFF", role: "Card / popover surface" },
  { className: "bg-muted", cssVar: "--muted", hex: "#F5F1EA", role: "Subtle surface (stone-50)" },
];

const CONTENT_LAYER: Swatch[] = [
  {
    className: "text-foreground bg-background",
    cssVar: "--foreground",
    hex: "#171717",
    role: "Body text (16.0:1 AAA on bg)",
  },
  {
    className: "text-muted-foreground bg-background",
    cssVar: "--muted-foreground",
    hex: "#6F6455",
    role: "Secondary text (5.4:1 AA on bg)",
  },
];

const BORDER_LAYER: Swatch[] = [
  {
    className: "border-4 border-border bg-background",
    cssVar: "--border",
    hex: "#EBE5DA",
    role: "Default UI border (stone-100)",
  },
  {
    className: "border-4 border-input bg-background",
    cssVar: "--input",
    hex: "#EBE5DA",
    role: "Form-field border",
  },
  {
    className: "ring-4 ring-ring bg-background",
    cssVar: "--ring",
    hex: "#3B6FD4",
    role: "Focus ring (royal)",
  },
];

const BRAND_LAYER: Swatch[] = [
  {
    className: "bg-primary text-primary-foreground",
    cssVar: "--primary",
    hex: "#E8960C",
    role: "Brand primary (amber CTA, 9.7:1 AAA)",
  },
  {
    className: "bg-secondary text-secondary-foreground",
    cssVar: "--secondary",
    hex: "#1E2761",
    role: "Brand secondary (navy, 13.6:1 AAA)",
  },
  {
    className: "bg-accent text-accent-foreground",
    cssVar: "--accent",
    hex: "#D97757",
    role: "Brand accent (terracotta)",
  },
];

const STATUS_LAYER: Swatch[] = [
  {
    className: "bg-destructive text-destructive-foreground",
    cssVar: "--destructive",
    hex: "#A13834",
    role: "Destructive action",
  },
];

const CATEGORY_ACCENTS: Swatch[] = [
  {
    className: "bg-accent-gold text-primary-foreground",
    cssVar: "--accent-gold",
    hex: "#E8960C",
    role: "Category: Fair/Agricultural",
  },
  {
    className: "bg-accent-terracotta text-accent-foreground",
    cssVar: "--accent-terracotta",
    hex: "#D97757",
    role: "Category: Festival/Holiday",
  },
  {
    className: "bg-accent-sage text-accent-foreground",
    cssVar: "--accent-sage",
    hex: "#6B7E5E",
    role: "Category: Market/Art Walk",
  },
  {
    className: "bg-accent-navy-soft text-secondary-foreground",
    cssVar: "--accent-navy-soft",
    hex: "#1E2761",
    role: "Category: Trade/Home/Car Show",
  },
  {
    className: "bg-accent-stone text-accent-foreground",
    cssVar: "--accent-stone",
    hex: "#6F6455",
    role: "Category: Craft/Antique/Flea",
  },
];

function SwatchRow({ swatch }: { swatch: Swatch }) {
  return (
    <div className="flex items-center gap-4 py-2 border-b border-border">
      <div
        className={`flex items-center justify-center min-w-[120px] h-12 rounded ${swatch.className}`}
      >
        <code className="text-xs">{swatch.cssVar}</code>
      </div>
      <div className="flex-1 text-sm">
        <div className="font-mono text-foreground">{swatch.className}</div>
        <div className="text-muted-foreground">
          {swatch.hex} — {swatch.role}
        </div>
      </div>
    </div>
  );
}

function Section({ title, swatches }: { title: string; swatches: Swatch[] }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold mb-3 text-foreground">{title}</h2>
      <div>
        {swatches.map((s) => (
          <SwatchRow key={s.cssVar} swatch={s} />
        ))}
      </div>
    </section>
  );
}

export default function TokenSmokePage() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-8 bg-background">
      <h1 className="text-3xl font-bold mb-2 text-foreground">Token smoke</h1>
      <p className="text-sm text-muted-foreground mb-8">
        PR 1 validation route for the Design System keystone. Every swatch below renders using the
        semantic-token utility class shown on the right. If a swatch is unstyled / falls back to a
        Tailwind default, the corresponding <code>theme.extend.colors</code> entry in{" "}
        <code>tailwind.config.ts</code> isn&apos;t resolving the CSS var. This route is deleted in
        PR 5.
      </p>

      <Section title="Surface layer" swatches={SURFACE_LAYER} />
      <Section title="Content layer (text)" swatches={CONTENT_LAYER} />
      <Section title="Border + ring" swatches={BORDER_LAYER} />
      <Section title="Brand" swatches={BRAND_LAYER} />
      <Section title="Status" swatches={STATUS_LAYER} />
      <Section title="Category accents" swatches={CATEGORY_ACCENTS} />
    </main>
  );
}
