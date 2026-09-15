/**
 * Unit tests: internal stream events → OpenAI chunks + SSE body (plan §12 —
 * opencode surface).
 */
import { describe, expect, test } from "bun:test";
import { internalToOpenAiChunks, openCodeSseBody } from "../../src/streaming/opencode";
import type { InternalStreamEvent } from "../../src/streaming/state";

const meta = { model: "GigaChat-2-Max", id: "chatcmp-test", created: 1700000000 };

const textOnly: InternalStreamEvent[] = [
  { kind: "text", text: "Привет" },
  { kind: "text", text: " мир!" },
  { kind: "done", finishReason: "stop", model: "GigaChat-2-Max" },
];

describe("internal → OpenAI chunks", () => {
  test("emits role on first text chunk and finish_reason on done", () => {
    const { chunks, errors } = internalToOpenAiChunks(textOnly, meta);
    expect(errors).toEqual([]);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "Привет" });
    expect(chunks[1].choices[0].delta).toEqual({ content: " мир!" });
    expect(chunks[2].choices[0].delta).toEqual({});
    expect(chunks[2].choices[0].finish_reason).toBe("stop");
  });

  test("maps tool calls to chunks with stable id and string arguments", () => {
    const { chunks } = internalToOpenAiChunks(
      [
        {
          kind: "tool_call",
          callId: "call_1",
          name: "get_weather",
          arguments: '{"city":"Moscow"}',
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      meta,
    );
    expect(chunks[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
      },
    ]);
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  });

  test("maps reasoning to reasoning_content delta", () => {
    const { chunks } = internalToOpenAiChunks(
      [
        { kind: "reasoning", text: "думаю" },
        { kind: "done", finishReason: "stop" },
      ],
      meta,
    );
    expect(chunks[0].choices[0].delta.reasoning_content).toBe("думаю");
  });

  test("usage and tool_completed produce no chunks", () => {
    const { chunks } = internalToOpenAiChunks(
      [
        { kind: "usage", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
        { kind: "tool_completed", name: "image_generate", status: "success" },
        { kind: "done", finishReason: "stop" },
      ],
      meta,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].finish_reason).toBe("stop");
  });

  test("error events are surfaced in the result, not fabricated as chunks", () => {
    const { chunks, errors } = internalToOpenAiChunks(
      [
        { kind: "text", text: "ok" },
        { kind: "error", message: 'unknown stream event "x"' },
        { kind: "done", finishReason: "stop" },
      ],
      meta,
    );
    expect(errors).toEqual(['unknown stream event "x"']);
    expect(chunks.map((c) => c.choices[0].delta.content)).toEqual(["ok", undefined]);
  });

  test("openCodeSseBody emits chunks and terminates with [DONE]", () => {
    const { chunks } = internalToOpenAiChunks(textOnly, meta);
    const body = openCodeSseBody(chunks);
    const lines = body.split("\n\n").filter(Boolean);
    expect(lines).toHaveLength(chunks.length + 1);
    expect(lines.at(-1)).toBe("data: [DONE]");
    expect(lines[0]).toContain('"object":"chat.completion.chunk"');
  });
});
