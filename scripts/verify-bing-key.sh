#!/usr/bin/env bash
# Verify the Bing Webmaster API key (the BING_WEBMASTER_API_KEY worker secret) by
# calling GetUserSites — the lightest read, which validates the key itself and
# returns the sites the key can access, independent of which site is verified.
#
# Reads the key from a FILE so it never lands in shell history / the transcript.
# A pass means the worker secret is valid and the Bing tools + bing-sweep cron
# will function (assuming meetmeatthefair.com is verified on the account — the
# script reports that too).
#
# Usage:  bash scripts/verify-bing-key.sh <file-containing-the-key>
set -euo pipefail
cd "$(dirname "$0")/.."

KEYFILE="${1:?usage: verify-bing-key.sh <file-containing-the-key>}"
[ -f "$KEYFILE" ] || { echo "No such file: $KEYFILE" >&2; exit 1; }
KEY="$(tr -d '[:space:]' < "$KEYFILE")"
[ -n "$KEY" ] || { echo "Key file is empty." >&2; exit 1; }

OUT="$(mktemp)"
code="$(curl -s -o "$OUT" -w "%{http_code}" \
  "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${KEY}")"

echo "Bing GetUserSites -> HTTP ${code} (key length=${#KEY})"
if [ "$code" = "200" ] && ! grep -qiE '"ErrorCode"|InvalidApiKey|fault' "$OUT"; then
  echo "✅ WORKS — Bing accepted the key."
  if grep -qi "meetmeatthefair" "$OUT"; then
    echo "   meetmeatthefair.com IS verified on this account — Bing tools + the sweep will return data."
  else
    echo "   ⚠ Key valid, but meetmeatthefair.com is NOT among the returned sites —"
    echo "     add + verify the site in Bing Webmaster Tools so the queries return data."
  fi
else
  echo "❌ FAILED:"
  head -c 400 "$OUT"; echo
  echo "Likely: invalid/expired key, or API access not enabled (Bing Webmaster → Settings → API Access)."
fi
rm -f "$OUT"
