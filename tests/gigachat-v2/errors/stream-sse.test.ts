/**
 * PHASE 11 §28 — malformed SSE stream suite (raw SSE → internal stream events).
 *
 * Rule: malformed response → controlled error (a stream `error` event, never a
 * throw/crash — agents.md §15: no "Cannot read properties of undefined").
 * Pipeline-level cases additionally assert the OpenAI surface still terminates
 * with `data: [DONE]` after a truncated stream.
 */
import { describe, expect, test } from "bun:test";
import { classifyEvent } from "../../../src/streaming/events";
import { SseParser } from "../../../src/streaming/parser";
import { type InternalStreamEvent, StreamStateMachine } from "../../../src/streaming/state";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import {
  emptyDataStream,
  malformedStream,
  truncatedStream,
  unknownEventStream,
} from "../../fixtures/streaming/sse";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function runStream(text: string): { events: InternalStreamEvent[]; errors: string[] } {
  const parser = new SseParser();
  const machine = new StreamStateMachine();
  const events: InternalStreamEvent[] = [];
  const errors: string[] = [];
  for (const sse of parser.push(text)) {
    for (const ev of machine.push(classifyEvent(sse))) {
      events.push(ev);
      if (ev.kind === "error") errors.push(ev.message);
    }
  }
  for (const sse of parser.flush()) {
    for (const ev of machine.push(classifyEvent(sse))) {
      events.push(ev);
      if (ev.kind === "error") errors.push(ev.message);
    }
  }
  return { events, errors };
}

describe("§28 malformed SSE stream — controlled errors", () => {
  test("unknown event → controlled error event, no crash", () => {
    const { events, errors } = runStream(unknownEventStream);
    expect(errors).toEqual([expect.stringMatching(/^unknown stream event "something\.else"/)]);
    expect(events).toEqual([{ kind: "error", message: errors[0] }]);
  });

  test("empty SSE event → controlled error event, no crash", () => {
    const { errors } = runStream(emptyDataStream);
    expect(errors).toEqual([expect.stringMatching(/malformed stream event:/)]);
  });

  test("duplicate done event → ignored, no crash", () => {
    const parser = new SseParser();
    const machine = new StreamStateMachine();
    const frames = parser.push(
      frame("response.message.done", { finish_reason: "stop" }) +
        frame("response.message.done", { finish_reason: "length" }),
    );
    const first = machine.push(classifyEvent(frames[0]));
    const second = machine.push(classifyEvent(frames[1]));
    expect(first.at(-1)).toMatchObject({ kind: "done", finishReason: "stop" });
    expect(second).toEqual([]);
  });

  test("truncated stream → controlled malformed error at EOF flush", () => {
    const { errors } = runStream(truncatedStream);
    expect(errors).toEqual([expect.stringMatching(/malformed stream event:/)]);
  });

  test("malformed JSON in an event → controlled error event, no crash", () => {
    const { errors } = runStream(malformedStream);
    expect(errors).toEqual([expect.stringMatching(/malformed stream event:/)]);
  });

  test("truncated stream still terminates with [DONE] on the OpenAI surface", async () => {
    const seen: string[] = [];
    const pipeline = createV2Pipeline({ onSseError: (m) => seen.push(m) });
    const upstream = new Response(new Blob([new TextEncoder().encode(truncatedStream)]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const out = pipeline.streamingResponse(upstream, "s-1");
    const body = await out.text();
    expect(seen).toEqual([expect.stringMatching(/malformed stream event:/)]);
    expect(body).toContain("data: [DONE]");
  });

  test("unexpected finish reason → done with null finishReason, no crash", () => {
    const { events, errors } = runStream(
      frame("response.message.done", { finish_reason: "mystery" }),
    );
    expect(errors).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "done", finishReason: null });
  });

  test("missing usage → no usage event, no crash", () => {
    const { events, errors } = runStream(frame("response.message.done", { finish_reason: "stop" }));
    expect(errors).toEqual([]);
    expect(events.find((e) => e.kind === "usage")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: "done", finishReason: "stop" });
  });

  test("unknown fields in payload → ignored, no crash", () => {
    const { events, errors } = runStream(
      frame("response.message.delta", {
        messages: [{ role: "assistant", content: [{ text: "ok", zz: [1] }] }],
        extra_field: "x",
      }),
    );
    expect(errors).toEqual([]);
    expect(events).toEqual([{ kind: "text", text: "ok" }]);
  });

  test("function_call null → controlled error event, no crash", () => {
    const { errors } = runStream(
      frame("response.message.delta", { messages: [{ content: [{ function_call: null }] }] }),
    );
    expect(errors).toEqual(["malformed stream event: function_call is not an object"]);
  });

  test("function_call without a name → controlled error event, no crash", () => {
    const { errors } = runStream(
      frame("response.message.delta", {
        messages: [{ content: [{ function_call: { arguments: { city: "Moscow" } } }] }],
      }),
    );
    expect(errors).toEqual(["malformed stream event: function_call without a name"]);
  });

  test("tool_execution null → controlled error event, no crash", () => {
    const { errors } = runStream(
      frame("response.message.delta", { messages: [{ content: [{ tool_execution: null }] }] }),
    );
    expect(errors).toEqual(["malformed stream event: tool_execution is not an object"]);
  });

  test("files non-array → skipped gracefully, no crash", () => {
    const { events, errors } = runStream(
      frame("response.message.delta", { messages: [{ content: [{ files: "nope" }] }] }),
    );
    expect(errors).toEqual([]);
    expect(events).toEqual([]);
  });
});
