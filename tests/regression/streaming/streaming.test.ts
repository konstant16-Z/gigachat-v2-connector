/**
 * PHASE 10 §23 — regression: response behaviors from src/v2/response.ts must
 * survive the V2 path (streaming + non-streaming + error envelopes).
 *
 * Pinned legacy behaviors: finish_reason "function_call" → "tool_calls",
 * delta defaults (role/content ""), stable tool-call ids across split deltas,
 * reasoning_content passthrough, tool_state_id → functions_state_id, SSE
 * headers, and the error-envelope / 502 surface. Documented divergence: the V1
 * stream passed malformed JSON lines through raw; V2 (PHASE 11 §28) emits a
 * controlled `onSseError` callback instead of silent corruption.
 */
import { describe, expect, test } from "bun:test";
import type { ChatCompletionV2Response } from "../../../src/gigachat/v2/types";
import { createV2Pipeline, V2_SSE_HEADERS } from "../../../src/translation/v2-pipeline";
import { SSE_HEADERS } from "../../../src/v2/response";

const PIPELINE = "s-stream";

function sseResponse(frames: string, status = 200): Response {
  return new Response(new Blob([new TextEncoder().encode(frames)]), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonDataLines(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => l.slice(6));
}

describe("§23 streaming — JSON (non-streaming) parity", () => {
  test("finish_reason function_call → tool_calls; tool_calls shaped like V1", () => {
    const pipeline = createV2Pipeline();
    const response: ChatCompletionV2Response = {
      model: "GigaChat-2-Max",
      created_at: 1234,
      finish_reason: "function_call",
      messages: [
        {
          role: "assistant",
          content: [
            { function_call: { id: "fc-1", name: "get_weather", arguments: { city: "Moscow" } } },
          ],
        },
      ],
    };
    const out = pipeline.jsonResponse(response, PIPELINE);
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.choices[0].message.tool_calls?.[0]).toEqual({
      id: "fc-1",
      index: 0,
      type: "function",
      function: { name: "get_weather", arguments: JSON.stringify({ city: "Moscow" }) },
    });
  });

  test("usage missing → zero fallback (V1 translateJsonResponse parity)", () => {
    const pipeline = createV2Pipeline();
    const out = pipeline.jsonResponse(
      { model: "GigaChat-2-Max", created_at: 1234, finish_reason: "stop", messages: [] },
      PIPELINE,
    );
    expect(out.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  test("tool_state_id surfaces as functions_state_id (V1 field-name parity)", () => {
    const pipeline = createV2Pipeline();
    const out = pipeline.jsonResponse(
      {
        model: "GigaChat-2-Max",
        created_at: 1234,
        finish_reason: "stop",
        messages: [{ role: "assistant", tool_state_id: "state-1", content: [{ text: "ok" }] }],
      },
      PIPELINE,
    );
    expect(out.choices[0].message.functions_state_id).toBe("state-1");
  });
});

describe("§23 streaming — SSE chunk parity", () => {
  test("function_call delta becomes a tool_calls chunk (name + stringified args)", async () => {
    const pipeline = createV2Pipeline();
    const upstream = sseResponse(
      'event: response.message.delta\ndata: {"messages":[{"content":[{"function_call":{"name":"get_weather","arguments":{"city":"Moscow"}}}]}]}\n\n' +
        'event: response.message.done\ndata: {"finish_reason":"function_call"}\n\n',
    );
    const body = await pipeline.streamingResponse(upstream, PIPELINE).text();
    const chunks = jsonDataLines(body).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(chunks.some((c) => JSON.stringify(c).includes('"tool_calls"'))).toBe(true);
    // finish_reason translated to tool_calls on the done chunk
    const done = chunks.find(
      (c) =>
        (c.choices as Array<{ finish_reason?: string | null }> | undefined)?.[0]?.finish_reason !=
        null,
    );
    // `done` is guaranteed non-null here (the find above matched it).
    expect((done as { choices: Array<{ finish_reason: string }> }).choices[0].finish_reason).toBe(
      "tool_calls",
    );
  });

  test("split deltas keep a stable call id across the stream (V1 streamToolCallIds parity)", async () => {
    const pipeline = createV2Pipeline();
    const upstream = sseResponse(
      'event: response.message.delta\ndata: {"messages":[{"content":[{"function_call":{"name":"get_weather"}}]}]}\n\n' +
        'event: response.message.delta\ndata: {"messages":[{"content":[{"function_call":{"name":"get_weather","arguments":{"city":"Moscow"}}}]}]}\n\n' +
        'event: response.message.done\ndata: {"finish_reason":"function_call"}\n\n',
    );
    const body = await pipeline.streamingResponse(upstream, PIPELINE).text();
    const calls = jsonDataLines(body)
      .map((l) => JSON.parse(l))
      .flatMap((c) => c.choices as Array<{ delta: { tool_calls?: Array<{ id: string }> } }>)
      .flatMap((ch) => ch.delta.tool_calls ?? [])
      .map((tc) => tc.id);
    expect(calls).toEqual(["call_1", "call_1"]); // two deltas, one logical call
  });

  test("reasoning_content passthrough in streaming deltas", async () => {
    const pipeline = createV2Pipeline();
    const upstream = sseResponse(
      // reasoning_content lives on the message inside messages[] (live format).
      'event: response.message.delta\ndata: {"messages":[{"reasoning_content":"think","content":[{"text":"ok"}]}]}\n\n' +
        'event: response.message.done\ndata: {"finish_reason":"stop"}\n\n',
    );
    const body = await pipeline.streamingResponse(upstream, PIPELINE).text();
    const contents = jsonDataLines(body)
      .map((l) => JSON.parse(l))
      .flatMap((c) => c.choices as Array<{ delta: { reasoning_content?: string } }>)
      .map((ch) => ch.delta.reasoning_content)
      .filter((r): r is string => r !== undefined);
    expect(contents).toContain("think");
  });

  test("empty upstream body → headers + [DONE] only", async () => {
    const pipeline = createV2Pipeline();
    const upstream = sseResponse("");
    const out = pipeline.streamingResponse(upstream, PIPELINE);
    expect(out.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await out.text();
    expect(body).toBe("data: [DONE]\n\n");
  });

  test("SSE headers identical to the legacy V1 surface", () => {
    expect(Object.entries(SSE_HEADERS)).toEqual(Object.entries(V2_SSE_HEADERS));
  });
});

describe("§23 streaming — malformed SSE (V1 raw passthrough → V2 controlled error)", () => {
  test("non-JSON data line reaches onSseError, stream still terminates with [DONE]", async () => {
    const errors: string[] = [];
    const pipeline = createV2Pipeline({ onSseError: (m) => errors.push(m) });
    const upstream = sseResponse("event: response.message.done\ndata: not-json\n\n");
    const body = await pipeline.streamingResponse(upstream, PIPELINE).text();
    expect(body).toContain("data: [DONE]");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/invalid or empty JSON in event "response.message.done"/);
  });
});

describe("§23 streaming — error envelope / 502 surface (V1 translateJsonResponse parity)", () => {
  test("non-2xx upstream → OpenAI-style error envelope with code=status", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response(JSON.stringify({ error: { message: "boom" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    const out = await pipeline.jsonResponseFromUpstream(upstream, PIPELINE);
    expect(out.status).toBe(429);
    const payload = (await out.json()) as { error: { message: string; code: number } };
    expect(payload.error.message).toBe("GigaChat API Error: boom");
    expect(payload.error.code).toBe(429);
  });

  test("unparseable JSON body → 502 translation proxy error", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response("this is not json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const out = await pipeline.jsonResponseFromUpstream(upstream, PIPELINE);
    expect(out.status).toBe(502);
    const payload = (await out.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("GigaChat Translation Proxy Error");
  });
});
