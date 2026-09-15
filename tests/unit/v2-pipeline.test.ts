/**
 * Unit tests: V2 pipeline (plan §22 thin-plugin orchestration).
 *
 * Covers the request/response flows the plugin hooks delegate to:
 * - OpenAI body → V2 wire request (with session tools_state_id injection);
 * - V2 JSON response → OpenAI chat completion (state captured);
 * - upstream JSON error → OpenAI error envelope;
 * - V2 SSE stream → OpenAI SSE stream (state captured at flush, [DONE]).
 */
import { describe, expect, test } from "bun:test";
import type { ChatCompletionV2Response } from "../../src/gigachat/v2/types";
import { createV2Pipeline } from "../../src/translation/v2-pipeline";
import { basicChatRequest } from "../fixtures/requests/openai";
import { malformedStream, textStream, toolStream } from "../fixtures/streaming/sse";

function v2ResponseWithState(stateId?: string): ChatCompletionV2Response {
  return {
    model: "GigaChat-2-Max",
    created_at: 1700000000,
    finish_reason: "stop",
    messages: [
      {
        role: "assistant",
        content: [{ text: "Привет" }, { text: " мир!" }],
        ...(stateId !== undefined ? { tools_state_id: stateId } : {}),
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

describe("createV2Pipeline.chatRequest", () => {
  test("OpenAI body maps to a V2 wire request", () => {
    const pipeline = createV2Pipeline();
    const v2 = pipeline.chatRequest(basicChatRequest, "s-1");
    expect(v2.model).toBe("GigaChat-2-Max");
    expect(v2.messages[0].role).toBe("system");
    expect(v2.messages[2].content).toContainEqual({
      function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' },
    });
  });

  test("session tools_state_id is injected when the store has one", () => {
    const pipeline = createV2Pipeline();
    pipeline.store.capture("s-1", "state-live");
    const v2 = pipeline.chatRequest(basicChatRequest, "s-1");
    const assistant = v2.messages.filter((m) => m.role === "assistant");
    expect(assistant.at(-1)?.tool_state_id).toBe("state-live");
  });

  test("sessions never mix state", () => {
    const pipeline = createV2Pipeline();
    pipeline.store.capture("A", "state-A");
    expect(pipeline.chatRequest(basicChatRequest, "A").messages[2].tool_state_id).toBe("state-A");
    expect(pipeline.chatRequest(basicChatRequest, "B").messages[2].tool_state_id).toBeUndefined();
  });
});

describe("createV2Pipeline.jsonResponse", () => {
  test("V2 JSON maps to an OpenAI completion and captures state", () => {
    const pipeline = createV2Pipeline();
    const openAi = pipeline.jsonResponse(v2ResponseWithState("state-json-1"), "s-1");
    expect(openAi.choices[0].message.content).toBe("Привет мир!");
    expect(openAi.choices[0].message.functions_state_id).toBe("state-json-1");
    expect(pipeline.store.getToolsStateId("s-1")).toBe("state-json-1");
  });

  test("no state in response → nothing stored", () => {
    const pipeline = createV2Pipeline();
    pipeline.jsonResponse(v2ResponseWithState(), "s-1");
    expect(pipeline.store.getToolsStateId("s-1")).toBeUndefined();
  });
});

describe("createV2Pipeline.jsonResponseFromUpstream", () => {
  test("2xx JSON is translated into a 200 OpenAI completion", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response(JSON.stringify(v2ResponseWithState("state-up")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const out = await pipeline.jsonResponseFromUpstream(upstream, "s-1");
    expect(out.status).toBe(200);
    const body = (await out.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("Привет мир!");
    expect(pipeline.store.getToolsStateId("s-1")).toBe("state-up");
  });

  test("non-2xx JSON becomes an OpenAI error envelope", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
    const out = await pipeline.jsonResponseFromUpstream(upstream, "s-1");
    expect(out.status).toBe(429);
    const body = (await out.json()) as { error: { message: string; code: number } };
    expect(body.error.code).toBe(429);
    expect(body.error.message).toContain("quota");
  });

  test("unparseable JSON becomes a 502 proxy error", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response("not json", { status: 200 });
    const out = await pipeline.jsonResponseFromUpstream(upstream, "s-1");
    expect(out.status).toBe(502);
    const body = (await out.json()) as { error: { code: number } };
    expect(body.error.code).toBe(502);
  });
});

describe("createV2Pipeline.streamingResponse", () => {
  test("text stream becomes OpenAI SSE chunks ending in [DONE]", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response(new TextEncoder().encode(textStream), {
      headers: { "Content-Type": "text/event-stream" },
    });
    const out = pipeline.streamingResponse(upstream, "s-1");
    expect(out.headers.get("content-type")).toContain("text/event-stream");
    const body = await out.text();
    expect(body).toContain("data: [DONE]");
    expect(body).toContain("Привет");
    expect(body).toContain("chat.completion.chunk");
  });

  test("tool stream carries stable tool_calls chunks", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response(new TextEncoder().encode(toolStream), {
      headers: { "Content-Type": "text/event-stream" },
    });
    const body = await (await pipeline.streamingResponse(upstream, "s-1")).text();
    expect(body).toContain('"name":"get_weather"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain("data: [DONE]");
  });

  test("tools_state_id from response.message.done is captured at flush", async () => {
    const pipeline = createV2Pipeline();
    const withState =
      'event: response.message.delta\ndata: {"role":"assistant","content":[{"text":"ok"}]}\n\n' +
      'event: response.message.done\ndata: {"finish_reason":"stop","tools_state_id":"state-sse-7"}\n\n';
    const upstream = new Response(new TextEncoder().encode(withState), {
      headers: { "Content-Type": "text/event-stream" },
    });
    await (await pipeline.streamingResponse(upstream, "s-1")).text();
    expect(pipeline.store.getToolsStateId("s-1")).toBe("state-sse-7");
  });

  test("malformed frames are reported via onSseError, stream still terminates", async () => {
    const errors: string[] = [];
    const pipeline = createV2Pipeline({ onSseError: (msg) => errors.push(msg) });
    const upstream = new Response(new TextEncoder().encode(malformedStream), {
      headers: { "Content-Type": "text/event-stream" },
    });
    const body = await (await pipeline.streamingResponse(upstream, "s-1")).text();
    expect(errors.length).toBeGreaterThan(0);
    expect(body).toContain("data: [DONE]");
  });

  test("empty response body → empty SSE body with [DONE]-free headers", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response(null, { status: 200 });
    const out = pipeline.streamingResponse(upstream, "s-1");
    expect(await out.text()).toBe("");
  });
});
