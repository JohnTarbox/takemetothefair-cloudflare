/**
 * Geographic distance utilities for vendor decision-support features.
 * Uses the Haversine formula for great-circle distance between coordinates.
 */

const EARTH_RADIUS_MILES = 3959;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Calculate distance in miles between two lat/lng coordinate pairs.
 * Returns straight-line (great-circle) distance, not driving distance.
 */
export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Format distance for display. Shows "< 1 mi" for very close, integers for
 * distances under 100, and rounded to nearest 5 for larger distances.
 */
export function formatDistance(miles: number): string {
  if (miles < 1) return "< 1 mi";
  if (miles < 100) return `${Math.round(miles)} mi`;
  return `${Math.round(miles / 5) * 5} mi`;
}
