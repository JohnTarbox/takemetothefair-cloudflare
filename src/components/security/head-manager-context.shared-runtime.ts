/**
 * OPE-1380 — Next's HeadManagerContext, reached the way Next's own client code
 * reaches it. DO NOT rename this file or import it by any other specifier.
 *
 * App-render provides the request's CSP nonce through ONE instance of this
 * context — the one bundled into the app-page runtime. A plain
 * `import … from "next/dist/shared/lib/head-manager-context.shared-runtime"`
 * resolves to a DIFFERENT module instance on the server, so `useContext` reads
 * the default (no nonce) — measured: the root layout's gtag/beacon tags
 * rendered without the nonce and were blocked.
 *
 * Next's server webpack config rewrites any `./<name>.shared-runtime` request
 * to `next/dist/server/route-modules/app-page/vendored/contexts/<name>` for the
 * app layers (webpack-config.js, NormalModuleReplacementPlugin), which is the
 * shared instance — that is how next/script gets the nonce. Importing THIS
 * file as `./head-manager-context.shared-runtime` opts into the same rewrite.
 * In the browser bundle no rewrite happens and this re-export is used; the
 * nonce is undefined there anyway (the browser hides it after parsing).
 *
 * e2e/csp-nonce.spec.ts fails if this stops working.
 */
export { HeadManagerContext } from "next/dist/shared/lib/head-manager-context.shared-runtime";
