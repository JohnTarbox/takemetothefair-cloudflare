"use client";

/**
 * OPE-1380 — the per-request CSP nonce, for scripts WE render.
 *
 * Next.js puts the nonce on its own scripts by reading the CSP request header
 * middleware forwards (src/lib/csp.ts). Raw <script> tags in our JSX are not
 * covered, and on a nonce route a nonce-less inline or parser-inserted script
 * is BLOCKED (`'strict-dynamic'`, no `'unsafe-inline'`).
 *
 * The root layout cannot call `headers()` to get it: a dynamic API in the root
 * layout makes every page dynamic, ending ISR for the public site. Instead this
 * reads the nonce Next.js already parsed, from the same context `next/script`
 * reads (next/dist/client/script.js → `useContext(HeadManagerContext).nonce`),
 * via ./head-manager-context.shared-runtime (read it before touching the import).
 * App-render provides it during SSR; it is undefined on cached/ISR pages (no
 * CSP request header → no attribute, exactly the pre-OPE-1380 markup) and on
 * the client, where the browser hides the attribute anyway — hence
 * `suppressHydrationWarning`, the same thing next/script and next-themes do.
 */
import { useContext, type ScriptHTMLAttributes } from "react";
// Relative `./…shared-runtime` specifier on purpose — see that file.
import { HeadManagerContext } from "./head-manager-context.shared-runtime";

export function useCspNonce(): string | undefined {
  return useContext(HeadManagerContext)?.nonce;
}

/** A plain <script> that carries the request's CSP nonce when there is one. */
export function NonceScript(props: ScriptHTMLAttributes<HTMLScriptElement>) {
  const nonce = useCspNonce();
  return <script {...props} nonce={nonce} suppressHydrationWarning />;
}
