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
        // ===== Existing brand palette (pre-keystone) — preserved as-is.
        // Subsequent PRs (2-3) will migrate consumers from these names
        // to the semantic tokens above where appropriate, but the brand
        // (amber/navy specifically) stays usable both ways so primary
        // CTAs can keep their visual identity intact across themes.
        navy: {
          DEFAULT: "#1E2761",
          dark: "#131838",
        },
        royal: "#3B6FD4",
        amber: {
          DEFAULT: "#E8960C",
          light: "#FFF3D6",
          dark: "#B5730A",
          // Cohort 6 (analyst, 2026-06-01) — WCAG AA-safe foreground
          // for amber text. amber.DEFAULT (#E8960C) measures 2.39:1
          // on white — below the 4.5:1 floor — so this token splits
          // the role: backgrounds keep DEFAULT (no design change),
          // foreground text uses .fg (≈ 5.7:1 on white, 5.4:1 on
          // cream #FAF7F2). amber.dark (#B5730A → 4.79:1) was the
          // pre-existing escape hatch — keep it for badge/icon use
          // where AA is satisfied. Use .fg for body / label text.
          fg: "#8B5A05",
          // UX-R3 (analyst, 2026-06-01 EVE) — dark text token for
          // text that sits ON an amber surface. amber.dark on
          // amber.light measures ~3.65:1 (below the 4.5:1 AA floor
          // for body text), and amber.dark on amber.DEFAULT collapses
          // entirely (~2.4:1). This near-black achieves AAA on every
          // amber variant we render: ~17:1 on amber.light (#FFF3D6),
          // ~9.7:1 on amber.DEFAULT (#E8960C), ~5.4:1 on amber.dark
          // (#B5730A). Use as `text-amber-bg-fg` everywhere body or
          // label text sits on an amber background — filter chips,
          // pills, badges with amber backdrops. Distinct from .fg
          // (amber text on white) which is the inverse axis.
          "bg-fg": "#1F1A0A",
        },
        cream: "#FAF7F2",
        terracotta: {
          DEFAULT: "#D97757",
          light: "#F5D9CD",
        },
        stone: {
          50: "#F5F1EA",
          100: "#EBE5DA",
          300: "#B8AF9E",
          600: "#6F6455",
          900: "#2A2521",
        },
        sage: {
          50: "#EEF2EA",
          700: "#4A5B3D",
        },
        success: "#2F7D4E",
        warning: "#C47A1F",
        danger: "#A13834",
        "brand-blue": {
          light: "#D6E4F7",
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
