import { z } from "zod";

// K29 (2026-06-21): callers (the email pipeline) send extracted fields that may
// be an explicit `null` when a signal is absent — e.g. `venueCity: null`. Before
// this fix the schema used `.optional()` only, which accepts `undefined` but
// rejects `null`, so a single null tripped a 400 and the caller silently skipped
// dedup — events that should have merged were accepted as fresh duplicates
// (recurring since >=6/14).
//
// Each field is `.optional().nullable().transform(v => v ?? undefined)`: it
// ACCEPTS null at the boundary, then normalizes null -> undefined so every
// downstream consumer (findDuplicate AND the discrepancy producer) sees a
// null-free `string | undefined`. findDuplicate already treats undefined/null as
// "missing", so the schema was the only thing rejecting it.
//
// Lives in its own module (not exported from route.ts) because Next's generated
// route types reject any non-handler export from a route file.
const optionalNullableString = () =>
  z
    .string()
    .optional()
    .nullable()
    .transform((v) => v ?? undefined);

export const checkDuplicateSchema = z.object({
  sourceUrl: z
    .string()
    .url()
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
  name: optionalNullableString(),
  startDate: optionalNullableString(), // YYYY-MM-DD format
  // Venue signals — resolved server-side inside findDuplicate via autoLinkVenue,
  // then used for the venue_date and city_state_date match stages.
  venueName: optionalNullableString(),
  venueAddress: optionalNullableString(),
  venueCity: optionalNullableString(),
  venueState: optionalNullableString(),
});

export type CheckDuplicateInput = z.infer<typeof checkDuplicateSchema>;
