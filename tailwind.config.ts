import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "../mcw-calendar-grid/dist/**/*.js",
  ],
  // Design System keystone PR 1 (2026-06-07) — switch from default 'media'
  // to 'class' so a manual toggle (next-themes, PR 4) can control dark
  // mode without losing `prefers-color-scheme` honoring. next-themes
  // applies the `.dark` class to <html> and also respects the OS scheme
  // by default via `enableSystem`.
  darkMode: "class",
  theme: {
    extend: {
      keyframes: {
        "slide-up": {
          "0%": { transform: "translateY(100%)" },
          "100%": { transform: "translateY(0)" },
        },
      },
      animation: {
        "slide-up": "slide-up 0.2s ease-out",
      },
      colors: {
        // ===== Design System keystone PR 1 (2026-06-07) — semantic tokens
        //
        // These map to CSS custom properties declared at :root in
        // src/app/globals.css. PR 1 is pure plumbing (zero behavioral
        // change); PR 2 migrates the primitives (Button/Badge/etc.) to
        // these tokens; PR 4 adds dark-theme values under .dark.
        //
        // shadcn/ui naming convention is used because textarea.tsx
        // already references border-input / bg-background /
        // ring-offset-background / text-muted-foreground / ring-ring —
        // wiring those names was the trigger for this PR's existence.
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        card: {
          DEFAULT: "rgb(var(--card) / <alpha-value>)",
          foreground: "rgb(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "rgb(var(--popover) / <alpha-value>)",
          foreground: "rgb(var(--popover-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "rgb(var(--muted) / <alpha-value>)",
          foreground: "rgb(var(--muted-foreground) / <alpha-value>)",
        },
        border: "rgb(var(--border) / <alpha-value>)",
        input: "rgb(var(--input) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",
        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          foreground: "rgb(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "rgb(var(--secondary) / <alpha-value>)",
          foreground: "rgb(var(--secondary-foreground) / <alpha-value>)",
        },
        footer: {
          DEFAULT: "rgb(var(--footer) / <alpha-value>)",
          foreground: "rgb(var(--footer-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          foreground: "rgb(var(--accent-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "rgb(var(--destructive) / <alpha-value>)",
          foreground: "rgb(var(--destructive-foreground) / <alpha-value>)",
        },
        // Status SOFT variants — PR 2 extension. Used by Badge variants
        // for pill-shaped status indicators (success/warning/danger/info).
        // Distinct from solid status colors (--success/--warning/--danger
        // are still available as `bg-success` etc. for icons + accents).
        "success-soft": {
          DEFAULT: "rgb(var(--success-soft) / <alpha-value>)",
          foreground: "rgb(var(--success-soft-foreground) / <alpha-value>)",
        },
        "warning-soft": {
          DEFAULT: "rgb(var(--warning-soft) / <alpha-value>)",
          foreground: "rgb(var(--warning-soft-foreground) / <alpha-value>)",
        },
        "danger-soft": {
          DEFAULT: "rgb(var(--danger-soft) / <alpha-value>)",
          foreground: "rgb(var(--danger-soft-foreground) / <alpha-value>)",
        },
        "info-soft": {
          DEFAULT: "rgb(var(--info-soft) / <alpha-value>)",
          foreground: "rgb(var(--info-soft-foreground) / <alpha-value>)",
        },
        // Category accent palette (PR 2 migration target for
        // src/lib/category-colors.ts). Exposed as `bg-accent-gold`,
        // `text-accent-sage`, etc.
        "accent-gold": "rgb(var(--accent-gold) / <alpha-value>)",
        "accent-terracotta": "rgb(var(--accent-terracotta) / <alpha-value>)",
        "accent-sage": "rgb(var(--accent-sage) / <alpha-value>)",
        "accent-navy-soft": "rgb(var(--accent-navy-soft) / <alpha-value>)",
        "accent-stone": "rgb(var(--accent-stone) / <alpha-value>)",
        // ===== Brand palette — CSS-var-backed (keystone follow-up, 2026-06-07)
        //
        // Originally these were hardcoded hex literals (light-only). Per the
        // MMATF-UIUX-DarkMode-Punchlist-2026-06.md punch-list, that caused
        // every `text-navy`, `text-amber-fg`, `text-royal`, `bg-amber-light`
        // call across 60+ files to NOT theme — logo invisible at 1.16:1,
        // date badges at 2.73:1, etc. Brand tokens now reference CSS vars
        // declared in globals.css with light + dark values (see :root and
        // .dark there), so every existing consumer themes automatically
        // without a per-callsite migration sweep.
        //
        // WCAG contrast notes (Cohort 6 / UX-R3 / Cohort 6 EVE 2026-06-01)
        // are preserved at the CSS-var declaration site in globals.css.
        navy: {
          DEFAULT: "rgb(var(--navy) / <alpha-value>)",
          dark: "rgb(var(--navy-dark) / <alpha-value>)",
        },
        royal: "rgb(var(--royal) / <alpha-value>)",
        amber: {
          DEFAULT: "rgb(var(--amber) / <alpha-value>)",
          light: "rgb(var(--amber-light) / <alpha-value>)",
          dark: "rgb(var(--amber-dark) / <alpha-value>)",
          fg: "rgb(var(--amber-fg) / <alpha-value>)",
          "bg-fg": "rgb(var(--amber-bg-fg) / <alpha-value>)",
        },
        cream: "rgb(var(--cream) / <alpha-value>)",
        terracotta: {
          DEFAULT: "rgb(var(--terracotta) / <alpha-value>)",
          fg: "rgb(var(--terracotta-fg) / <alpha-value>)",
          light: "rgb(var(--terracotta-light) / <alpha-value>)",
        },
        stone: {
          50: "rgb(var(--stone-50) / <alpha-value>)",
          100: "rgb(var(--stone-100) / <alpha-value>)",
          300: "rgb(var(--stone-300) / <alpha-value>)",
          600: "rgb(var(--stone-600) / <alpha-value>)",
          900: "rgb(var(--stone-900) / <alpha-value>)",
        },
        sage: {
          50: "rgb(var(--sage-50) / <alpha-value>)",
          700: "rgb(var(--sage-700) / <alpha-value>)",
        },
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        "brand-blue": {
          light: "rgb(var(--brand-blue-light) / <alpha-value>)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "Times New Roman", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      fontSize: {
        "display-xl": ["4.5rem", { lineHeight: "4.75rem", letterSpacing: "-0.015em" }],
        "display-lg": ["3.5rem", { lineHeight: "3.75rem", letterSpacing: "-0.01em" }],
        "display-md": ["2.5rem", { lineHeight: "3rem" }],
        "heading-lg": ["2rem", { lineHeight: "2.5rem" }],
        "heading-md": ["1.5rem", { lineHeight: "2rem" }],
        "heading-sm": ["1.25rem", { lineHeight: "1.75rem" }],
      },
    },
  },
  plugins: [typography],
};
export default config;
