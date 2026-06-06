-- P3a (2026-06-06) — cross-zone expansion plumbing for the venues table.
--
-- Adds 3 columns to `venues` for per-venue timezone / locale / country.
-- Required before any non-Eastern (e.g. Atlantic Canada) venue can render
-- its hours correctly: today the datetime helpers hardcode
-- `VENUE_TZ = "America/New_York"`. Phase 3a is plumbing only — schema +
-- helper API extension — with zero deploy-time behavior change. Phase 3b
-- (deferred to a separate PR) threads the per-venue values through every
-- helper call site so non-Eastern venues actually render correctly.
--
-- Column semantics:
--   timezone — IANA zone string ("America/New_York", "America/Halifax",
--              "America/St_Johns", "America/Regina", "America/Phoenix", …).
--              Drives Intl.DateTimeFormat + the VTIMEZONE_REGISTRY lookup.
--   locale   — BCP 47 locale tag ("en-US", "en-CA", "fr-CA"). Affects month
--              abbreviation, time format (12h vs 24h), and date ordering.
--   country  — ISO 3166-1 alpha-2 ("US", "CA"). Drives JSON-LD
--              addressCountry, hreflang (eventually), and URL routing if
--              the /events/[region] structure widens.
--
-- Backwards-compat: every existing row gets the US defaults in-place via
-- the `NOT NULL DEFAULT` clause. No backfill needed. Public renderer
-- continues to use the helpers' implicit defaults until Phase 3b ships,
-- so deploy is invisible. See date/time audit plan.

ALTER TABLE venues ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/New_York';
ALTER TABLE venues ADD COLUMN locale TEXT NOT NULL DEFAULT 'en-US';
ALTER TABLE venues ADD COLUMN country TEXT NOT NULL DEFAULT 'US';
