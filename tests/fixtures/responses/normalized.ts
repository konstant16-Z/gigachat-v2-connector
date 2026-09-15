/**
 * Fixtures: expected normalized response shapes for response-side mapping
 * tests. Randomized ids (uuid) are asserted only loosely in the tests.
 */
import type { NormalizedResponse } from "../../../src/core/types";
import { blacklistV2Response, filesV2Response, toolCallV2Response } from "./v2";

export const toolCallNormalized: NormalizedResponse = {
  id: "ignored-by-test",
  created: toolCallV2Response.created_at,
  model: "GigaChat-2-Max",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Let me check.",
        contentParts: [{ type: "text", text: "Let me check." }],
        toolCalls: [
          {
            id: "ignored-by-test",
            name: "get_weather",
            arguments: { city: "Moscow" },
          },
        ],
        stateId: "state-abc-123",
      },
      finishReason: "tool_calls",
    },
  ],
  usage: {
    promptTokens: 12,
    completionTokens: 20,
    totalTokens: 32,
    cachedTokens: 5,
  },
  metadata: { thread_id: "thread-42" },
};

export const filesNormalized: NormalizedResponse = {
  id: "ignored-by-test",
  created: filesV2Response.created_at,
  model: "GigaChat-3-Ultra",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Here is your image:",
        contentParts: [
          { type: "text", text: "Here is your image:" },
          { type: "file", id: "file-1", target: "image", mime: "image/png" },
          {
            type: "tool_result",
            name: "image_generate",
            result: JSON.stringify({
              status: "success",
              seconds_left: 0,
              censored: false,
            }),
          },
        ],
      },
      finishReason: "stop",
    },
  ],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};

export const blacklistNormalizedFinishReason: string = "content_filter";

export { blacklistV2Response, filesV2Response, toolCallV2Response };
