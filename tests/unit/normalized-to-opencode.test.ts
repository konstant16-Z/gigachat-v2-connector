/**
 * Unit tests: normalized model → OpenAI-compatible response (OpenCode surface).
 */
import { describe, expect, test } from "bun:test";
import { normalizedToOpenCode } from "../../src/translation/normalized-to-opencode";
import { toolCallNormalized } from "../fixtures/responses/normalized";

describe("normalized-to-opencode", () => {
  test("builds an OpenAI completion with tool_calls and usage", () => {
    const completion = normalizedToOpenCode(toolCallNormalized);
    expect(completion.object).toBe("chat.completion");
    expect(completion.created).toBe(1700000000);
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect(completion.choices[0].message.content).toBe("Let me check.");
    expect(completion.choices[0].message.tool_calls).toEqual([
      {
        id: "ignored-by-test",
        index: 0,
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
      },
    ]);
    expect(completion.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 20,
      total_tokens: 32,
    });
  });

  test("surfaces normalized stateId as functions_state_id for the OpenCode round-trip", () => {
    const completion = normalizedToOpenCode(toolCallNormalized);
    expect(completion.choices[0].message.functions_state_id).toBe("state-abc-123");
  });

  test("serializes empty arguments to an empty JSON object string", () => {
    const completion = normalizedToOpenCode({
      ...toolCallNormalized,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "c1", name: "noop", arguments: undefined }],
          },
          finishReason: "tool_calls",
        },
      ],
    });
    expect(completion.choices[0].message.tool_calls![0].function.arguments).toBe("{}");
  });
});