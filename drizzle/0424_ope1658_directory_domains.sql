-- OPE-1658 (John, 2026-11-16) — keep third-party directory pages out of the
-- event page's "Official Event Website" fallback button. The button shows
-- `source_url` only when it passes gateUrlOnce(…, "ticket") against this table
-- (src/app/events/[slug]/page.tsx), so classifying a domain with
-- use_as_ticket_url = 0 removes the button for events whose only source is
-- that domain (the page then shows no fallback, not a directory link).
--
-- House "aggregator" shape (9 existing rows): ticket 0, application 0,
-- source 1 — we may still ingest from them, never link to them as the
-- official site. A brand-new row MUST set use_as_source = 1 explicitly: the
-- column defaults to 0, which would silently block ingestion.
--
-- Chosen by the ticket's test — does the domain belong to the event's own
-- promoter or venue? (prod D1, 2026-11-17 ~00:25Z):
--   mafa.org — Massachusetts Agricultural Fairs Association's statewide
--     fair list; used as the "official site" for 26 different fairs, each
--     with its own promoter and (often) its own site.
--   happeningnext.com — an event-listing site; its Waterville page served
--     4 unrelated events (Community Suggestions / Connors).
-- NOT excluded, though the ticket named it: newenglandcraftfairs.com is the
-- promoter New England Craft Fairs' own site (promoters.website), carries all
-- 10 of its events, and is already classified promoter / 1,1,1.
--
-- ON CONFLICT DO NOTHING: neither domain has a row today; a row someone
-- adds before this applies is a human decision and is not overwritten.
-- Touches one FK-less table, so it is a no-op-safe insert on an empty db.
INSERT INTO url_domain_classifications
  (id, domain, domain_type, use_as_ticket_url, use_as_application_url, use_as_source, notes, created_at, updated_at, created_by)
VALUES
  ('udc-ope1658-mafa', 'mafa.org', 'aggregator', 0, 0, 1,
   'OPE-1658: statewide fair directory (MAFA) — not the official site of any one fair.',
   unixepoch(), unixepoch(), 'OPE-1658'),
  ('udc-ope1658-happeningnext', 'happeningnext.com', 'aggregator', 0, 0, 1,
   'OPE-1658: event-listing site — not an organizer page.',
   unixepoch(), unixepoch(), 'OPE-1658')
ON CONFLICT(domain) DO NOTHING;
