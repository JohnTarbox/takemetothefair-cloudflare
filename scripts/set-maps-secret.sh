#!/usr/bin/env bash
# One-shot: upload GOOGLE_MAPS_API_KEY to the prod Worker, reading the value
# straight from .dev.vars so it is never typed/pasted (the paste-wrap bug that
# uploaded it empty during the 2026-06-10 cutover cannot recur from a file read).
# Run from the repo root:  ! bash scripts/set-maps-secret.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Project-scoped Cloudflare token (jtarboxme account) from .env.
CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
export CLOUDFLARE_API_TOKEN

# The known-good key from local dev (.dev.vars feeds `wrangler dev`, which hits
# live Google geocoding, so this is the real working value).
KEYVAL="$(grep -E '^GOOGLE_MAPS_API_KEY=' .dev.vars | head -1 | cut -d= -f2- | tr -d '"'"'"'')"

echo "Uploading GOOGLE_MAPS_API_KEY (length=${#KEYVAL}, prefix=${KEYVAL:0:4}...) to meetmeatthefair-app"
printf '%s' "$KEYVAL" | npx wrangler secret put GOOGLE_MAPS_API_KEY --name meetmeatthefair-app
