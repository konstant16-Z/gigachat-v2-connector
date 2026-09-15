/**
 * Fixtures: expected normalized shapes for the request-side mapping tests.
 */
import type { NormalizedRequest } from "../../../src/core/types";
import { basicChatRequest, jsonSchemaRequest, legacyFunctionRequest } from "./openai";

export const basicChatNormalized: NormalizedRequest = {
  model: "GigaChat-2-Max",
  messages: [
    { role: "system", content: [{ type: "text", text: "You are a helpful assistant." }] },
    { role: "user", content: [{ type: "text", text: "What is the weather in Moscow?" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "I will check the weather service." }],
      toolCalls: [
        {
          id: "call_weather_1",
          name: "get_weather",
          arguments: { city: "Moscow" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "call_weather_1",
          result: '{"temp":-5,"unit":"C"}',
        },
      ],
    },
  ],
  tools: [
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
  toolChoice: "auto",
  temperature: 0.7,
  maxTokens: 512,
  topP: 0.9,
  stream: false,
};

export const legacyFunctionNormalized: NormalizedRequest = {
  model: "GigaChat-2-Pro",
  messages: [
    { role: "user", content: [{ type: "text", text: "Is 1+1=2?" }] },
    {
      role: "assistant",
      content: [],
      // id generated at runtime — match by name/arguments in the test.
      toolCalls: [{ id: "legacy-manual-id", name: "math", arguments: { op: "add", a: 1, b: 1 } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", result: "2" }],
    },
  ],
  tools: [{ name: "math", description: "Math helper", parameters: { type: "object" } }],
};

export const jsonSchemaNormalized: NormalizedRequest = {
  model: "GigaChat-2-Max",
  messages: [{ role: "user", content: [{ type: "text", text: "Extract a date" }] }],
  responseFormat: {
    type: "json_schema",
    schema: { type: "object", properties: { date: { type: "string" } } },
    strict: true,
  },
  reasoning: { effort: "high" },
  tools: [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
  toolChoice: { functionName: "echo" },
};

export { basicChatRequest, jsonSchemaRequest, legacyFunctionRequest };