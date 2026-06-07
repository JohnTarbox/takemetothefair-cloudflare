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
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        // Status SOFT variants — PR 2 extension. Used by Badge variants
        // for pill-shaped status indicators (success/warning/danger/info).
        // Distinct from solid status colors (--success/--warning/--danger
        // are still available as `bg-success` etc. for icons + accents).
        "success-soft": {
          DEFAULT: "var(--success-soft)",
          foreground: "var(--success-soft-foreground)",
        },
        "warning-soft": {
          DEFAULT: "var(--warning-soft)",
          foreground: "var(--warning-soft-foreground)",
        },
        "danger-soft": {
          DEFAULT: "var(--danger-soft)",
          foreground: "var(--danger-soft-foreground)",
        },
        "info-soft": {
          DEFAULT: "var(--info-soft)",
          foreground: "var(--info-soft-foreground)",
        },
        // Category accent palette (PR 2 migration target for
        // src/lib/category-colors.ts). Exposed as `bg-accent-gold`,
        // `text-accent-sage`, etc.
        "accent-gold": "var(--accent-gold)",
        "accent-terracotta": "var(--accent-terracotta)",
        "accent-sage": "var(--accent-sage)",
        "accent-navy-soft": "var(--accent-navy-soft)",
        "accent-stone": "var(--accent-stone)",
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
          DEFAULT: "var(--navy)",
          dark: "var(--navy-dark)",
        },
        royal: "var(--royal)",
        amber: {
          DEFAULT: "var(--amber)",
          light: "var(--amber-light)",
          dark: "var(--amber-dark)",
          fg: "var(--amber-fg)",
          "bg-fg": "var(--amber-bg-fg)",
        },
        cream: "var(--cream)",
        terracotta: {
          DEFAULT: "var(--terracotta)",
          light: "var(--terracotta-light)",
        },
        stone: {
          50: "var(--stone-50)",
          100: "var(--stone-100)",
          300: "var(--stone-300)",
          600: "var(--stone-600)",
          900: "var(--stone-900)",
        },
        sage: {
          50: "var(--sage-50)",
          700: "var(--sage-700)",
        },
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",
        "brand-blue": {
          light: "var(--brand-blue-light)",
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
