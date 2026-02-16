/**
 * JSON Schema → Zod converter for MCP tool input schemas.
 */
import { z, type ZodType } from "zod";
import { createLogger } from "@openstarry/shared";

const logger = createLogger("mcp-schema");

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  additionalProperties?: boolean;
}

function convert(schema: JsonSchema): ZodType {
  if (!schema || typeof schema !== "object") {
    return z.unknown();
  }

  // Handle const
  if (schema.const !== undefined) {
    return z.literal(schema.const as string | number | boolean);
  }

  // Handle enum
  if (schema.enum && Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return z.unknown();
    if (schema.enum.length === 1) return z.literal(schema.enum[0] as string | number | boolean);
    const [first, second, ...rest] = schema.enum as (string | number | boolean)[];
    return z.enum([String(first), String(second), ...rest.map(String)] as [string, string, ...string[]]);
  }

  // Handle anyOf / oneOf
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf)!;
    if (variants.length === 0) return z.unknown();
    if (variants.length === 1) return convert(variants[0]);
    const [first, second, ...rest] = variants.map(convert);
    return z.union([first, second, ...rest] as [ZodType, ZodType, ...ZodType[]]);
  }

  switch (schema.type) {
    case "string":
      return z.string();

    case "number":
      return z.number();

    case "integer":
      return z.number().int();

    case "boolean":
      return z.boolean();

    case "null":
      return z.null();

    case "array": {
      const itemSchema = schema.items ? convert(schema.items) : z.unknown();
      return z.array(itemSchema);
    }

    case "object": {
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        return z.object({}).passthrough();
      }

      const shape: Record<string, ZodType> = {};
      const requiredSet = new Set(schema.required ?? []);

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const zodProp = convert(propSchema);
        shape[key] = requiredSet.has(key) ? zodProp : zodProp.optional();
      }

      if (schema.additionalProperties === false) {
        return z.object(shape).strict();
      }
      return z.object(shape).passthrough();
    }

    default:
      logger.debug("Unsupported JSON Schema type, falling back to z.unknown()", { type: schema.type });
      return z.unknown();
  }
}

/** Convert a JSON Schema object to a Zod type. */
export function jsonSchemaToZod(schema: Record<string, unknown>): ZodType {
  return convert(schema as unknown as JsonSchema);
}
