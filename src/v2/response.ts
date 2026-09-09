/**
 * Response translation: GigaChat JSON/SSE responses -> OpenAI-compatible
 * chat.completion / chat.completion.chunk payloads.
 */
import { v4 } from "uuid";
import { warn, error } from "./constants.js";
import { getOriginalToolName } from "./toolRegistry.js";
import { stringifyArguments } from "../utils/converter.js";
import type {
  GigaChatChoice,
  GigaChatResponse,
  OpenAiChatCompletion,
  OpenAiChatChunk
} from "../types/gigachat.js";

/** Headers used for the translated SSE stream. */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive"
};

/**
 * Translate one SSE chunk. Tool-call ids stay stable across chunks of the
 * same call thanks to the shared per-stream `streamToolCallIds` map.
 */
export function translateStreamChunk(
  sberJson: GigaChatResponse,
  streamToolCallIds: Map<string, string>
): OpenAiChatChunk {
  return {
    id: sberJson.id || `chatcmp-${v4()}`,
    object: "chat.completion.chunk",
    created: sberJson.created || Math.floor(Date.now() / 1000),
    model: sberJson.model || "GigaChat-Max",
    choices: (sberJson.choices || []).map((c) => {
      const delta: OpenAiChatChunk["choices"][number]["delta"] = {
        role: c.delta?.role,
        content: c.delta?.content || ""
      };
      if (c.delta?.reasoning_content) {
        delta.reasoning_content = c.delta.reasoning_content;
      }
      if (c.delta?.functions_state_id) {
        delta.functions_state_id = c.delta.functions_state_id;
      }
      let finishReason: string | null = c.finish_reason || null;
      if (finishReason === "function_call") {
        finishReason = "tool_calls";
      }
      if (c.delta?.function_call) {
        const originalName = getOriginalToolName(c.delta.function_call.name);
        const callKey = `${c.index ?? 0}:${originalName}`;
        let callId = streamToolCallIds.get(callKey);
        if (!callId) {
          callId = `call_${v4()}`;
          streamToolCallIds.set(callKey, callId);
        }
        delta.tool_calls = [
          {
            index: 0,
            id: callId,
            type: "function",
            function: {
              name: originalName,
              arguments: stringifyArguments(c.delta.function_call.arguments)
            }
          }
        ];
        finishReason = "tool_calls";
      } else if (c.delta?.tool_calls) {
        delta.tool_calls = c.delta.tool_calls;
      }
      return {
        index: c.index ?? 0,
        delta,
        finish_reason: finishReason
      };
    })
  };
}

/**
 * Translate a complete (non-streaming) GigaChat response.
 */
export function translateGigaChatToOpenAi(sberResponse: GigaChatResponse): OpenAiChatCompletion {
  return {
    id: sberResponse.id || `chatcmp-${v4()}`,
    object: "chat.completion",
    created: sberResponse.created || Math.floor(Date.now() / 1000),
    model: sberResponse.model || "GigaChat-Max",
    choices: (sberResponse.choices || []).map((c: GigaChatChoice) => {
      let finishReason: string | null = c.finish_reason || "stop";
      if (finishReason === "function_call") {
        finishReason = "tool_calls";
      }
      const choice: OpenAiChatCompletion["choices"][number] = {
        index: c.index ?? 0,
        message: {
          role: c.message?.role || "assistant",
          content: c.message?.content || ""
        },
        finish_reason: finishReason
      };
      if (c.message?.reasoning_content) {
        choice.message.reasoning_content = c.message.reasoning_content;
      }
      if (c.message?.function_call) {
        choice.message.tool_calls = [
          {
            id: `call_${v4()}`,
            type: "function",
            function: {
              name: getOriginalToolName(c.message.function_call.name),
              arguments: stringifyArguments(c.message.function_call.arguments)
            }
          }
        ];
        choice.finish_reason = "tool_calls";
        if (c.message.functions_state_id) {
          choice.message.functions_state_id = c.message.functions_state_id;
        }
      } else if (c.message?.tool_calls) {
        choice.message.tool_calls = c.message.tool_calls;
        choice.finish_reason = "tool_calls";
      }
      return choice;
    }),
    usage: {
      prompt_tokens: sberResponse.usage?.prompt_tokens ?? 0,
      completion_tokens: sberResponse.usage?.completion_tokens ?? 0,
      total_tokens: sberResponse.usage?.total_tokens ?? 0
    }
  };
}

/** Warn when a payload approaches the GigaChat 128K token context window. */
export function validateMessagePayload(content: string): void {
  const payloadBytes = Buffer.byteLength(content, "utf8");
  const limitBytes = 400 * 1024;
  if (payloadBytes > limitBytes) {
    warn(
      `WARNING: Content size (${Math.round(payloadBytes / 1024)} KB) is large. ` +
        "GigaChat models will fail if combined content exceeds the 128K token context window."
    );
  }
}

/**
 * Transform a GigaChat SSE byte stream into an OpenAI-compatible SSE stream.
 */
function makeSseTransformer(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const streamToolCallIds = new Map<string, string>();
  let buffer = "";
  let done = false;

  const processSseLine = (line: string, controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("data: ")) {
      const dataText = trimmed.slice(6);
      if (dataText === "[DONE]") {
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      } else {
        try {
          const sberJson = JSON.parse(dataText) as GigaChatResponse;
          const openAiJson = translateStreamChunk(sberJson, streamToolCallIds);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiJson)}\n\n`));
        } catch {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
      }
    } else {
      controller.enqueue(encoder.encode(`${line}\n`));
    }
  };

  const processBuffer = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      processSseLine(line, controller);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      const { value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        processBuffer(controller);
      } else {
        done = true;
        if (buffer.trim()) {
          const tail = buffer;
          buffer = "";
          for (const line of tail.split("\n")) {
            processSseLine(line, controller);
          }
        }
        controller.close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {}
    }
  });
}

/** Wrap a streaming upstream response in the translated SSE stream. */
export async function translateStreamingResponse(
  response: Response
): Promise<Response> {
  if (!response.body) {
    return new Response("", { status: response.status, headers: SSE_HEADERS });
  }
  return new Response(makeSseTransformer(response.body), {
    status: response.status,
    headers: SSE_HEADERS
  });
}

/** Translate a non-streaming upstream response into an OpenAI payload. */
export async function translateJsonResponse(response: Response): Promise<Response> {
  let status = response.status;
  let openAiPayload: unknown;
  try {
    const sberJson = (await response.json()) as GigaChatResponse & {
      message?: string;
      error?: { message?: string };
    };
    if (status >= 200 && status < 300) {
      openAiPayload = translateGigaChatToOpenAi(sberJson);
    } else {
      const message = sberJson.message || sberJson.error?.message || JSON.stringify(sberJson);
      openAiPayload = {
        error: {
          message: `GigaChat API Error: ${message}`,
          type: "api_error",
          code: status
        }
      };
      error(`Sberbank API returned ${status}:`, message);
    }
  } catch (err) {
    status = 502;
    openAiPayload = {
      error: {
        message: `GigaChat Translation Proxy Error: ${err instanceof Error ? err.message : String(err)}`,
        type: "api_error",
        code: 502
      }
    };
    error("Response translation failed:", err instanceof Error ? err.message : String(err));
  }
  return new Response(JSON.stringify(openAiPayload), {
    status: status < 400 ? 200 : status,
    headers: { "Content-Type": "application/json" }
  });
}