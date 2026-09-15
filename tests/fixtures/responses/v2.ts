/**
 * Fixtures: GigaChat V2 responses (request paths come from the official spec
 * examples in docs/external/gigachat-api.yml).
 */
import type { ChatCompletionV2Response } from "../../../src/gigachat/v2/types";

export const toolCallV2Response: ChatCompletionV2Response = {
  model: "GigaChat-2-Max",
  thread_id: "thread-42",
  created_at: 1700000000,
  finish_reason: "function_call",
  messages: [
    {
      role: "assistant",
      tools_state_id: "state-abc-123",
      content: [
        { text: "Let me check." },
        { function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' } },
      ],
    },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 20,
    total_tokens: 32,
    input_tokens_details: { cached_tokens: 5 },
  },
};

export const filesV2Response: ChatCompletionV2Response = {
  model: "GigaChat-3-Ultra",
  created_at: 1700000001,
  finish_reason: "stop",
  messages: [
    {
      role: "assistant",
      content: [
        { text: "Here is your image:" },
        { files: [{ target: "image", id: "file-1", mime: "image/png" }] },
        {
          tool_execution: {
            name: "image_generate",
            status: "success",
            seconds_left: 0,
            censored: false,
          },
        },
      ],
    },
  ],
};

export const blacklistV2Response: ChatCompletionV2Response = {
  model: "GigaChat-2-Max",
  created_at: 1700000002,
  finish_reason: "request_blacklist",
  messages: [{ role: "assistant", content: [{ text: "Request filtered" }] }],
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
};