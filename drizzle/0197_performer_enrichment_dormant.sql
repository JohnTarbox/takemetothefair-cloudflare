-- OPE-375 — the performer_enrichment zero, answered.
--
-- The question was whether depth 0 meant "drained and healthy" or "the producer
-- has never run". Established by reading the code and the table, 2026-08-17:
--
--   scheduled selector           NONE.  vendor has select-candidates.ts,
--                                promoter has promoter-select.ts, performer
--                                has neither.
--   queue                        NONE.  wrangler.toml declares vendor-enrichment
--                                and promoter-enrichment; there is no
--                                performer-enrichment queue at all.
--   performer-dispatch.ts        exists, but its ONLY caller is the manual
--                                `enrich_performer` MCP tool.
--   performer_enrichment_candidates   0 rows, in any state, ever.
--   performers                        249.
--
-- So the answer is the plain one the ticket said was acceptable: **the
-- automatic producer was never built.** Performer enrichment is a manual,
-- operator-invoked tool, and nobody has invoked it to completion in production.
--
-- ---------------------------------------------------------------------------
-- Why that needed fixing even though no code was broken
-- ---------------------------------------------------------------------------
--
-- The queue sat in the drain inventory beside vendor_enrichment (+28/day) and
-- promoter_enrichment (+92/day), reporting 0 / 0 / 0 with a NULL drain ratio.
-- Read next to those two, "0" says drained. It actually meant "nothing has ever
-- produced into this". An operator scanning the Monday inventory had no way to
-- tell those apart, and that is the F-02 silence class exactly: absence
-- reported as health.
--
-- Two changes, neither of which pretends a pipeline exists:
--
--   1. The tile label now reads "manual only — no scheduled producer", so the
--      zero carries its own meaning wherever it is displayed.
--   2. This dormant probe row records the finding durably, following the
--      `vendor-self-reported-events` precedent (drizzle/0170): enabled_at NULL,
--      a written reason, and a stated condition for switching it on.
--
-- A probe enabled against a producer that does not exist would page about a
-- feature nobody built, which is the mirror-image mistake and trains people to
-- ignore the digest. Dormant is the honest state.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'performer-enrichment-producer',
  NULL,
  'OPE-375 — DORMANT because the producer does not exist: no scheduled selector and no performer-enrichment queue (2026-08-17; 0 candidates ever against 249 performers). performer-dispatch.ts is reachable only via the manual enrich_performer MCP tool. Set enabled_at if and when a scheduled performer selector ships — until then a zero here is by design, not a fault.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
