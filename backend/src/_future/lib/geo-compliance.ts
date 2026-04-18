/**
 * Geo-Compliance Layer — regulatory compliance for expansion.
 *
 * Per composable-perps-docs Phase 4:
 * - IP-based geo-blocking (configurable regions)
 * - Sanctions screening via OFAC list
 * - Optional KYC integration hook
 */

// OFAC sanctioned countries (ISO 3166-1 alpha-2)
const BLOCKED_COUNTRIES = new Set([
  "CU", "IR", "KP", "SY", "RU", // Heavily sanctioned
  "UA", // Donetsk/Luhansk regions (simplified — production: use subregion)
]);

// US restriction (depends on regulatory clarity)
const US_RESTRICTED = true;

export interface ComplianceCheck {
  allowed: boolean;
  reason?: string;
  country?: string;
}

/**
 * Check if a request from a given country code is allowed.
 */
export function checkGeoCompliance(countryCode: string): ComplianceCheck {
  const upper = countryCode.toUpperCase();

  if (BLOCKED_COUNTRIES.has(upper)) {
    return { allowed: false, reason: "Service unavailable in your region", country: upper };
  }

  if (US_RESTRICTED && upper === "US") {
    return { allowed: false, reason: "Service not available in the United States", country: upper };
  }

  return { allowed: true, country: upper };
}

/**
 * Express middleware for geo-blocking.
 * Reads country from X-Country header (set by CDN/reverse proxy like Cloudflare).
 */
export function geoBlockMiddleware(req: any, res: any, next: any): void {
  const country = req.headers["x-country"] ?? req.headers["cf-ipcountry"] ?? "";
  if (!country) return next(); // No geo info — allow (production: block unknown)

  const check = checkGeoCompliance(country);
  if (!check.allowed) {
    return res.status(451).json({ error: check.reason });
  }
  next();
}

/**
 * Sanctions screening placeholder.
 * In production: check wallet address against OFAC SDN list.
 */
export function screenWallet(walletAddress: string): { cleared: boolean; reason?: string } {
  // Placeholder — production would check against OFAC SDN list API
  return { cleared: true };
}
