/**
 * LLM step executor.
 */

import { randomUUID } from "crypto";
import type { IPluginContext, ChatRequest } from "@openstarry/sdk";
import type { ILLMStep } from "../../types/workflow.js";
import { WorkflowExecutionError } from "../../errors.js";
import { interpolate } from "../interpolate.js";

/**
 * Execute an LLM step.
 *
 * @param step - LLM step definition
 * @param context - Execution context with interpolated variables
 * @param pluginCtx - Plugin context
 * @param executionId - Current execution ID
 * @returns LLM response text
 */
export async function executeLLMStep(
  step: ILLMStep,
  context: Record<string, unknown>,
  pluginCtx: IPluginContext,
  executionId: string
): Promise<unknown> {
  // Interpolate prompt
  const interpolatedPrompt = interpolate(step.prompt, context) as string;

  // Get provider from registry
  const provider = pluginCtx.providers?.get(step.provider);
  if (!provider) {
    const availableProviders = pluginCtx.providers?.list().map((p) => p.id) || [];
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `Provider "${step.provider}" not found. Available providers: ${availableProviders.join(", ") || "none"}`,
      step.name
    );
  }

  // Build chat request
  const request: ChatRequest = {
    model: step.model || provider.models?.[0]?.id || "default",
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: interpolatedPrompt }],
        createdAt: Date.now(),
      },
    ],
    ...(step.temperature !== undefined && { temperature: step.temperature }),
    ...(step.maxTokens !== undefined && { maxTokens: step.maxTokens }),
  };

  // Execute LLM provider — collect text from stream
  try {
    let responseText = "";
    for await (const event of provider.chat(request)) {
      if (event.type === "text_delta") {
        responseText += event.text;
      }
    }
    return responseText;
  } catch (error) {
    throw new WorkflowExecutionError(
      "unknown",
      executionId,
      `LLM provider failed: ${error instanceof Error ? error.message : String(error)}`,
      step.name,
      error
    );
  }
}
