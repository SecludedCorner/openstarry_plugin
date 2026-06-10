/**
 * Path traversal prevention for static file serving.
 */

import { resolve, normalize, relative, sep } from "node:path";

/**
 * Validate that a requested path does not escape the document root.
 *
 * @param docRoot - Absolute path to the document root directory
 * @param requestedPath - URL path from the HTTP request
 * @returns Resolved absolute path if safe, or null if traversal detected
 */
export function resolveSafePath(
  docRoot: string,
  requestedPath: string
): string | null {
  // Decode URI-encoded characters (e.g., %2e%2e = ..)
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    return null; // Malformed URI encoding
  }

  // Strip query string and hash
  const pathOnly = decoded.split("?")[0].split("#")[0];

  // Reject null bytes
  if (pathOnly.includes("\0")) {
    return null;
  }

  // Normalize the document root to ensure consistent comparison
  const normalizedDocRoot = resolve(docRoot);

  // Normalize the requested path and resolve against document root
  // Prepend "." to treat the path as relative
  const normalized = normalize(pathOnly);
  const resolved = resolve(normalizedDocRoot, "." + normalized);

  // Ensure the resolved path is within the document root
  if (!resolved.startsWith(normalizedDocRoot + sep) && resolved !== normalizedDocRoot) {
    return null;
  }

  return resolved;
}
