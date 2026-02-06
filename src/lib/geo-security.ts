/**
 * Geo-security utilities for restricting access based on Cloudflare headers.
 * Uses CF-IPCountry header provided by Cloudflare to determine the request's origin country.
 */

export interface GeoRestrictionConfig {
  /** List of allowed country codes (ISO 3166-1 alpha-2). If not provided, all countries are allowed. */
  allowedCountries?: string[];
  /** List of blocked country codes (ISO 3166-1 alpha-2). Takes precedence over allowedCountries. */
  blockedCountries?: string[];
}

export interface GeoCheckResult {
  /** Whether the request is allowed based on geo restrictions */
  allowed: boolean;
  /** The country code from the request (null if not provided by Cloudflare) */
  country: string | null;
  /** Reason for blocking (if blocked) */
  reason?: string;
}

/**
 * Default allowed countries for admin operations.
 * US and CA where the service primarily operates.
 */
export const ADMIN_ALLOWED_COUNTRIES = ["US", "CA"];

/**
 * Check if a request passes geo-restrictions.
 *
 * @param request - The incoming request with Cloudflare headers
 * @param config - Geo-restriction configuration
 * @returns GeoCheckResult indicating whether the request is allowed
 *
 * @example
 * ```typescript
 * const result = checkGeoRestriction(request, { allowedCountries: ["US", "CA"] });
 * if (!result.allowed) {
 *   return NextResponse.json({ error: "Access denied from your location" }, { status: 403 });
 * }
 * ```
 */
export function checkGeoRestriction(
  request: Request,
  config: GeoRestrictionConfig
): GeoCheckResult {
  const country = request.headers.get("CF-IPCountry");

  // If no country header is present (local dev or non-Cloudflare), allow by default
  if (!country) {
    return { allowed: true, country: null };
  }

  // Check blocked countries first (takes precedence)
  if (config.blockedCountries && config.blockedCountries.includes(country)) {
    return {
      allowed: false,
      country,
      reason: `Access blocked from ${country}`,
    };
  }

  // Check allowed countries
  if (config.allowedCountries && !config.allowedCountries.includes(country)) {
    return {
      allowed: false,
      country,
      reason: `Access not allowed from ${country}`,
    };
  }

  return { allowed: true, country };
}

/**
 * Check if a request is from an allowed admin country.
 * Convenience function that uses ADMIN_ALLOWED_COUNTRIES.
 *
 * @param request - The incoming request
 * @returns GeoCheckResult indicating whether admin access is allowed
 */
export function checkAdminGeoRestriction(request: Request): GeoCheckResult {
  return checkGeoRestriction(request, { allowedCountries: ADMIN_ALLOWED_COUNTRIES });
}

/**
 * Get the client's country code from Cloudflare headers.
 *
 * @param request - The incoming request
 * @returns The country code or null if not available
 */
export function getClientCountry(request: Request): string | null {
  return request.headers.get("CF-IPCountry");
}

/**
 * Get the client's ASN (Autonomous System Number) from Cloudflare headers.
 * Useful for blocking cloud provider IPs.
 *
 * @param request - The incoming request
 * @returns The ASN or null if not available
 */
export function getClientAsn(request: Request): string | null {
  return request.headers.get("CF-IPAsnNum");
}

/**
 * Common cloud provider ASNs to block on sensitive endpoints.
 * These are typically used by bots, scrapers, and automated attacks.
 */
export const CLOUD_PROVIDER_ASNS = [
  "14061", // DigitalOcean
  "16509", // Amazon AWS
  "15169", // Google Cloud
  "8075",  // Microsoft Azure
  "13335", // Cloudflare (itself)
  "20473", // Vultr
  "63949", // Linode
  "20940", // Akamai
];

/**
 * Check if request is from a known cloud provider.
 *
 * @param request - The incoming request
 * @returns True if the request appears to be from a cloud provider
 */
export function isFromCloudProvider(request: Request): boolean {
  const asn = getClientAsn(request);
  if (!asn) return false;
  return CLOUD_PROVIDER_ASNS.includes(asn);
}
