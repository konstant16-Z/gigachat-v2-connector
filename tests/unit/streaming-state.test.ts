/**
 * Unit tests: SSE pipeline → internal stream events (plan §12 — state machine).
 * Full pipeline: raw SSE text → SseParser → classifyEvent → StreamStateMachine.
 */
import { describe, expect, test } from "bun:test";
import { SseParser } from "../../src/streaming/parser";
import { classifyEvent } from "../../src/streaming/events";
import { StreamStateMachine, type InternalStreamEvent } from "../../src/streaming/state";
import {
  callErrorFinishStream,
  emptyContentDeltaStream,
  emptyDataStream,
  errorFinishStream,
  malformedStream,
  multiToolStream,
  reasoningStream,
  textStream,
  toolEventsStream,
  toolStream,
  truncatedStream,
  unknownEventStream,
} from "../fixtures/streaming/sse";

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

describe("stream state machine", () => {
  test("text only: text deltas then done with usage and stop", () => {
    const { events, errors } = runStream(textStream);
    expect(errors).toEqual([]);
    expect(events.filter((e) => e.kind === "text")).toEqual([
      { kind: "text", text: "Привет" },
      { kind: "text", text: " мир!" },
    ]);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toEqual({
      kind: "usage",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "stop", model: "GigaChat-2-Max" });
  });

  test("reasoning then text", () => {
    const { events } = runStream(reasoningStream);
    expect(events[0]).toEqual({ kind: "reasoning", text: "Размышляю..." });
    expect(events[1]).toEqual({ kind: "text", text: "Ответ: 42" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "stop", model: undefined });
  });

  test("text → tool: tool_call event and done tool_calls", () => {
    const { events } = runStream(toolStream);
    const call = events.find((e) => e.kind === "tool_call");
    expect(call).toEqual({
      kind: "tool_call",
      callId: "call_1",
      name: "get_weather",
      arguments: '{"city":"Moscow"}',
    });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "tool_calls", model: undefined });
  });

  test("multiple parallel tools get distinct stable call ids", () => {
    const { events } = runStream(multiToolStream);
    const calls = events.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ callId: "call_1", name: "get_weather" });
    expect(calls[1]).toMatchObject({ callId: "call_2", name: "get_time" });
  });

  test("tool lifecycle events become tool_completed; in_progress maps to nothing", () => {
    const { events } = runStream(toolEventsStream);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool_completed",
      name: "image_generate",
      status: "success",
      seconds_left: 0,
      censored: false,
    });
  });

  test("empty delta produces no internal events", () => {
    const { events } = runStream(emptyContentDeltaStream);
    expect(events).toEqual([]);
  });

  test("unknown event → controlled error, stream continues", () => {
    const parser = new SseParser();
    const machine = new StreamStateMachine();
    const first = machine.push(classifyEvent(parser.push(unknownEventStream)[0]));
    expect(first[0]).toEqual({ kind: "error", message: 'unknown stream event "something.else"' });
    const done = machine.push(
      classifyEvent(parser.push('event: response.message.done\ndata: {"finish_reason":"stop"}\n\n')[0]),
    );
    expect(done.at(-1)?.kind).toBe("done");
  });

  test("malformed event → controlled error", () => {
    const { errors } = runStream(malformedStream);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/malformed stream event/);
  });

  test("empty data frame → malformed event", () => {
    const { errors } = runStream(emptyDataStream);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/invalid or empty JSON/);
  });

  test("truncated stream at EOF → malformed event (flush tail)", () => {
    const { errors } = runStream(truncatedStream);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/malformed stream event/);
  });

  test('finish_reason "error" (spec anomaly) → error event + finishReason null', () => {
    const { events, errors } = runStream(errorFinishStream);
    expect(errors).toEqual(['stream finished with finish_reason "error"']);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: null, model: undefined });
  });

  test("finish_reason function_call_error → error event + finishReason stop", () => {
    const { events, errors } = runStream(callErrorFinishStream);
    expect(errors).toEqual(['stream finished with finish_reason "function_call_error"']);
    expect(events.at(-1)?.kind).toBe("done");
    expect(events.at(-1)).toMatchObject({ finishReason: "stop" });
  });

  test("duplicate done and post-done events are ignored", () => {
    const parser = new SseParser();
    const machine = new StreamStateMachine();
    const dones = parser.push(
      'event: response.message.done\ndata: {"finish_reason":"stop"}\n\n' +
        'event: response.message.done\ndata: {"finish_reason":"length"}\n\n',
    );
    const first = machine.push(classifyEvent(dones[0]));
    const second = machine.push(classifyEvent(dones[1]));
    expect(first.at(-1)).toMatchObject({ finishReason: "stop" });
    expect(second).toEqual([]);
  });
});