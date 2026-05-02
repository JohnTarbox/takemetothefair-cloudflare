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
