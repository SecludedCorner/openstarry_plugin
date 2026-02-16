/**
 * Security utilities for transport-websocket.
 * Token validation, CORS origin checking, and proxy header parsing.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns false immediately if lengths differ (length is not secret).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

export interface AuthConfig {
  enabled: boolean;
  token?: string;
  allowedOrigins?: string[];
  trustedProxies?: string[];
}

/**
 * Validate a token against expected value.
 * Checks query parameter and Authorization header.
 */
export function validateToken(
  authConfig: AuthConfig,
  queryToken: string | undefined,
  authHeader: string | undefined
): boolean {
  if (!authConfig.enabled) return true;

  const expectedToken =
    authConfig.token ?? process.env.OPENSTARRY_WS_TOKEN;

  if (!expectedToken) {
    // Auth enabled but no token configured — reject all
    return false;
  }

  // Check query parameter first
  if (queryToken && constantTimeEqual(queryToken, expectedToken)) {
    return true;
  }

  // Check Authorization header (Bearer token)
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer" && constantTimeEqual(parts[1], expectedToken)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate CORS origin against allowed origins list.
 */
export function validateOrigin(
  allowedOrigins: string[] | undefined,
  origin: string | undefined
): boolean {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return true; // No restriction
  }

  if (!origin) {
    return true; // No origin header (non-browser client)
  }

  return allowedOrigins.includes(origin) || allowedOrigins.includes("*");
}

/**
 * Extract the real client IP from proxy headers.
 */
export function getClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  realIp: string | undefined,
  trustedProxies: string[] | undefined
): string {
  const directIp = remoteAddress ?? "unknown";

  if (!trustedProxies || trustedProxies.length === 0) {
    return directIp;
  }

  // Only trust proxy headers if the direct connection is from a trusted proxy
  if (!trustedProxies.includes(directIp)) {
    return directIp;
  }

  // Prefer X-Real-IP, then first entry in X-Forwarded-For
  if (realIp) {
    return realIp;
  }

  if (forwardedFor) {
    const first = forwardedFor.split(",")[0].trim();
    if (first) return first;
  }

  return directIp;
}

/**
 * Extract token from URL query string.
 */
export function extractQueryToken(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}
