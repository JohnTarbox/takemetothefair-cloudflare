#!/usr/bin/env node
// MMATF Event Syndication — receiver self-test.
//
// Sends webhooks BYTE-COMPATIBLE with production (identical body shape + HMAC
// signing) to your callback endpoint, so if your endpoint handles these
// correctly it will handle real MMATF deliveries correctly. No MMATF account or
// prod registration needed.
//
// Requirements: Node 18+ (uses global fetch + node:crypto). No npm install.
//
// Usage:
//   node syndication-consumer-test.mjs <callback-url> <signing-secret>
//
//   - <callback-url>    your POST endpoint, e.g. https://mainecardworks.example/mmatf/webhook
//   - <signing-secret>  any secret you ALSO configure on your endpoint for this test.
//                       (At go-live, MMATF issues the real signing_secret; swap it in then.)
//
// It runs three deliveries that exercise the three things that matter:
//   1. A valid signed webhook         → expect 2xx, your mirror row applied at version 2.
//   2. A tampered signature           → expect 401 (proves you verify the HMAC).
//   3. A stale replay (version 1)     → expect 2xx, but NO change (proves your version gate).
import crypto from "node:crypto";

const [, , url, secret] = process.argv;
if (!url || !secret) {
  console.error("Usage: node syndication-consumer-test.mjs <callback-url> <signing-secret>");
  process.exit(1);
}

// A sample payload in the exact production shape. The test eventId is fake on
// purpose — apply it to your mirror table, eyeball the result, then delete it.
const base = {
  eventId: "test-1111-2222-3333-444455556666",
  eventVersion: 2,
  name: "Gray Wild Blueberry Festival (SYNDICATION TEST)",
  slug: "gray-wild-blueberry-festival",
  startDate: "2026-08-15T00:00:00.000Z",
  endDate: "2026-08-16T00:00:00.000Z",
  venue: {
    name: "Gray Town Common",
    address: "1 Main St",
    city: "Gray",
    state: "ME",
    zip: "04039",
  },
};

const sign = (body) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

async function deliver(label, { version = base.eventVersion, badSignature = false } = {}) {
  const body = JSON.stringify({ ...base, eventVersion: version });
  const signature = badSignature ? "sha256=deadbeefdeadbeef" : sign(body);
  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Syndication-Signature": signature,
        "X-Syndication-Event-Id": base.eventId,
        "X-Syndication-Event-Version": String(version),
      },
      body,
    });
    text = await res.text().catch(() => "");
  } catch (e) {
    console.log(`✗ ${label}: request failed — ${e.message}`);
    return { status: 0 };
  }
  console.log(
    `→ ${label}: HTTP ${res.status}${text ? `  body: ${text.slice(0, 160)}` : ""}`
  );
  return { status: res.status };
}

console.log(`Testing ${url}\n`);

const t1 = await deliver("1. valid signed webhook (version 2)");
const t2 = await deliver("2. tampered signature (expect 401)", { badSignature: true });
const t3 = await deliver("3. stale replay (version 1, expect no-op)", { version: 1 });

const ok = (n, cond) => console.log(`  ${cond ? "✓" : "✗"} check ${n}: ${cond ? "pass" : "REVIEW"}`);
console.log("\nAutomated checks:");
ok("1 (valid → 2xx)", t1.status >= 200 && t1.status < 300);
ok("2 (bad sig → 401)", t2.status === 401);
ok("3 (stale → 2xx, you returned success and ignored it)", t3.status >= 200 && t3.status < 300);

console.log("\nManual checks on YOUR side (the script can't see these):");
console.log("  • After test 1, your mirror row for the test event exists at eventVersion 2, city 'Gray'.");
console.log("  • Test 3 did NOT overwrite — your stored eventVersion is still 2 (version gate held).");
console.log("  • Re-running this whole script changes nothing (every delivery is idempotent).");
console.log("  • Delete the test row (eventId test-1111-2222-3333-444455556666) when done.");
