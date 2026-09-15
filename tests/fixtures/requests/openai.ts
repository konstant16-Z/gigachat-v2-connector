/**
 * Fixture: a complete OpenAI-compatible request with all roles and a legacy
 * function message — proxy for what OpenCode sends.
 */
import type { OpenAiChatBody } from "../../../src/types/gigachat";

export const basicChatRequest: OpenAiChatBody = {
  model: "GigaChat-2-Max",
  messages: [
    {
      role: "system",
      content: "You are a helpful assistant.",
    },
    {
      role: "user",
      content: "What is the weather in Moscow?",
    },
    {
      role: "assistant",
      content: "I will check the weather service.",
      tool_calls: [
        {
          id: "call_weather_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_weather_1",
      content: '{"temp":-5,"unit":"C"}',
    },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
  tool_choice: "auto",
  temperature: 0.7,
  max_tokens: 512,
  top_p: 0.9,
  stream: false,
};

export const legacyFunctionRequest: OpenAiChatBody = {
  model: "GigaChat-2-Pro",
  messages: [
    { role: "user", content: "Is 1+1=2?" },
    {
      role: "assistant",
      function_call: { name: "math", arguments: '{"op":"add","a":1,"b":1}' },
    },
    { role: "function", name: "math", content: "2" },
  ],
  functions: [
    { name: "math", description: "Math helper", parameters: { type: "object" } },
  ],
};

export const imageContentRequest: OpenAiChatBody = {
  model: "GigaChat-2-Max",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/pic.png", detail: "high" },
        },
      ],
    },
  ],
};

export const jsonSchemaRequest: OpenAiChatBody = {
  model: "GigaChat-2-Max",
  messages: [{ role: "user", content: "Extract a date" }],
  response_format: {
    type: "json_schema",
    json_schema: {
      schema: { type: "object", properties: { date: { type: "string" } } },
      strict: true,
    },
  },
  reasoning_effort: "high",
  tools: [
    {
      type: "function",
      function: { name: "echo", description: "Echo", parameters: { type: "object" } },
    },
  ],
  tool_choice: { function: { name: "echo" } },
};

export const builtinToolRequest: OpenAiChatBody = {
  model: "GigaChat-2-Max",
  messages: [{ role: "user", content: "Draw a cat" }],
  tools: [
    {
      type: "function",
      function: { name: "paint", parameters: { type: "object" } },
    },
  ],
  tool_choice: "none",
};