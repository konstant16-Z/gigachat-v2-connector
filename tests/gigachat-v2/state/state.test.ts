/**
 * PHASE 11 §24 — V2 compatibility suite: state zone.
 *
 * Contract table:
 *
 *   response with tools_state_id ──jsonResponse/streamingResponse──▶ capture
 *   next request ──chatRequest──▶ injected `functions_state_id` on the last
 *   assistant message (only when tools are declared).
 *
 * Pinned semantics (plan §11):
 * - the id arrives on an assistant message, is sent back inside an assistant
 *   message of the NEXT request;
 * - state a client already round-tripped through history is NEVER overridden;
 * - the store is keyed by session id — session A state never leaks into B;
 * - streaming responses capture at flush (SSE frames may nest the id inside
 *   `messages[]` — extracted defensively, live-verified).
 */
import { describe, expect, test } from "bun:test";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import { basicChatRequest } from "../../fixtures/requests/openai";
import { toolCallV2Response } from "../../fixtures/responses/v2";
import { liveToolDoneStream } from "../../fixtures/streaming/sse";

const noop = (): void => {};

function byteStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function bodyReader(response: Response) {
  const body = response.body;
  if (body === null) throw new Error("expected a streaming response body");
  return body.getReader();
}

async function collectText(response: Response): Promise<string> {
  const reader = bodyReader(response);
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("§24 state zone — tools_state_id lifecycle", () => {
  test("jsonResponse captures state → next chatRequest injects functions_state_id", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const out = pipeline.jsonResponse(toolCallV2Response, "state-sess");
    expect(out.choices[0].message.functions_state_id).toBe("state-abc-123");

    const wire = await pipeline.chatRequest(basicChatRequest, "state-sess");
    expect(wire.messages[2].functions_state_id).toBe("state-abc-123");
  });

  test("client-carried state wins over the store (never overridden)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    pipeline.jsonResponse(toolCallV2Response, "state-sess"); // store now has state-abc-123

    const messages = basicChatRequest.messages ?? [];
    const wire = await pipeline.chatRequest(
      {
        ...basicChatRequest,
        messages: [
          messages[0],
          messages[1],
          { ...messages[2], functions_state_id: "client-x" },
          messages[3],
        ],
      },
      "state-sess",
    );
    expect(wire.messages[2].functions_state_id).toBe("client-x");
  });

  test("state is scoped to the session that produced it", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    pipeline.jsonResponse(toolCallV2Response, "ses-A");

    const wireB = await pipeline.chatRequest(basicChatRequest, "ses-B");
    expect(wireB.messages[2].functions_state_id).toBeUndefined();
  });

  test("streaming response captures nested tool_state_id at flush → next request injects", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const stream = pipeline.streamingResponse(
      new Response(byteStream(liveToolDoneStream)),
      "state-stream",
    );
    await collectText(stream); // consume the stream → flush → capture

    const wire = await pipeline.chatRequest(basicChatRequest, "state-stream");
    expect(wire.messages[2].functions_state_id).toBe("state-live-sse-77");
  });
});
