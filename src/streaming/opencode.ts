/**
 * InternalStreamEvent → OpenAI-compatible streaming chunks (plan §12
 * "opencode").
 *
 * OpenCode speaks the OpenAI chunk protocol: `chat.completion.chunk` objects
 * carrying `delta`, terminated by a final `data: [DONE]` on the SSE wire. The
 * provider-side absence of `[DONE]` (V2 uses `response.message.done`) does not
 * propagate to the OpenCode surface — the connector *produces* the OpenAI
 * terminator, exactly like the legacy path did.
 *
 * Tool-call ids are stable within one stream (assigned by the state machine).
 * `tool_completed` events have no per-chunk OpenAI representation and are
 * intentionally mapped to nothing. A `usage` event becomes a single trailing
 * usage-only chunk (`choices: []`, the OpenAI `stream_options.include_usage`
 * shape) emitted after the finish chunk; `error` events are surfaced in the
 * result so the integration layer can log/cancel instead of fabricating chunks.
 *
 * This module is only used by the V2 pipeline — V1 keeps its own transformer
 * (`src/v2/response.ts`), whose streaming output is unchanged.
 */
import { v4 } from "uuid";
import type { OpenAiChatChunk } from "../types/gigachat";
import type { InternalStreamEvent } from "./state";

export interface StreamMeta {
  model: string;
  /** Chunk id; defaults to `chatcmp-<uuid>`. */
  id?: string;
  /** Chunk timestamp; defaults to now. */
  created?: number;
}

export interface OpenAiChunkResult {
  chunks: OpenAiChatChunk[];
  errors: string[];
}

export function internalToOpenAiChunks(
  events: InternalStreamEvent[],
  meta: StreamMeta,
): OpenAiChunkResult {
  const chunks: OpenAiChatChunk[] = [];
  const errors: string[] = [];
  let roleStarted = false;
  let callIndex = 0;
  let usage: Extract<InternalStreamEvent, { kind: "usage" }> | undefined;
  const callIndexes = new Map<string, number>();
  const base = {
    id: meta.id ?? `chatcmp-${v4()}`,
    object: "chat.completion.chunk" as const,
    created: meta.created ?? Math.floor(Date.now() / 1000),
    model: meta.model,
  };

  for (const ev of events) {
    switch (ev.kind) {
      case "text":
        chunks.push(makeChunk(base, { ...maybeRole(roleStarted), content: ev.text }));
        roleStarted = true;
        break;
      case "reasoning":
        chunks.push(makeChunk(base, { ...maybeRole(roleStarted), reasoning_content: ev.text }));
        roleStarted = true;
        break;
      case "tool_call": {
        let idx = callIndexes.get(ev.callId);
        if (idx === undefined) {
          idx = callIndex;
          callIndex += 1;
          callIndexes.set(ev.callId, idx);
        }
        chunks.push(
          makeChunk(base, {
            ...maybeRole(roleStarted),
            tool_calls: [
              {
                index: idx,
                id: ev.callId,
                type: "function",
                function: { name: ev.name, arguments: ev.arguments },
              },
            ],
          }),
        );
        roleStarted = true;
        break;
      }
      case "tool_completed":
        // No per-chunk OpenAI representation (documented).
        break;
      case "usage":
        // Buffered and emitted once after the loop, so the usage-only chunk
        // lands after the finish chunk (OpenAI include_usage ordering).
        usage = ev;
        break;
      case "done":
        chunks.push(makeChunk(base, {}, ev.finishReason));
        break;
      case "error":
        errors.push(ev.message);
        break;
    }
  }
  if (usage !== undefined) {
    chunks.push({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: usage.usage.promptTokens,
        completion_tokens: usage.usage.completionTokens,
        total_tokens: usage.usage.totalTokens,
      },
    });
  }
  return { chunks, errors };
}

/** Compose the translated SSE bytes for the OpenCode surface (incl. [DONE]). */
export function openCodeSseBody(chunks: OpenAiChatChunk[]): string {
  let body = "";
  for (const chunk of chunks) {
    body += `data: ${JSON.stringify(chunk)}\n\n`;
  }
  body += "data: [DONE]\n\n";
  return body;
}

/**
 * Restore original tool names inside a chunk's `tool_calls` (legacy
 * `getOriginalToolName` parity, §23): names the session registry aliased to
 * `tool_<n>` on the request side are reversed to the OpenCode-facing name.
 * Chunks without tool calls pass through unchanged.
 */
export function restoreChunkNames(
  chunk: OpenAiChatChunk,
  resolve: (name: string) => string,
): OpenAiChatChunk {
  const choices = chunk.choices.map((choice) => {
    const toolCalls = choice.delta.tool_calls?.map((call) => ({
      ...call,
      function: { ...call.function, name: resolve(call.function.name) },
    }));
    if (toolCalls === undefined) return choice;
    return { ...choice, delta: { ...choice.delta, tool_calls: toolCalls } };
  });
  return { ...chunk, choices };
}

function maybeRole(roleStarted: boolean): { role?: "assistant" } {
  return roleStarted ? {} : { role: "assistant" as const };
}

function makeChunk(
  base: { id: string; object: "chat.completion.chunk"; created: number; model: string },
  delta: OpenAiChatChunk["choices"][number]["delta"],
  finishReason: string | null = null,
): OpenAiChatChunk {
  return {
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
