/**
 * OPE-906 — env keys the code READS that have no binding behind them.
 *
 * Everything else in `CloudflareEnv` is now GENERATED from the real wrangler
 * config into `cloudflare-env.d.ts` (`npm run cf:typegen`). This file is for the
 * residue: names the code references which `wrangler types` cannot produce
 * because **nothing declares them**.
 *
 * Keeping them here rather than deleting the reference is deliberate. The point
 * of generated types is that the type says what is actually configured; a key
 * that lives only here is visibly *not* configured, which is the opposite of
 * the hand-written files this replaced, where a declaration looked exactly like
 * a binding.
 *
 * ## ALLOW_GOOGLE_PLACES_PHOTOS — declared, never bound
 *
 * Surfaced by deleting the hand-written `src/env.d.ts`: `tsc` produced exactly
 * two errors, both for this key, at
 * `src/app/api/admin/venues/google-backfill/route.ts:44` and `:91`.
 *
 * Measured 2026-09-11, not inferred:
 *   - absent from `[vars]` in `wrangler.toml`
 *   - absent from the DEPLOYED `meetmeatthefair-app` bindings
 *     (`GET /accounts/.../workers/scripts/meetmeatthefair-app/settings`)
 *
 * So `env.ALLOW_GOOGLE_PLACES_PHOTOS` is `undefined` on every request, and the
 * Google Places photo write is off. **Behaviour is correct** — OPE-294 wanted it
 * to ship unset — but the ticket's promise that "the answer is one edit either
 * way" is not true today: there is nowhere to make that edit that the code
 * would read. Flipping it on requires ADDING the var to `wrangler.toml` first.
 *
 * Not done here: adding a binding is explicitly out of scope for OPE-906, and
 * OPE-294's licensing question is John's. Reported on the ticket instead.
 */
// ⚠️ NO top-level import/export in this file, deliberately. That is what keeps
// it a global script so this interface MERGES with the generated
// `CloudflareEnv`. Adding `export {}` makes it a module and the merge silently
// stops happening — which is how this was first written, and tsc said so.
interface CloudflareEnv {
  /**
   * OPE-294 gate. ⚠️ NO BINDING EXISTS — always `undefined` at runtime. See the
   * file comment above before relying on this being flippable.
   */
  ALLOW_GOOGLE_PLACES_PHOTOS?: string;
}
