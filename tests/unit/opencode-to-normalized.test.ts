/**
 * Unit tests: OpenAI-compatible request → normalized model.
 */
import { describe, expect, test } from "bun:test";
import { openCodeToNormalized } from "../../src/translation/opencode-to-normalized";
import {
  basicChatRequest,
  builtinToolRequest,
  imageContentRequest,
  jsonSchemaRequest,
  legacyFunctionRequest,
} from "../fixtures/requests/openai";

describe("opencode-to-normalized", () => {
  test("maps basic chat request preserving tool call ids, tool results and state", () => {
    const normalized = openCodeToNormalized({
      ...basicChatRequest,
      // Simulate a stored assistant message carrying V1 state.
      messages: [
        ...(basicChatRequest.messages ?? []).slice(0, 2),
        {
          ...(basicChatRequest.messages ?? [])[2],
          functions_state_id: "state-xyz",
        },
        ...(basicChatRequest.messages ?? []).slice(3),
      ],
    });

    expect(normalized.model).toBe("GigaChat-2-Max");
    expect(normalized.messages).toHaveLength(4);
    const assistant = normalized.messages[2];
    expect(assistant.role).toBe("assistant");
    expect(assistant.toolCalls).toEqual([
      { id: "call_weather_1", name: "get_weather", arguments: { city: "Moscow" } },
    ]);
    expect(assistant.stateId).toBe("state-xyz");
    const toolResult = normalized.messages[3];
    expect(toolResult.role).toBe("tool");
    expect(toolResult.toolCallId).toBe("call_weather_1");
    expect(toolResult.content).toEqual([
      { type: "tool_result", toolCallId: "call_weather_1", result: '{"temp":-5,"unit":"C"}' },
    ]);
    expect(normalized.tools).toEqual([
      {
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
    expect(normalized.toolChoice).toBe("auto");
    expect(normalized.temperature).toBe(0.7);
    expect(normalized.maxTokens).toBe(512);
    expect(normalized.topP).toBe(0.9);
    expect(normalized.stream).toBe(false);
  });

  test("maps image url content into a normalized image part", () => {
    const normalized = openCodeToNormalized(imageContentRequest);
    expect(normalized.messages[0].content).toEqual([
      { type: "text", text: "What is in this image?" },
      { type: "image", url: "https://example.com/pic.png", detail: "high" },
    ]);
  });

  test("maps legacy function_call and function role into tool calls and tool results", () => {
    const normalized = openCodeToNormalized(legacyFunctionRequest);
    const assistant = normalized.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls?.[0].name).toBe("math");
    expect(assistant.toolCalls?.[0].arguments).toEqual({ op: "add", a: 1, b: 1 });
    const result = normalized.messages[2];
    expect(result.role).toBe("tool");
    expect(result.content).toEqual([{ type: "tool_result", result: "2" }]);
    expect(normalized.tools).toEqual([
      { name: "math", description: "Math helper", parameters: { type: "object" } },
    ]);
  });

  test("maps response_format json_schema and reasoning_effort", () => {
    const normalized = openCodeToNormalized(jsonSchemaRequest);
    expect(normalized.responseFormat).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: { date: { type: "string" } } },
      strict: true,
    });
    expect(normalized.reasoning).toEqual({ effort: "high" });
    expect(normalized.toolChoice).toEqual({ functionName: "echo" });
  });

  test("maps tool_choice none string", () => {
    const normalized = openCodeToNormalized(builtinToolRequest);
    expect(normalized.toolChoice).toBe("none");
  });

  test("maps developer role to system (documented: no developer role in V2)", () => {
    const normalized = openCodeToNormalized({
      model: "GigaChat-2-Max",
      messages: [
        { role: "developer", content: "be concise" },
        { role: "user", content: "hi" },
      ],
    });
    expect(normalized.messages[0].role).toBe("system");
  });

  test("throws a controlled error on unsupported tool_choice required", () => {
    expect(() => openCodeToNormalized({ messages: [], tool_choice: "required" })).toThrow(
      /unsupported tool_choice "required"/,
    );
  });

  test("throws a controlled error on unsupported reasoning_effort", () => {
    expect(() => openCodeToNormalized({ messages: [], reasoning_effort: "extreme" })).toThrow(
      /unsupported reasoning_effort "extreme"/,
    );
  });
});
