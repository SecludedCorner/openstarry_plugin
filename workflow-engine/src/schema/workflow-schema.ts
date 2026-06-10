/**
 * Zod schema for workflow YAML validation.
 */

import { z } from "zod";

/**
 * Input parameter schema.
 */
const InputSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

/**
 * Base step schema.
 */
const BaseStepSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Step name must be alphanumeric with dash/underscore"),
  output: z.string().optional(),
});

/**
 * Tool step schema.
 */
const ToolStepSchema = BaseStepSchema.extend({
  type: z.literal("tool"),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()),
});

/**
 * Service step schema.
 */
const ServiceStepSchema = BaseStepSchema.extend({
  type: z.literal("service"),
  service: z.string().min(1),
  method: z.string().min(1),
  arguments: z.array(z.unknown()),
});

/**
 * LLM step schema.
 */
const LLMStepSchema = BaseStepSchema.extend({
  type: z.literal("llm"),
  provider: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

/**
 * Command step schema (NOT SUPPORTED in MVP, but schema defined for future).
 */
const CommandStepSchema = BaseStepSchema.extend({
  type: z.literal("command"),
  command: z.string().min(1),
  args: z.string(),
});

/**
 * Inference step schema.
 */
const InferenceStepSchema = BaseStepSchema.extend({
  type: z.literal("inference"),
  provider: z.string().min(1),
  model: z.string().optional(),
  input: z.object({
    type: z.enum(["image", "tensor", "text", "raw"]),
  }).passthrough(),
  options: z.record(z.unknown()).optional(),
});

/**
 * Discriminated union of all step types.
 */
const StepSchema = z.discriminatedUnion("type", [
  ToolStepSchema,
  ServiceStepSchema,
  LLMStepSchema,
  CommandStepSchema,
  InferenceStepSchema,
]);

/**
 * Complete workflow definition schema.
 */
export const WorkflowSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver format"),
  description: z.string().optional(),
  inputs: z.record(InputSchema),
  steps: z.array(StepSchema).min(1, "Workflow must have at least one step"),
  outputs: z.record(z.string()), // Values are Mustache templates
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Type inference from Zod schema (should match IWorkflowDefinition).
 */
export type WorkflowSchemaType = z.infer<typeof WorkflowSchema>;
