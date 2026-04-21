// Canonical data for the six New England states the site covers.
// Add a row here when a new state is onboarded — it becomes available to
// getStateName, the "Statewide — X" chip, state filters, and form pickers.

export const STATES = {
  ME: { name: "Maine", slug: "maine" },
  NH: { name: "New Hampshire", slug: "new-hampshire" },
  VT: { name: "Vermont", slug: "vermont" },
  MA: { name: "Massachusetts", slug: "massachusetts" },
  CT: { name: "Connecticut", slug: "connecticut" },
  RI: { name: "Rhode Island", slug: "rhode-island" },
} as const;

export type StateCode = keyof typeof STATES;

export const STATE_CODES = Object.keys(STATES) as StateCode[];

export function isStateCode(code: string | null | undefined): code is StateCode {
  return !!code && code in STATES;
}

export function getStateName(code: string | null | undefined): string | null {
  return isStateCode(code) ? STATES[code].name : null;
}

export function getStateSlug(code: string | null | undefined): string | null {
  return isStateCode(code) ? STATES[code].slug : null;
}
