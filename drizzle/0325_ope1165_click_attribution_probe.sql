-- OPE-1165 — seed the click-traffic-attribution heartbeat probe, ARMED.
--
-- CLAUDE.md (OPE-246): a writer change ships WITH its probe. Outbound click
-- beacons now carry the tab session's traffic source (trafficMedium), which
-- the Overview conversion rate's organic numerator depends on. The capture is
-- client-side and fail-soft, so the only symptom of it dying is clicks that
-- keep arriving without it.
--
-- DEMAND-CONDITIONAL (demandConditionalEvidence): silence is measured from the
-- newest click, only when no newer click carries a traffic source — so a quiet
-- week reads healthy and it can ship ARMED.
--
-- No-op on an empty database: no foreign keys, ON CONFLICT DO NOTHING.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'click-traffic-attribution',
  unixepoch(),
  'OPE-1165 - outbound_ticket_click / outbound_application_click rows must carry properties.trafficMedium. Demand-conditional: healthy when the newest click is attributed; otherwise silence counts from that click. Window 24h.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
