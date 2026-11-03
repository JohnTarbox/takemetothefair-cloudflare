/**
 * OPE-1380 — no `Function("")` eval probe from zod in the browser.
 *
 * zod 4 compiles object parsers with `new Function` when it can, and decides
 * whether it can by TRYING it once: `try { Function(""); return true } catch`.
 * Our CSP has no `'unsafe-eval'` (OPE-909), so that probe is blocked and the
 * browser files a `securitypolicyviolation` — on every page that parses an
 * object schema client-side (/register is the measured one). zod catches the
 * error and falls back, so nothing breaks, but the violation is real noise in
 * exactly the signal OPE-1380's zero-violation check watches.
 *
 * `jitless: true` skips the probe and the JIT, using zod's interpreted path
 * (the one the browser was already falling back to). Imported for its side
 * effect from the root client Providers, so it runs before any form parses.
 * `config()` merges, so this leaves the OPE-1155 locale alone.
 */
import { z } from "zod";

z.config({ jitless: true });

export {};
