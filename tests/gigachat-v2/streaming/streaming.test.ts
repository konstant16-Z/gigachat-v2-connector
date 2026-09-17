/**
 * PHASE 11 §24 — V2 compatibility suite: streaming zone.
 *
 * Contract table:
 *
 *   GigaChat V2 SSE ──streamingResponse──▶ OpenAI chunk stream
 *   (`data: {chat.completion.chunk}` frames + final `data: [DONE]`)
 *
 * The provider has no `[DONE]` (V2 uses response.message.done) — the connector
 * produces the OpenAI terminator itself (plan §12 "opencode"), like the legacy
 * path did.
 */
import { describe, expect, test } from "bun:test";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import { reasoningStream, textStream, toolStream } from "../../fixtures/streaming/sse";

const noop = (): void => {};

interface Delta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

function chunk(f: unknown): {
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
} {
  return f as { choices?: Array<{ delta?: Delta; finish_reason?: string | null }> };
}

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

function parseDataLines(sseText: string): unknown[] {
  const frames: unknown[] = [];
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    frames.push(JSON.parse(payload) as unknown);
  }
  return frames;
}

describe("§24 streaming zone — OpenAI chunk contract", () => {
  test("text stream → content deltas, finish chunk, [DONE]", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const sse = await collectText(
      pipeline.streamingResponse(new Response(byteStream(textStream)), "stream-sess"),
    );

    const frames = parseDataLines(sse);
    expect(frames).toHaveLength(4); // 2 content deltas + finish + usage
    const content = frames
      .map((f) => chunk(f).choices?.[0]?.delta?.content)
      .filter((c): c is string => c !== undefined);
    expect(content).toEqual(["Привет", " мир!"]);

    // First chunk starts the assistant role; the third chunk carries finish,
    // the fourth is the trailing usage-only chunk.
    expect(chunk(frames[0]).choices?.[0]?.delta?.content).toBe("Привет");
    expect(chunk(frames[2]).choices?.[0]?.finish_reason).toBe("stop");
    expect(chunk(frames[3]).choices).toEqual([]);
    expect((frames[3] as { usage?: unknown }).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(sse).toContain("data: [DONE]");
  });

  test("reasoning stream → reasoning_content delta, then text delta", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const sse = await collectText(
      pipeline.streamingResponse(new Response(byteStream(reasoningStream)), "stream-sess"),
    );

    const frames = parseDataLines(sse);
    const reasoning = frames
      .map((f) => chunk(f).choices?.[0]?.delta?.reasoning_content)
      .filter((c): c is string => c !== undefined);
    const content = frames
      .map((f) => chunk(f).choices?.[0]?.delta?.content)
      .filter((c): c is string => c !== undefined);
    expect(reasoning).toEqual(["Размышляю..."]);
    expect(content).toEqual(["Ответ: 42"]);
    expect(chunk(frames[frames.length - 1]).choices?.[0]?.finish_reason).toBe("stop");
  });

  test("tool stream → function_call delta as OpenAI tool_calls, mapped finish_reason", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const sse = await collectText(
      pipeline.streamingResponse(new Response(byteStream(toolStream)), "stream-sess"),
    );

    const frames = parseDataLines(sse);
    const toolChunks = frames
      .map((f) => chunk(f).choices?.[0]?.delta?.tool_calls)
      .filter((c): c is NonNullable<Delta["tool_calls"]> => c !== undefined);
    expect(toolChunks).toHaveLength(1);
    const [call] = toolChunks[0];
    expect(call?.index).toBe(0);
    expect(call?.type).toBe("function");
    expect(call?.function?.name).toBe("get_weather");
    expect(call?.function?.arguments).toBe('{"city":"Moscow"}');
    expect((call?.id ?? "").length).toBeGreaterThan(0);
    expect(chunk(frames[frames.length - 1]).choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(sse).toContain("data: [DONE]");
  });
});
