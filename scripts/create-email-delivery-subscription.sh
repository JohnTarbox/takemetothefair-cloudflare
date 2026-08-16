#!/usr/bin/env bash
# OPE-177 — create the Cloudflare Email Sending event subscription.
#
# This is the PRODUCER half of delivery-event ingestion, and it is account-level
# configuration rather than code: nothing in this repo creates it, and nothing in
# a deploy recreates it. That is exactly why it is committed here — a queue
# consumer whose producer exists only as a dashboard click someone made once is a
# pipeline nobody can rebuild after an incident.
#
# Publishes six Email Sending lifecycle events (delivered / deferred / bounced /
# failed / rejected / complained) for the meetmeatthefair.com sending domain onto
# the `email-delivery-events` queue, consumed by the MCP Worker
# (mcp-server/src/email-delivery.ts).
#
# Idempotency: this CREATES. Run the list at the bottom first — a second run
# makes a second subscription and every event arrives twice. (Double delivery is
# survivable — the consumer dedups on event_id — but it doubles queue cost for
# nothing.) To remove one:
#   DELETE /accounts/$ACC/event_subscriptions/subscriptions/<id>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

ACC=e6011e48b7014ef83c77e3c767dac6cf
QUEUE_ID=48c382c532c74555bdb9fdd4c0160b1d   # email-delivery-events

ZONE=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=meetmeatthefair.com" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result'][0]['id'])")
echo "zone_id = $ZONE"

curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"name\": \"mmatf-email-delivery\",
    \"enabled\": true,
    \"source\": { \"type\": \"email.sending\", \"zone_id\": \"$ZONE\", \"domain\": \"meetmeatthefair.com\" },
    \"events\": [\"message.delivered\",\"message.deferred\",\"message.bounced\",\"message.failed\",\"message.rejected\",\"message.complained\"],
    \"destination\": { \"type\": \"queues.queue\", \"queue_id\": \"$QUEUE_ID\" }
  }" | python3 -m json.tool

echo
echo "--- current subscriptions ---"
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | python3 -m json.tool
