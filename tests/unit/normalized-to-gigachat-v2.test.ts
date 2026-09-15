/**
 * Unit tests: normalized model → GigaChat V2 request.
 */
import { describe, expect, test } from "bun:test";
import type { NormalizedRequest } from "../../src/core/types";
import { normalizedToGigaChatV2 } from "../../src/translation/normalized-to-gigachat-v2";
import { basicChatNormalized, jsonSchemaNormalized } from "../fixtures/requests/normalized";

describe("normalized-to-gigachat-v2", () => {
  test("throws a controlled error when model is missing", () => {
    expect(() => normalizedToGigaChatV2({ messages: [] })).toThrow(
      /refusing to guess a default model/,
    );
  });

  test("maps text, tool results and tool calls into keyed V2 content items", () => {
    const v2 = normalizedToGigaChatV2(basicChatNormalized);
    expect(v2.model).toBe("GigaChat-2-Max");
    expect(v2.stream).toBe(false);

    // assistant message: text + function_call
    const assistant = v2.messages[2];
    expect(assistant.content).toEqual([
      { text: "I will check the weather service." },
      { function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' } },
    ]);

    // tool message: function_result with the resolved name
    const tool = v2.messages[3];
    expect(tool.content).toEqual([
      { function_result: { name: "get_weather", result: '{"temp":-5,"unit":"C"}' } },
    ]);
  });

  test("maps tool_state_id when a message carries state", () => {
    const v2 = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          stateId: "state-zzz",
        },
      ],
    });
    expect(v2.messages[0].tool_state_id).toBe("state-zzz");
  });

  test("maps model_options from normalized sampling params", () => {
    const v2 = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [],
      temperature: 0.5,
      topP: 0.8,
      maxTokens: 256,
      repetitionPenalty: 1.1,
    });
    expect(v2.model_options).toEqual({
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 256,
      repetition_penalty: 1.1,
    });
  });

  test("maps json_schema response_format into model_options.response_format", () => {
    const v2 = normalizedToGigaChatV2(jsonSchemaNormalized);
    expect(v2.model_options?.response_format).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: { date: { type: "string" } } },
      strict: true,
    });
    expect(v2.tool_config).toEqual({ mode: "forced", function_name: "echo" });
  });

  test("maps tool_choice none to tool_config.mode none", () => {
    const v2 = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [],
      toolChoice: "none",
    });
    expect(v2.tool_config).toEqual({ mode: "none" });
  });

  test("defaults tool_config.mode to auto when tools are declared", () => {
    const v2 = normalizedToGigaChatV2(basicChatNormalized);
    expect(v2.tool_config).toEqual({ mode: "auto" });
    expect(v2.tools).toEqual([
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

  test("maps builtin tools and unknown builtins raise a controlled error", () => {
    const v2 = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [],
      tools: [{ name: "b", builtin: "image_generate" }],
    });
    expect(v2.tools).toEqual([{ image_generate: {} }]);

    expect(() =>
      normalizedToGigaChatV2({
        model: "GigaChat-2-Max",
        messages: [],
        tools: [{ name: "b", builtin: "web_search" }],
      }),
    ).toThrow(/unknown builtin tool "web_search"/);
  });

  test("throws a controlled error on image parts (deferred to PHASE 6)", () => {
    expect(() =>
      normalizedToGigaChatV2({
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "user",
            content: [{ type: "image", url: "https://x/y.png" }],
          },
        ],
      }),
    ).toThrow(/PHASE 6/);
  });

  test("throws a controlled error when a tool result name cannot be resolved", () => {
    expect(() =>
      normalizedToGigaChatV2({
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "unknown-id", result: "{}" }],
          },
        ],
      }),
    ).toThrow(/without a resolvable function name/);
  });

  test("does not emit tool_config or tools when absent", () => {
    const v2 = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(v2.tool_config).toBeUndefined();
    expect(v2.tools).toBeUndefined();

    // sanity: this must typecheck as a valid V2 request
    const _check: import("../../src/gigachat/v2/types").ChatCompletionV2Request = v2;
    void _check;
  });
});

// Keep a typed fixture reference to ensure fixture and mapper agree.
const _fixture: NormalizedRequest = basicChatNormalized;
void _fixture;
