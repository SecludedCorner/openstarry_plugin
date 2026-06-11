/**
 * Mustache-style variable interpolation engine.
 */

import Mustache from "mustache";
import { VariableInterpolationError } from "../errors.js";

// Disable Mustache's default HTML escaping — workflow data is not HTML.
Mustache.escape = (value: string) => value;

/** Maximum recursion depth for nested object interpolation (SEC-032-003). */
const MAX_INTERPOLATION_DEPTH = 10;

/** Allowed top-level context keys (SEC-032-003). */
const ALLOWED_CONTEXT_KEYS = new Set(["inputs", "steps"]);

/**
 * Sanitize context to only expose allowed top-level keys.
 */
function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of ALLOWED_CONTEXT_KEYS) {
    if (key in context) sanitized[key] = context[key];
  }
  return sanitized;
}

/**
 * Interpolate variables in a value using Mustache templates.
 *
 * @param value - Value to interpolate (string, object, array, or primitive)
 * @param context - Variable context (inputs, steps, etc.)
 * @returns Interpolated value
 * @throws VariableInterpolationError if interpolation fails
 */
export function interpolate(value: unknown, context: Record<string, unknown>): unknown {
  const safeContext = sanitizeContext(context);
  return interpolateInternal(value, safeContext, 0);
}

function interpolateInternal(value: unknown, context: Record<string, unknown>, depth: number): unknown {
  if (depth > MAX_INTERPOLATION_DEPTH) {
    throw new VariableInterpolationError(
      String(value),
      context,
      `Template interpolation depth exceeded (max: ${MAX_INTERPOLATION_DEPTH})`
    );
  }

  if (typeof value === "string") {
    // Only interpolate if string contains Mustache markers
    if (value.includes("{{") && value.includes("}}")) {
      try {
        return Mustache.render(value, context);
      } catch (error) {
        throw new VariableInterpolationError(
          value,
          context,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateInternal(item, context, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateInternal(val, context, depth + 1);
    }
    return result;
  }

  // Primitives (number, boolean, null) — return as-is
  return value;
}
