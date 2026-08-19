-- OPE-488 — seed the `fault-emitter-run` heartbeat probe.
--
-- Enabled immediately (not dormant): the emitter has been running hourly since
-- OPE-93 wired its cron, and prod already holds 336 `mcp:fault-signatures-emit`
-- rows, so the probe has evidence from the moment it ships and cannot false-RED.
--
-- What it watches, and why THIS signal: the emitter writes one info row per RUN,
-- on a schedule, whether or not it finds a fault. `fault_signatures.last_seen`
-- is event-driven and stays flat during genuinely quiet traffic — probing that
-- would rebuild the false-STALE pattern OPE-295 removed. See the long note in
-- src/lib/heartbeat.ts.
--
-- The gap this closes: on 2026-08-19 the ledger had not advanced in ~50h and two
-- tickets (OPE-488, OPE-485) were filed on the premise that the emitter had
-- stopped. It had not. It ran every hour, exactly on time; the ledger was quiet
-- because ChunkLoadError sits on the curated NOISE_DENYLIST by design. A probe
-- on the RUN answers that question directly instead of leaving it to inference.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'fault-emitter-run',
  unixepoch(),
  'OPE-488 — hourly render-fault emitter run; watches error_logs.timestamp WHERE source=mcp:fault-signatures-emit. Probes the RUN (schedule-driven), never fault_signatures.last_seen (event-driven).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
