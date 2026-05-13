// Canonical data for the six New England states the site covers.
// Add a row here when a new state is onboarded — it becomes available to
// getStateName, the "Statewide — X" chip, state filters, and form pickers.

export const STATES = {
  ME: { name: "Maine", slug: "maine", adjective: "Pine Tree State" },
  NH: { name: "New Hampshire", slug: "new-hampshire", adjective: "Granite State" },
  VT: { name: "Vermont", slug: "vermont", adjective: "Green Mountain State" },
  MA: { name: "Massachusetts", slug: "massachusetts", adjective: "Bay State" },
  CT: { name: "Connecticut", slug: "connecticut", adjective: "Constitution State" },
  RI: { name: "Rhode Island", slug: "rhode-island", adjective: "Ocean State" },
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

export function getStateAdjective(code: string | null | undefined): string | null {
  return isStateCode(code) ? STATES[code].adjective : null;
}

export const STATE_BY_SLUG: Record<string, StateCode> = Object.fromEntries(
  STATE_CODES.map((code) => [STATES[code].slug, code])
);
