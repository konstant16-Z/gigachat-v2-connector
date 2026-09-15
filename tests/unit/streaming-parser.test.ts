/**
 * Unit tests: incremental SSE parser (plan §12 — parser behaviors).
 */
import { describe, expect, test } from "bun:test";
import { type SseEvent, SseParser } from "../../src/streaming/parser";

function parseAll(text: string, chunkSize?: number): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  if (chunkSize === undefined) {
    events.push(...parser.push(text));
  } else {
    for (let i = 0; i < text.length; i += chunkSize) {
      events.push(...parser.push(text.slice(i, i + chunkSize)));
    }
  }
  events.push(...parser.flush());
  return events;
}

describe("SseParser", () => {
  test("parses event and data fields into frames", () => {
    const events = parseAll(
      'event: response.message.delta\ndata: {"text":"hi"}\n\n' +
        'event: response.message.done\ndata: {"finish_reason":"stop"}\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("response.message.delta");
    expect(events[0].data).toBe('{"text":"hi"}');
    expect(events[0].finished).toBe(true);
    expect(events[1].event).toBe("response.message.done");
  });

  test("defaults event type to message when absent", () => {
    const events = parseAll('data: {"a":1}\n\n');
    expect(events[0].event).toBe("message");
  });

  test("handles CRLF line endings", () => {
    const events = parseAll('event: response.message.delta\r\ndata: {"a":1}\r\n\r\n');
    expect(events[0].data).toBe('{"a":1}');
  });

  test("joins multi-line data with newlines", () => {
    const events = parseAll('data: {"a":1}\ndata: ,"b":2}\n\n');
    expect(events[0].data).toBe('{"a":1}\n,"b":2}');
  });

  test("buffers partial frames across push calls", () => {
    const parser = new SseParser();
    parser.push('event: response.message.delta\ndata: {"tex');
    expect(parser.push('t":"hi"}\n\n')).toHaveLength(1);
  });

  test("ignores comment lines and unknown fields", () => {
    const events = parseAll(
      ": keep-alive\n" +
        "unknown: field\n" +
        "event: response.message.delta\n" +
        'data: {"a":1}\n' +
        "no-colon-line\n\n",
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"a":1}');
  });

  test("bare blank lines (heartbeat) dispatch nothing", () => {
    const events = parseAll("\n\n");
    expect(events).toEqual([]);
  });

  test("data-only empty value is dispatched (empty event)", () => {
    const events = parseAll("data:\n\n");
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("");
  });

  test("flush discharges a truncated tail before EOF (interruption)", () => {
    const parser = new SseParser();
    parser.push('event: response.message.delta\ndata: {"content":[{"text":"Прив');
    const events = parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("response.message.delta");
    expect(events[0].data).toBe('{"content":[{"text":"Прив');
    expect(events[0].finished).toBe(false);
  });

  test("captures id and retry fields", () => {
    const events = parseAll("id: evt-1\nretry: 5000\ndata: x\n\n");
    expect(events[0].id).toBe("evt-1");
    expect(events[0].retry).toBe(5000);
  });

  test("never throws on garbage input", () => {
    const parser = new SseParser();
    expect(() => parser.push("\u0000\u0001\x00\xff broken \n nothing")).not.toThrow();
    expect(parser.flush()).toBeArray();
  });
});
