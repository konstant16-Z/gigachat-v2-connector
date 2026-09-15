/**
 * GigaChat V2 response → normalized model.
 *
 * Full-fidelity mapping: non-text content (files, tool results, logprobs,
 * inline_data) is preserved in `contentParts`/`metadata` instead of being
 * silently dropped (agents.md RULE 8/13). tool_execution items are surfaced as
 * tool results provisionally until PHASE 7 (builtin tools).
 */
import type {
  ChatCompletionV2Response,
  V2FinishReason,
  V2ResponseMessage,
} from "../gigachat/v2/types";
import type {
  NormalizedChoice,
  NormalizedContentPart,
  NormalizedResponse,
  NormalizedToolCall,
  TextPart,
} from "../core/types";
import { parseToolArguments } from "./utils";

export function gigachatV2ToNormalized(resp: ChatCompletionV2Response): NormalizedResponse {
  return {
    // V2 messages carry no response id; generate one at the boundary (documented).
    id: crypto.randomUUID(),
    created: resp.created_at ?? Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: resp.messages.map((m, index) => toChoice(m, index, resp.finish_reason)),
    usage: toUsage(resp),
    metadata: toMetadata(resp),
  };
}

function toChoice(
  m: V2ResponseMessage,
  index: number,
  finishReason: V2FinishReason,
): NormalizedChoice {
  const parts: NormalizedContentPart[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  const texts: string[] = [];
  const extras: Record<string, unknown> = {};

  for (const item of m.content) {
    if (item.text !== undefined) {
      texts.push(item.text);
      parts.push({ type: "text", text: item.text } satisfies TextPart);
    }
    for (const file of item.files ?? []) {
      parts.push({ type: "file", id: file.id ?? "", target: file.target, mime: file.mime });
    }
    if (item.function_call !== undefined) {
      toolCalls.push({
        // V2 function_call parts carry no id (documented); generated locally.
        id: crypto.randomUUID(),
        name: item.function_call.name,
        arguments: parseToolArguments(item.function_call.arguments),
      });
    }
    if (item.tool_execution !== undefined) {
      parts.push({
        type: "tool_result",
        name: item.tool_execution.name,
        result: JSON.stringify({
          status: item.tool_execution.status,
          seconds_left: item.tool_execution.seconds_left,
          censored: item.tool_execution.censored,
        }),
      });
    }
    if (item.logprobs !== undefined) extras.logprobs = item.logprobs;
    if (item.inline_data !== undefined) extras.inline_data = item.inline_data;
  }

  const message: NormalizedChoice["message"] = {
    role: m.role,
    content: texts.length > 0 ? texts.join("") : null,
    contentParts: parts,
  };
  if (m.tools_state_id !== undefined) message.stateId = m.tools_state_id;
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  if (Object.keys(extras).length > 0) message.metadata = extras;

  return {
    index,
    message,
    finishReason: toOpenAiFinishReason(finishReason),
  };
}

function toOpenAiFinishReason(reason: V2FinishReason): string | null {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "function_call":
      return "tool_calls";
    case "function_call_error":
      // Invalid arguments are surfaced in the message content; promoting this
      // to a hard error is deferred to the error-normalization phase (documented).
      return "stop";
    case "blacklist":
    case "request_blacklist":
    case "request_whitelist":
    case "request_filter":
    case "response_blacklist":
      // Closest OpenAI-compatible signal is content_filter (documented).
      return "content_filter";
  }
}

function toUsage(resp: ChatCompletionV2Response): NormalizedResponse["usage"] {
  const u = resp.usage;
  if (!u) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return {
    promptTokens: u.input_tokens,
    completionTokens: u.output_tokens,
    totalTokens: u.total_tokens,
    ...(u.input_tokens_details?.cached_tokens !== undefined
      ? { cachedTokens: u.input_tokens_details.cached_tokens }
      : {}),
  };
}

function toMetadata(resp: ChatCompletionV2Response): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (resp.thread_id !== undefined) meta.thread_id = resp.thread_id;
  if (resp.additional_data !== undefined) meta.additional_data = resp.additional_data;
  return Object.keys(meta).length > 0 ? meta : undefined;
}