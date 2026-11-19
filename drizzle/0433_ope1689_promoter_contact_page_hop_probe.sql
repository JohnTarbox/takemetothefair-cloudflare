-- OPE-1689 — promoter enrichment now follows ONE same-site Contact link when a
-- promoter's email or phone is still empty after the homepage. OPE-246: the new
-- execution path ships with its probe. `promoter-contact-page-hop`
-- (src/lib/heartbeat.ts) reads candidates whose source_url is not the
-- promoter's own website — only the hop writes those.
-- Armed from the ship date: no flag gates the hop.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'promoter-contact-page-hop',
  unixepoch(),
  'OPE-1689 — the Contact-page hop staged a promoter email/phone in the last 14 days',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
