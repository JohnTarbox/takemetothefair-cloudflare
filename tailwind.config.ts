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
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        navy: "#1E2761",
        royal: "#3B6FD4",
        amber: {
          DEFAULT: "#E8960C",
          light: "#FFF3D6",
        },
        cream: "#FAF7F2",
        "brand-blue": {
          light: "#D6E4F7",
        },
      },
    },
  },
  plugins: [typography],
};
export default config;
