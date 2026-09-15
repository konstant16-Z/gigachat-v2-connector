/**
 * Fixtures: GigaChat V2 SSE byte streams and payloads.
 *
 * Built with `frame()` so escaping cannot corrupt the JSON on the wire.
 * Payload shapes follow the confirmed contract facts (V2 content items,
 * keyed objects without `type`); the spec's internal anomalies are exercised
 * in dedicated fixtures (created_at as string, finish_reason "error").
 */

import type { V2ResponseContentItem } from "../../../src/gigachat/v2/types";
import type { StreamMessagePayload, StreamToolPayload } from "../../../src/streaming/events";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/* ------------------------------- text only ------------------------------- */

const textDeltas: StreamMessagePayload[] = [
  {
    message_id: "m-1",
    role: "assistant",
    content: [{ text: "Привет" }],
  },
  { content: [{ text: " мир!" }] },
];

export const textStream: string =
  textDeltas.map((p) => frame("response.message.delta", p)).join("") +
  frame("response.message.done", {
    model: "GigaChat-2-Max",
    created_at: "1700000000", // spec anomaly: string in SSE example
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });

/* ------------------------- reasoning then text ---------------------------- */

export const reasoningStream: string =
  frame("response.message.delta", {
    role: "assistant",
    reasoning_content: "Размышляю...",
  }) +
  frame("response.message.delta", {
    content: [{ text: "Ответ: 42" }],
  }) +
  frame("response.message.done", { finish_reason: "stop" });

/* ----------------------------- text → tool --------------------------------- */

export const toolStream: string =
  frame("response.message.delta", {
    role: "assistant",
    content: [
      { text: "Проверяю погоду" },
      { function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' } },
    ],
  }) + frame("response.message.done", { finish_reason: "function_call" });

/* ------------------------------ multiple tools ----------------------------- */

export const multiToolStream: string =
  frame("response.message.delta", {
    role: "assistant",
    content: [
      { function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' } },
      { function_call: { name: "get_time", arguments: '{"city":"Moscow"}' } },
    ],
  }) + frame("response.message.done", { finish_reason: "function_call" });

/* --------------------------- tool lifecycle events -------------------------- */

export const toolInProgress: StreamToolPayload = {
  tool: "image_generate",
  status: "in_progress",
};

export const toolCompleted: StreamToolPayload = {
  tool: "image_generate",
  status: "success",
  seconds_left: 0,
  censored: false,
};

export const toolEventsStream: string =
  frame("response.tool.in_progress", toolInProgress) +
  frame("response.tool.completed", toolCompleted);

/* ----------------------------- error finishes ------------------------------ */

/** finish_reason "error" — spec anomaly (not in the enum). */
export const errorFinishStream: string = frame("response.message.done", {
  finish_reason: "error",
});

/** finish_reason "function_call_error" — invalid tool arguments. */
export const callErrorFinishStream: string = frame("response.message.done", {
  finish_reason: "function_call_error",
});

/* ------------------------------- edge cases -------------------------------- */

export const emptyContentDeltaStream: string = frame("response.message.delta", {
  role: "assistant",
  content: [],
});

export const malformedStream: string = "event: response.message.delta\ndata: {oops\n\n";

export const unknownEventStream: string = 'event: something.else\ndata: {"a":1}\n\n';

export const emptyDataStream: string = "data:\n\n";

/** Frame cut mid-payload without a trailing blank line (EOF truncation). */
export const truncatedStream: string =
  'event: response.message.delta\ndata: {"content":[{"text":"Прив';

/* ------------------------- reused content part type ------------------------ */

export const sampleContentItem: V2ResponseContentItem = {
  text: "hello",
  files: [{ target: "image", id: "file-1", mime: "image/png" }],
};
