/**
 * OPE-1316 — the message on the import-url extractor's SUCCESS timing row
 * (`error_logs`, level `info`, source `api/admin/import-url/extract`).
 *
 * Shared because two things key on it: the route that writes the row, and the
 * heartbeat probe that reads it. Lives here, not in the route file, because a
 * Next.js route module may export only its verbs and config names.
 */
export const AI_EXTRACTION_OK_MESSAGE = "AI extraction ok";
export const EXTRACT_LOG_SOURCE = "api/admin/import-url/extract";
