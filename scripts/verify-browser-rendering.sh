#!/usr/bin/env bash
# Verify a Cloudflare Browser Rendering token works, by calling the same
# /content REST endpoint the import-url escalation path uses
# (fetchViaBrowserRendering in src/app/api/admin/import-url/fetch/route.ts).
#
# Reads the token from a FILE so it never lands in shell history or the chat
# transcript. This is the same value you put in the CLOUDFLARE_BROWSER_RENDERING_TOKEN
# worker secret, so a pass here means the worker's escalation path will work.
#
# Usage (one-liner — writes token to a temp file, tests, scrubs it):
#   printf '%s' 'PASTE_TOKEN_HERE' > /tmp/brt && bash scripts/verify-browser-rendering.sh /tmp/brt; rm -f /tmp/brt
set -euo pipefail
cd "$(dirname "$0")/.."

TOKENFILE="${1:?usage: verify-browser-rendering.sh <file-containing-the-token>}"
[ -f "$TOKENFILE" ] || { echo "No such file: $TOKENFILE" >&2; exit 1; }
TOKEN="$(tr -d '[:space:]' < "$TOKENFILE")"
[ -n "$TOKEN" ] || { echo "Token file is empty." >&2; exit 1; }

ACCT="e6011e48b7014ef83c77e3c767dac6cf"  # CLOUDFLARE_ACCOUNT_ID (wrangler.toml [vars])
OUT="$(mktemp)"
code="$(curl -s -o "$OUT" -w "%{http_code}" -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${ACCT}/browser-rendering/content" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://example.com"}')"

echo "Browser Rendering /content -> HTTP ${code} (token length=${#TOKEN})"
if [ "$code" = "200" ] && grep -qiE "<html|example domain" "$OUT"; then
  echo "✅ WORKS — rendered HTML returned. The worker's CLOUDFLARE_BROWSER_RENDERING_TOKEN is valid and the URL-import escalation path will function."
else
  echo "❌ FAILED:"
  head -c 400 "$OUT"; echo
  echo "Most likely: the token lacks the 'Browser Rendering' permission, or Browser Rendering isn't enabled on the account."
fi
rm -f "$OUT"
