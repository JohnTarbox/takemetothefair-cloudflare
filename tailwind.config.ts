import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "../mcw-calendar-grid/dist/**/*.js",
  ],
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
        background: "var(--background)",
        foreground: "var(--foreground)",
        navy: {
          DEFAULT: "#1E2761",
          dark: "#131838",
        },
        royal: "#3B6FD4",
        amber: {
          DEFAULT: "#E8960C",
          light: "#FFF3D6",
          dark: "#B5730A",
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
