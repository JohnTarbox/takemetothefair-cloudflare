interface CloudflareEnv {
  DB: D1Database;
  AI: Ai;
  RATE_LIMIT_KV: KVNamespace;
  GOOGLE_MAPS_API_KEY?: string;
  // ENG1.8 — GA4 Measurement Protocol (server-side outbound-click mirror).
  // GA4_MEASUREMENT_ID is the public "G-XXXX" data-stream id; GA4_MP_API_SECRET
  // is a secret minted in GA4 Admin → Data Streams → Measurement Protocol.
  GA4_MEASUREMENT_ID?: string;
  GA4_MP_API_SECRET?: string;
}
