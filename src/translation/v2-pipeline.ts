/**
 * V2 pipeline — thin orchestration of the mapping layer (plan §22 "thin
 * plugin"). The plugin hooks delegate here; this module composes the mapping
 * modules and the session-scoped `tools_state_id` store.
 *
 *   OpenAI body → NormalizedRequest → GigaChat V2 body
 *   GigaChat V2 JSON → NormalizedResponse → OpenAI chat completion
 *   GigaChat V2 SSE → (SseParser → StreamStateMachine → OpenAI chunks) → SSE
 *
 * All functions are pure with respect to their parameters except the
 * per-pipeline session store: one pipeline instance per plugin load, keyed by
 * session id — sessions never mix and there is no module-level conversation
 * state (agents.md §14).
 */

import {
  aliasNamesInRequest,
  restoreNamesInResponse,
  ToolNameRegistry,
} from "../gigachat/v2/tools/normalize";
import type { SessionToolStateStore } from "../gigachat/v2/tools/state";
import { createToolStateStore } from "../gigachat/v2/tools/state";
import type { ChatCompletionV2Request, ChatCompletionV2Response } from "../gigachat/v2/types";
import { classifyEvent } from "../streaming/events";
import type { StreamMeta } from "../streaming/opencode";
import { internalToOpenAiChunks, restoreChunkNames } from "../streaming/opencode";
import { SseParser } from "../streaming/parser";
import { StreamStateMachine } from "../streaming/state";
import type { OpenAiChatBody, OpenAiChatCompletion } from "../types/gigachat";
import { authManager } from "../v2/auth";
import { uploadDataUrlsInRequest } from "../v2/files";
import { gigachatV2ToNormalized } from "./gigachat-v2-to-normalized";
import { normalizedToGigaChatV2 } from "./normalized-to-gigachat-v2";
import { normalizedToOpenCode } from "./normalized-to-opencode";
import { openCodeToNormalized } from "./opencode-to-normalized";

/** SSE headers for the translated stream reaching the OpenCode surface. */
export const V2_SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

export interface V2PipelineOptions {
  /** Called for streamed protocol errors (finish_reason "error", malformed…). */
  onSseError?: (message: string) => void;
}

export interface V2Pipeline {
  store: SessionToolStateStore;
  /** OpenAI chat body → GigaChat V2 wire body (session state injected; async for file uploads). */
  chatRequest(openAiBody: OpenAiChatBody, sessionId: string): Promise<ChatCompletionV2Request>;
  /** V2 JSON response body → OpenAI chat completion (session state captured). */
  jsonResponse(v2Body: ChatCompletionV2Response, sessionId: string): OpenAiChatCompletion;
  /**
   * V2 HTTP JSON response → OpenAI HTTP JSON response. Non-2xx payloads become
   * OpenAI-style error envelopes; parse failures become a 502 proxy error
   * (mirrors the legacy `translateJsonResponse` surface).
   */
  jsonResponseFromUpstream(response: Response, sessionId: string): Promise<Response>;
  /** V2 SSE Response → OpenAI SSE Response (session state captured at flush). */
  streamingResponse(response: Response, sessionId: string): Response;
  /** OpenAI-style error envelope for non-2xx upstream responses. */
  errorEnvelope(
    status: number,
    message: string,
  ): { error: { message: string; type: string; code: number } };
}

