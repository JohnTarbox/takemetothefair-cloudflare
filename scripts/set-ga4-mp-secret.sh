#!/usr/bin/env bash
# ENG1.8 — set the GA4 Measurement Protocol credentials on the prod Worker,
# reading both values straight from .dev.vars so neither is ever typed/pasted
# (immune to the paste-wrap-to-empty bug that blanked secrets during the
# 2026-06-10 cutover). GA4_MEASUREMENT_ID is the public "G-XXXX" stream id and
# GA4_MP_API_SECRET is the per-stream secret; both are set as wrangler secrets
# (matching set-ga4-key.sh, which also stores the non-sensitive client_email as
# a secret) so wrangler.toml stays free of account-specific values.
#
# Until BOTH are set, the server-side mirror in src/lib/ga4-measurement-protocol.ts
# is inert — the client gtag hit + D1 beacon are unaffected.
#
# Usage (from repo root):  ! bash scripts/set-ga4-mp-secret.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Project-scoped Cloudflare token (jtarboxme account) from .env.
CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
export CLOUDFLARE_API_TOKEN

dvar() {  # read a single-line value from .dev.vars by name
  grep -E "^$1=" .dev.vars | head -1 | cut -d= -f2- | tr -d '"'"'"''
}

MEASUREMENT_ID="$(dvar GA4_MEASUREMENT_ID)"
API_SECRET="$(dvar GA4_MP_API_SECRET)"

[ -n "$MEASUREMENT_ID" ] || { echo "GA4_MEASUREMENT_ID is empty in .dev.vars" >&2; exit 1; }
[ -n "$API_SECRET" ] || { echo "GA4_MP_API_SECRET is empty in .dev.vars" >&2; exit 1; }

case "$MEASUREMENT_ID" in
  G-*) : ;;
  *) echo "GA4_MEASUREMENT_ID doesn't look like a 'G-XXXX' stream id: $MEASUREMENT_ID" >&2; exit 1 ;;
esac

echo "Setting GA4_MEASUREMENT_ID ($MEASUREMENT_ID) on meetmeatthefair-app..."
printf '%s' "$MEASUREMENT_ID" | npx wrangler secret put GA4_MEASUREMENT_ID --name meetmeatthefair-app
echo "Setting GA4_MP_API_SECRET (length=${#API_SECRET}) on meetmeatthefair-app..."
printf '%s' "$API_SECRET" | npx wrangler secret put GA4_MP_API_SECRET --name meetmeatthefair-app
echo "Done. Then mark outbound_application_click + outbound_ticket_click as key"
echo "events in GA4 Admin -> Events, and watch GA4 DebugView for the mirrored hits."
