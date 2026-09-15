/**
 * Normalized model → OpenAI-compatible response (OpenCode surface).
 *
 * Keeps the V1-compatible `functions_state_id` field so the conversation state
 * token round-trips through OpenCode's stored messages (request side reads it
 * back in opencode-to-normalized).
 */

import type { NormalizedResponse, NormalizedToolCall } from "../core/types";
import type { GigaChatToolCall, OpenAiChatCompletion } from "../types/gigachat";

export function normalizedToOpenCode(norm: NormalizedResponse): OpenAiChatCompletion {
  return {
    id: norm.id,
    object: "chat.completion",
    created: norm.created,
    model: norm.model,
    choices: norm.choices.map((choice) => ({
      index: choice.index,
      message: {
        role: choice.message.role,
        content: choice.message.content,
        ...(choice.message.reasoning !== undefined
          ? { reasoning_content: choice.message.reasoning }
          : {}),
        ...(choice.message.toolCalls !== undefined
          ? { tool_calls: toOpenAiToolCalls(choice.message.toolCalls) }
          : {}),
        ...(choice.message.stateId !== undefined
          ? { functions_state_id: choice.message.stateId }
          : {}),
      },
      finish_reason: choice.finishReason,
    })),
    usage: {
      prompt_tokens: norm.usage.promptTokens,
      completion_tokens: norm.usage.completionTokens,
      total_tokens: norm.usage.totalTokens,
    },
  };
}

function toOpenAiToolCalls(calls: NormalizedToolCall[]): GigaChatToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    index: 0,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }));
}
