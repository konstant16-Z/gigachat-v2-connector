/**
 * Unit tests: GigaChat V2 response → normalized model.
 */
import { describe, expect, test } from "bun:test";
import type { ChatCompletionV2Response } from "../../src/gigachat/v2/types";
import { gigachatV2ToNormalized } from "../../src/translation/gigachat-v2-to-normalized";
import {
  blacklistV2Response,
  filesV2Response,
  specStateV2Response,
  toolCallV2Response,
} from "../fixtures/responses/v2";

describe("gigachat-v2-to-normalized", () => {
  test("maps text, tool_calls finish reason, usage and thread metadata", () => {
    const normalized = gigachatV2ToNormalized(toolCallV2Response);
    expect(normalized.created).toBe(1700000000);
    expect(normalized.model).toBe("GigaChat-2-Max");
    expect(normalized.metadata).toEqual({ thread_id: "thread-42" });

    const choice = normalized.choices[0];
    expect(choice.finishReason).toBe("tool_calls");
    expect(choice.message.content).toBe("Let me check.");
    expect(choice.message.toolCalls).toHaveLength(1);
    expect(choice.message.toolCalls?.[0]).toMatchObject({
      name: "get_weather",
      arguments: { city: "Moscow" },
    });
    expect(choice.message.stateId).toBe("state-abc-123");

    expect(normalized.usage).toEqual({
      promptTokens: 12,
      completionTokens: 20,
      totalTokens: 32,
      cachedTokens: 5,
    });
  });

  test("passes object arguments through and keeps the live function_call id", () => {
    const normalized = gigachatV2ToNormalized(toolCallV2Response);
    const call = normalized.choices[0].message.toolCalls?.[0];
    expect(call).toMatchObject({
      id: "fc-live-1",
      name: "get_weather",
      arguments: { city: "Moscow" },
    });
  });

  test("reads tool_state_id (live) and falls back to spec tools_state_id", () => {
    const live = gigachatV2ToNormalized(toolCallV2Response);
    expect(live.choices[0].message.stateId).toBe("state-abc-123");

    const spec = gigachatV2ToNormalized(specStateV2Response);
    expect(spec.choices[0].message.stateId).toBe("state-spec-9");
  });

  test("preserves files, tool_execution and inline_data without dropping content", () => {
    const normalized = gigachatV2ToNormalized(filesV2Response);
    const message = normalized.choices[0].message;
    expect(message.content).toBe("Here is your image:");
    expect(message.contentParts).toEqual([
      { type: "text", text: "Here is your image:" },
      { type: "file", id: "file-1", target: "image", mime: "image/png" },
      {
        type: "tool_result",
        name: "image_generate",
        result: JSON.stringify({ status: "success", seconds_left: 0, censored: false }),
      },
    ]);
  });

  test("maps blacklist finish_reason to content_filter", () => {
    const normalized = gigachatV2ToNormalized(blacklistV2Response);
    expect(normalized.choices[0].finishReason).toBe("content_filter");
  });

  test("throws a controlled error on malformed function_call arguments JSON", () => {
    const broken: ChatCompletionV2Response = {
      ...toolCallV2Response,
      messages: [
        {
          role: "assistant",
          content: [{ function_call: { name: "f", arguments: "{oops" } }],
        },
      ],
    };
    expect(() => gigachatV2ToNormalized(broken)).toThrow(/malformed tool arguments JSON/);
  });
});
