#!/usr/bin/env bash
# Set GA4_SA_PRIVATE_KEY on the main worker from a Google service-account JSON
# file — WITHOUT the multi-line PEM ever being pasted into a prompt (the manual
# paste mangles the newlines, which is what crashed /admin/analytics on
# 2026-06-11). Extracts the `private_key` field and pipes it straight to
# wrangler. jq -r decodes the JSON's \n escapes to real newlines, which is the
# form importPKCS8 wants (and google-auth.ts's \n-replace is then a safe no-op).
#
# Usage:  ! bash scripts/set-ga4-key.sh /path/to/service-account.json
set -euo pipefail
cd "$(dirname "$0")/.."

JSON="${1:?usage: bash scripts/set-ga4-key.sh <service-account.json>}"
[ -f "$JSON" ] || { echo "No such file: $JSON" >&2; exit 1; }

CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
export CLOUDFLARE_API_TOKEN

jfield() {  # extract a top-level JSON string field, decoded (jq, or node fallback)
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$1" '.[$k] // empty' "$JSON"
  else
    node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j[process.argv[2]]||"")' "$JSON" "$1"
  fi
}

KEY="$(jfield private_key)"
EMAIL="$(jfield client_email)"

case "$KEY" in
  *"BEGIN PRIVATE KEY"*) : ;;  # PKCS#8 — what importPKCS8 expects
  "") echo "No 'private_key' field found in $JSON." >&2; exit 1 ;;
  *) echo "private_key present but doesn't look like a PKCS#8 PEM (no 'BEGIN PRIVATE KEY')." >&2; exit 1 ;;
esac
[ -n "$EMAIL" ] || { echo "No 'client_email' field found in $JSON." >&2; exit 1; }

# Set the matched pair from the SAME JSON so the JWT issuer (client_email) and
# the signing key never drift apart.
echo "Setting GA4_SA_CLIENT_EMAIL ($EMAIL) on meetmeatthefair-app..."
printf '%s' "$EMAIL" | npx wrangler secret put GA4_SA_CLIENT_EMAIL --name meetmeatthefair-app
echo "Setting GA4_SA_PRIVATE_KEY (length=${#KEY}) on meetmeatthefair-app..."
printf '%s' "$KEY" | npx wrangler secret put GA4_SA_PRIVATE_KEY --name meetmeatthefair-app
echo "Done. Re-open /admin/analytics — the GA4 cards should now show real numbers."
