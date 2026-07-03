-- OPE-80 (server-side render-error capture, 2026-07-03) — hand-authored per the
-- OPE-21 migration workflow (numbering owned by the orchestrator; deploy applies
-- via `wrangler d1 migrations apply` by filename — no meta snapshot needed).
--
-- Adds two nullable, queryable columns to error_logs so every captured error is
-- diagnosable by ROUTE and joinable on DIGEST across the client + server rows:
--
--   route  → the request/route path the error occurred on (e.g. "/admin/blog").
--            Populated by the new server-render capture (instrumentation
--            onRequestError → captureServerRenderError) from request.path /
--            context.routePath, and by the client-error endpoint from the
--            reported pathname. Previously this only lived inside the context
--            JSON, so it wasn't queryable with a WHERE clause.
--   digest → Next.js error digest. React redacts the real message client-side to
--            an opaque digest; the SERVER row carries the real message + the same
--            digest, so `SELECT ... WHERE digest = ?` joins a user-reported
--            client row to the true server-side error.
--
-- Both NULL on all pre-OPE-80 rows and on any row where the value is unknown.
-- Purely additive. Rollback: no-op (SQLite pre-3.35 can't DROP COLUMN cleanly
-- across all envs; the nullable columns are harmless — older code never reads
-- them).

ALTER TABLE `error_logs` ADD COLUMN `route` text;
ALTER TABLE `error_logs` ADD COLUMN `digest` text;