export function createV2Pipeline(options: V2PipelineOptions = {}): V2Pipeline {
  const store = createToolStateStore();
  const onSseError = options.onSseError ?? (() => {});
  // Session-scoped tool-name registries (legacy getToolAlias parity, §23):
  // builtins pass through, unsafe names become deterministic tool_<n> aliases.
  const registries = new Map<string, ToolNameRegistry>();
  const registryFor = (sessionId: string): ToolNameRegistry => {
    let registry = registries.get(sessionId);
    if (registry === undefined) {
      registry = new ToolNameRegistry();
      registries.set(sessionId, registry);
    }
    return registry;
  };

  return {
    store,
    async chatRequest(openAiBody, sessionId) {
      const normalized = openCodeToNormalized(openAiBody);
      const withState = store.applyToRequest(sessionId, normalized);
      // Upload any base64 data-URL images to Files API before mapping to V2 wire format.
      // Only fetch token if there are data URLs to upload.
      const hasDataUrls = withState.messages.some((m) =>
        m.content.some((p) => p.type === "image" && p.url.startsWith("data:")),
      );
      const withFiles = hasDataUrls
        ? await authManager
            .getAccessToken()
            .then(({ token }) => uploadDataUrlsInRequest(withState, token))
        : withState;
      // Legacy parity: alias V2-unsafe tool names (declarations + calls +
      // results) per session, exactly like the V1 connector's global registry.
      const withNames = aliasNamesInRequest(withFiles, registryFor(sessionId));
      return normalizedToGigaChatV2(withNames);
    },
    jsonResponse(v2Body, sessionId) {
      const normalized = gigachatV2ToNormalized(v2Body);
      const restored = restoreNamesInResponse(normalized, registryFor(sessionId));
      store.captureFromResponse(sessionId, restored);
      return normalizedToOpenCode(restored);
    },
    streamingResponse(response, sessionId) {
      if (!response.body) {
        return new Response("", { status: response.status, headers: V2_SSE_HEADERS });
      }
      const transform = createSseTransform(sessionId, store, onSseError, (name) =>
        registryFor(sessionId).originalOf(name),
      );
      const stream = pipeWithCancel(response.body, transform);
      return new Response(stream, { status: response.status, headers: V2_SSE_HEADERS });
    },
    async jsonResponseFromUpstream(response, sessionId) {
      let status = response.status;
      let payload: unknown;
      try {
        const v2Body = (await response.json()) as ChatCompletionV2Response & {
          message?: string;
          error?: { message?: string };
        };
        if (status >= 200 && status < 300) {
          payload = this.jsonResponse(v2Body, sessionId);
        } else {
          const message = v2Body.message ?? v2Body.error?.message ?? JSON.stringify(v2Body);
          payload = this.errorEnvelope(status, message);
        }
      } catch (err) {
        status = 502;
        payload = {
          error: {
            message: `GigaChat Translation Proxy Error: ${err instanceof Error ? err.message : String(err)}`,
            type: "api_error",
            code: 502,
          },
        };
      }
      return new Response(JSON.stringify(payload), {
        status: status < 400 ? 200 : status,
        headers: { "Content-Type": "application/json" },
      });
    },
    errorEnvelope(status, message) {
      return {
        error: { message: `GigaChat API Error: ${message}`, type: "api_error", code: status },
      };
    },
  };
}

function createSseTransform(
  sessionId: string,
  store: SessionToolStateStore,
  onSseError: (message: string) => void,
  restoreName: (name: string) => string,
): TransformStream<Uint8Array, Uint8Array> {
  const parser = new SseParser();
  const machine = new StreamStateMachine();
  const encoder = new TextEncoder();
  let meta: StreamMeta | undefined;

  const pushText = (
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const frames = parser.push(text);
    for (const frame of frames) {
      const events = machine.push(classifyEvent(frame));
      if (meta === undefined) {
        meta = {
          model: machine.modelName ?? "GigaChat-2-Max",
          ...(machine.createdAt !== undefined ? { created: Number(machine.createdAt) } : {}),
        };
      }
      const { chunks, errors } = internalToOpenAiChunks(events, meta);
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(restoreChunkNames(chunk, restoreName))}\n\n`),
        );
      }
      for (const err of errors) onSseError(err);
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pushText(new TextDecoder().decode(chunk), controller);
    },
    flush(controller) {
      // Discharge a truncated tail (EOF without a trailing blank line).
      for (const frame of parser.flush()) {
        const events = machine.push(classifyEvent(frame));
        if (meta === undefined) {
          meta = {
            model: machine.modelName ?? "GigaChat-2-Max",
            ...(machine.createdAt !== undefined ? { created: Number(machine.createdAt) } : {}),
          };
        }
        const { chunks, errors } = internalToOpenAiChunks(events, meta);
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(restoreChunkNames(chunk, restoreName))}\n\n`),
          );
        }
        for (const err of errors) onSseError(err);
      }
      if (machine.lastToolsStateId !== undefined) {
        store.capture(sessionId, machine.lastToolsStateId);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

/**
 * Pipe `source` through `transform` with guaranteed cancellation propagation
 * (plan §29 — stream abort).
 *
 * Runtime pipeThrough implementations do not always forward a consumer cancel
 * to the piped source (verified on Bun 1.4: neither `reader.cancel()` on the
 * piped stream nor cancelling a `Response` wrapping it reaches the source),
 * which would leak the upstream GigaChat connection on client abort. This
 * manual pump is equivalent to pipeThrough for the happy path (source →
 * writer, transform readable → consumer) and additionally cancels both the
 * transform output and the source reader explicitly when the consumer aborts.
 */
function pipeWithCancel(
  source: ReadableStream<Uint8Array>,
  transform: TransformStream<Uint8Array, Uint8Array>,
): ReadableStream<Uint8Array> {
  const sourceReader = source.getReader();
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();

  void (async () => {
    try {
      while (true) {
        const { done, value } = await sourceReader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch {
      try {
        await writer.abort();
      } catch {}
    }
  })();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {}
      try {
        await sourceReader.cancel(reason);
      } catch {}
    },
  });
}
