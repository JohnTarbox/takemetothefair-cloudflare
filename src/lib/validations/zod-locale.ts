/**
 * OPE-1155 — install zod's English error messages explicitly.
 *
 * zod 4 sets its locale as a side effect of `zod/v4/classic/external.js`
 * (`config(en())`). The package declares `"sideEffects": false`, so when the
 * bundler resolves `z` straight through that re-export hub to the modules that
 * define it, the hub's body never runs and no locale is installed. Every
 * DEFAULT message then collapses to zod core's bare fallback, `"Invalid
 * input"` — measured on production 2026-09-25: `{"email":123}` to
 * /api/auth/register answered `"Invalid input"` where local node answers
 * `"Invalid input: expected string, received number"`.
 *
 * Custom messages (`.min(8, "…")`) are unaffected; only rules that rely on the
 * default text lose it. That is how a vendor's rejected website reached the
 * register form as "Invalid input" with no field named.
 *
 * Import this module for its side effect from any server entry point whose
 * zod messages reach a person or a log. Our own package has no
 * `"sideEffects": false`, so the import itself is not tree-shaken.
 */
import { z } from "zod";

z.config(z.locales.en());

export {};
