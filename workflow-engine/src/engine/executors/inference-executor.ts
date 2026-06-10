/**
 * Inference step executor — invokes IInferenceProvider.infer() directly.
 */

import { z } from "zod";
import type { IPluginContext, InferenceRequest, InferenceInput } from "@openstarry/sdk";
import { isInferenceProvider } from "@openstarry/sdk";
import type { IInferenceStep } from "../../types/workflow.js";
import { WorkflowExecutionError } from "../../errors.js";
import { interpolate } from "../interpolate.js";

/** Runtime validation schema for interpolated inference input. */
const InferenceInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.unknown(), mimeType: z.string().optional() }),
  z.object({ type: z.literal("tensor"), shape: z.array(z.number()), data: z.array(z.number()) }),
  z.object({ type: z.literal("raw"), data: z.unknown() }),
]);

/**
 * Execute an inference step.
 *
 * @param step - Inference step definition
 * @param context - Execution context with interpolated variables
 * @param pluginCtx - Plugin context
 * @param executionId - Current execution ID
 * @returns InferenceResult
 */
export async function executeInferenceStep(
  step: IInferenceStep,
  context: Record<string, unknown>,
  pluginCtx: IPluginContext,
  executionId: string
): Promise<unknown> {
  // 1. Resolve provider
  const provider = pluginCtx.providers?.get(step.provider);
  if (!provider) {
    const available = pluginCtx.providers?.list().map((p) => p.id) || [];
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Provider "${step.provider}" not found. Available: ${available.join(", ") || "none"}`,
      step.name
    );
  }

  // 2. Type-check: must be IInferenceProvider
  if (!isInferenceProvider(provider)) {
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Provider "${step.provider}" does not support inference (missing infer() method). Use an "llm" step for LLM providers.`,
      step.name
    );
  }

  // 3. Interpolate input fields + runtime validation (SEC-032-001)
  const interpolatedInput = interpolate(step.input, context) as Record<string, unknown>;
  const parsed = InferenceInputSchema.safeParse(interpolatedInput);
  if (!parsed.success) {
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Invalid inference input: ${parsed.error.message}`,
      step.name
    );
  }
  const input = buildInferenceInput(parsed.data as Record<string, unknown>);

  // 4. Build request
  const request: InferenceRequest = {
    model: step.model || provider.models?.[0]?.id || "default",
    input,
    ...(step.options && {
      options: interpolate(step.options, context) as Record<string, unknown>,
    }),
  };

  // 5. Execute inference
  try {
    const result = await provider.infer(request);
    return result;
  } catch (error) {
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Inference provider failed: ${error instanceof Error ? error.message : String(error)}`,
      step.name,
      error
    );
  }
}

/**
 * Build typed InferenceInput from interpolated raw object.
 */
function buildInferenceInput(raw: Record<string, unknown>): InferenceInput {
  const type = raw.type as string;
  switch (type) {
    case "text":
      return { type: "text", text: raw.text as string };
    case "image":
      return {
        type: "image",
        data: raw.data as Uint8Array,
        mimeType: (raw.mimeType as string) || "image/png",
      };
    case "tensor":
      return {
        type: "tensor",
        shape: raw.shape as number[],
        data: raw.data as number[],
      };
    case "raw":
      return { type: "raw", data: raw.data };
    default:
      return { type: "raw", data: raw };
  }
}
