-- OPE-1294 — record the response size on every url-health check.
--
-- 55 promoter sites read "0 chars of visible text" from the sweep's Worker; a
-- desktop client found 47 of them live (bot walls / JS-rendered) and 5 genuinely
-- parked (114–1,018 bytes of HTML). Visible characters cannot tell them apart;
-- the raw size probably can, and it was never stored. Nullable: rows written
-- before this, and probes that never reached the origin, have no body.
ALTER TABLE url_health_checks ADD COLUMN body_bytes INTEGER;
