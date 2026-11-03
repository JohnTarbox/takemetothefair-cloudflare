// OPE-1380 — a nonce-CSP route (src/lib/csp.ts): it must render per request,
// or the HTML carries no nonce and every script on it is blocked. Guarded by
// scripts/check-nonce-csp-routes.ts.
export const dynamic = "force-dynamic";

export default function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
