/**
 * OPE-906 — env keys the code READS that `wrangler types` cannot portably emit.
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

  /**
   * ## Secrets — declared here because generated types cannot carry them
   *
   * These three are real secrets on the deployed Worker (`wrangler secret
   * list`), but they are NOT in `wrangler.toml`. `wrangler types` only sees
   * them when a local, gitignored `.dev.vars` happens to exist — so generating
   * with one present produces a file CI can never reproduce, and the drift
   * check goes red for everyone but the developer who made it.
   *
   * Measured 2026-09-11: with `.dev.vars` present `--check` exits 1 ("out of
   * date"); with it absent, exit 0. The committed types therefore describe the
   * COMMITTED CONFIG only, and these are declared by hand.
   *
   * ⚠️ Run `npm run cf:typegen` with NEITHER `.env` NOR `.dev.vars` present.
   *
   * `wrangler types --check` compares a CONFIG HASH embedded in the generated
   * file's header, and that hash covers the resolved config INCLUDING local env
   * files. Generating with yours present bakes in a hash CI cannot reproduce:
   *
   *     with .env present   header hash ca1c23c3…   CI computes 925bfd5d…  ✘
   *     with both absent    header hash 925bfd5d…   CI computes 925bfd5d…  ✔
   *
   * Consequence worth knowing before you "fix" it: on a developer box that HAS
   * those files, `npm run cf:typecheck` reports "out of date" and that is
   * CORRECT AND EXPECTED. Regenerating to make your local check green is what
   * turns CI red. CI is the authority here, because CI is the only environment
   * every contributor shares.
   */
  GOOGLE_MAPS_API_KEY?: string;
  GA4_MEASUREMENT_ID?: string;
  GA4_MP_API_SECRET?: string;

  /**
   * ## OPE-950 — keys the code read through `as unknown as` casts
   *
   * Removing ~130 env casts meant the keys behind them had to be typed
   * somewhere, and the generated `CloudflareEnv` carries NONE of them: it is
   * built from `wrangler.toml`, and every key below is absent from it.
   *
   * Evidence, measured 2026-09-13 on origin/main (`grep -c <KEY> wrangler.toml`
   * → 0 for every key in both groups; the only hit is a COMMENT at
   * wrangler.toml:45 naming CLOUDFLARE_BROWSER_RENDERING_TOKEN as a secret).
   *
   * ⚠️ Whether each is set as a secret on the deployed `meetmeatthefair-app`
   * is UNVERIFIED here — `wrangler secret list` was out of scope for OPE-950.
   * The groups record what the REPO says, not what production has.
   */

  // ── Group A — named as a Worker SECRET somewhere in the repo ───────────────
  // docs/opennext-cutover-runbook.md:36-39 lists AUTH_SECRET, NEXTAUTH_SECRET,
  // RESEND_API_KEY, INTERNAL_API_KEY, GOOGLE_CLIENT_ID/SECRET,
  // FACEBOOK_CLIENT_ID/SECRET, CLAUDE_READONLY_TOKEN, INDEXNOW_KEY,
  // CLOUDFLARE_BROWSER_RENDERING_TOKEN as `wrangler secret put` on this Worker.
  // scripts/set-ga4-key.sh:40-42 puts GA4_SA_CLIENT_EMAIL/GA4_SA_PRIVATE_KEY;
  // scripts/verify-bing-key.sh:2 calls BING_WEBMASTER_API_KEY a worker secret;
  // .env.example names GA4_PROPERTY_ID.
  AUTH_SECRET?: string;
  NEXTAUTH_SECRET?: string;
  RESEND_API_KEY?: string;
  INTERNAL_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  CLAUDE_READONLY_TOKEN?: string;
  INDEXNOW_KEY?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
  GA4_PROPERTY_ID?: string;
  GA4_SA_CLIENT_EMAIL?: string;
  GA4_SA_PRIVATE_KEY?: string;
  BING_WEBMASTER_API_KEY?: string;

  // ── Group B — FINDING: read by code, named NOWHERE as configured ───────────
  // Absent from wrangler.toml AND from docs/, scripts/, .github/ and
  // .env.example (grep, 2026-09-13). Every read site already tolerates
  // `undefined` (all were optional in the casts they came from); if a key is
  // not set as a secret, that undefined branch is what production runs.
  // Reported on OPE-950 — no binding added.
  /**
   * ⚠️ Bound as a [vars] entry on the MCP Worker (mcp-server/wrangler.toml:64)
   * but NOT on this one — the main app's IndexNow auto-pause alert, CPI
   * stale-red digest, KPI alerts and GSC milestone ingest all read it here.
   */
  ALERT_EMAIL_TECHNICAL?: string;
  ALERT_EMAIL_BUSINESS?: string;
  SLACK_WEBHOOK_URL_TECHNICAL?: string;
  SLACK_WEBHOOK_URL_BUSINESS?: string;
  SC_SITE_URL?: string;
  UNSUBSCRIBE_SECRET?: string;
  NEWSLETTER_APPROVE_SECRET?: string;
  NEWSLETTER_UNSUBSCRIBE_SECRET?: string;
  MCP_SERVER_URL?: string;
  /** docs/mcp-write-invariants.md:193 describes the flag; nothing binds it. */
  EH3_P1_BACKFILL_ENABLED?: string;
  GOODWILL_FLIP_ENABLED?: string;
  SITE_HEALTH_EXPIRE_DAYS?: string;
  NEXT_PUBLIC_SITE_URL?: string;
}
