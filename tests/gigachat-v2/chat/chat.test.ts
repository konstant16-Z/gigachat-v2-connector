/**
 * PHASE 11 §24 — V2 compatibility suite: chat zone.
 *
 * Contract table:
 *
 *   OpenAI chat body ──chatRequest──▶ expected GigaChat V2 wire request
 *   fake GigaChat V2 response ──jsonResponse──▶ expected OpenCode completion
 *
 * Wire facts pinned here (docs/LIVE_API_OBSERVATIONS.md):
 * - roles pass through; tool results use the live `function` role on the wire;
 * - `function_call.arguments` is an object (a JSON string is rejected by the
 *   live API); `function_result.result` is a JSON value wrapped in a string;
 * - samplers map into `model_options`; `tool_choice auto` becomes explicit.
 */
import { describe, expect, test } from "bun:test";
import type { ChatCompletionV2Response } from "../../../src/gigachat/v2/types";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import { basicChatRequest } from "../../fixtures/requests/openai";

const noop = (): void => {};

const textV2Response: ChatCompletionV2Response = {
  model: "GigaChat-2-Max",
  created_at: 1700000000,
  finish_reason: "stop",
  messages: [{ role: "assistant", content: [{ text: "Привет, Москва!" }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

describe("§24 chat zone — request wire contract", () => {
  test("basic chat body with tool round-trip → expected V2 wire request", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const wire = await pipeline.chatRequest(basicChatRequest, "chat-sess");

    expect(wire.model).toBe("GigaChat-2-Max");
    expect(wire.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "function"]);
    expect(wire.messages[0].content).toEqual([{ text: "You are a helpful assistant." }]);
    expect(wire.messages[1].content).toEqual([{ text: "What is the weather in Moscow?" }]);
    // assistant tool_calls → wired as function_call with OBJECT arguments
    expect(wire.messages[2].content).toEqual([
      { text: "I will check the weather service." },
      { function_call: { name: "get_weather", arguments: { city: "Moscow" } } },
    ]);
    // tool role → wire `function` role; the result is a JSON value re-wrapped
    // in a string (live API 400 on raw text) — the parsed wire value equals
    // the original tool text exactly.
    expect(wire.messages[3].content).toEqual([
      {
        function_result: { name: "get_weather", result: JSON.stringify('{"temp":-5,"unit":"C"}') },
      },
    ]);
    expect(wire.model_options).toEqual({ temperature: 0.7, max_tokens: 512, top_p: 0.9 });
    expect(wire.stream).toBe(false);
    expect(wire.tool_config).toEqual({ mode: "auto" });
    expect(wire.tools).toEqual([
      {
        functions: {
          specifications: [
            {
              name: "get_weather",
              description: "Get current weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
        },
      },
    ]);
  });

  test("developer role maps to system (no V2 developer role)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const wire = await pipeline.chatRequest(
      { model: "GigaChat-2-Max", messages: [{ role: "developer", content: "Be brief" }] },
      "chat-sess",
    );
    expect(wire.messages[0].role).toBe("system");
    expect(wire.messages[0].content).toEqual([{ text: "Be brief" }]);
  });

  test("missing model → controlled error (no silent default)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    await expect(
      pipeline.chatRequest({ messages: [{ role: "user", content: "hi" }] }, "chat-sess"),
    ).rejects.toThrow(/V2 request requires `model`/);
  });
});

describe("§24 chat zone — response wire contract", () => {
  test("text response → expected OpenCode completion", () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const out = pipeline.jsonResponse(textV2Response, "chat-sess");

    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("GigaChat-2-Max");
    expect(out.choices).toHaveLength(1);
    expect(out.choices[0].index).toBe(0);
    expect(out.choices[0].message.role).toBe("assistant");
    expect(out.choices[0].message.content).toBe("Привет, Москва!");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});
