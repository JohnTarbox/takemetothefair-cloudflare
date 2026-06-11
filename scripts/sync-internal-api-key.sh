#!/usr/bin/env bash
# Re-sync INTERNAL_API_KEY across the two workers that share it.
#
# WHY: INTERNAL_API_KEY is the bidirectional shared secret for the
# main-app <-> MCP-worker internal HTTP contract (MCP crons POST to
# /api/admin/* with X-Internal-Key; the main app calls the MCP worker the same
# way). The 2026-06-11 OpenNext cutover left the two workers with MISMATCHED
# values, so every key-dependent call 401s (kpi-recompute cron + any MCP tool
# that proxies to a main-app internal endpoint -> the ~25% DO error rate).
#
# This generates ONE fresh random key and sets the SAME value on BOTH workers.
# The value is generated locally and piped straight into wrangler — it never
# appears on screen, so the paste-wrap-to-empty bug that bit the cutover can't
# recur. Run from the repo root:  ! bash scripts/sync-internal-api-key.sh
#
# Secrets apply on the next request (no redeploy) — the next 10-min cron and all
# MCP tool calls recover immediately. Brief (~seconds) window between the two
# puts where they're mismatched; unavoidable and harmless.
set -euo pipefail
cd "$(dirname "$0")/.."

CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
export CLOUDFLARE_API_TOKEN

KEY="$(openssl rand -hex 32)"
echo "Generated a fresh INTERNAL_API_KEY (length=${#KEY}). Setting the SAME value on both workers..."

echo "-> meetmeatthefair-app (main)"
printf '%s' "$KEY" | npx wrangler secret put INTERNAL_API_KEY --name meetmeatthefair-app

echo "-> meetmeatthefair-mcp (MCP worker)"
printf '%s' "$KEY" | npx wrangler secret put INTERNAL_API_KEY --name meetmeatthefair-mcp

echo "Done — both workers now share the same INTERNAL_API_KEY. The next kpi-recompute cron (≤10 min) and MCP tool calls should stop 401ing."
