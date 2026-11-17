/**
 * OPE-1662 — a JSON codec that keeps `Date`s as `Date`s across a KV round-trip.
 *
 * `kvReadThrough` stores `JSON.stringify(value)`, which turns every `Date` into
 * an ISO string. The /blog cache (OPE-1573) got away with that because its rows
 * carry one date and the page re-parses it. A listing row carries many
 * (`startDate`, `endDate`, the venue's and promoter's timestamps, …), and the
 * card code calls `.getTime()` on them. A string there renders "Invalid Date"
 * on a cache HIT only, and a test that only exercises the miss path stays green.
 *
 * So the value is encoded with each `Date` tagged as `{ "$date": <ms> }`, and
 * the decode walk turns the tag back into a `Date`. `cacheRoundTrip` runs the
 * full stringify → parse → decode on the MISS path too, so a hit and a miss
 * return the same shape by construction (an `undefined` property, for example,
 * is dropped on both rather than only on the hit).
 */
const DATE_TAG = "$date";

export function toCacheable(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_TAG]: value.getTime() };
  if (Array.isArray(value)) return value.map(toCacheable);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toCacheable(v);
    }
    return out;
  }
  return value;
}

function isDateTag(value: object): value is { [DATE_TAG]: number | null } {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === DATE_TAG;
}

export function fromCacheable<T>(value: unknown): T {
  return decode(value) as T;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    if (isDateTag(value)) {
      // An Invalid Date encodes as `{ $date: null }` (NaN → null in JSON).
      const ms = value[DATE_TAG];
      return new Date(typeof ms === "number" ? ms : NaN);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decode(v);
    }
    return out;
  }
  return value;
}

/** Encode → JSON text → parse: exactly what a KV hit will hand back to `fromCacheable`. */
export function cacheRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(toCacheable(value)));
}
