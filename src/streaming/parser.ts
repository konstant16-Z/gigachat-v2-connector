/**
 * Incremental Server-Sent Events (SSE) frame parser (plan §12 "parser").
 *
 * Pure state machine over raw byte/chunk input: buffers partial lines across
 * chunk boundaries, handles `\r\n`/`\n`, multi-line `data:`, `event:`, `id:`,
 * `retry:`, `:` comments and blank-line frame dispatch. Never throws on broken
 * input (agents.md §15: must not crash with "Cannot read properties of
 * undefined"); opaque fields and invalid lines are ignored.
 *
 * A trailing frame without a blank line (EOF truncation / connection
 * interruption) is discharged by `flush()` with `finished: false` so upper
 * layers can attempt a parse and surface a controlled error.
 */

export interface SseEvent {
  /** Event type; defaults to "message" when no `event:` field was present. */
  event: string;
  /** Accumulated `data:` lines joined with "\n". */
  data: string;
  /** Last event id (when `id:` was present). */
  id?: string;
  /** Reconnect time in ms (when `retry:` was present). */
  retry?: number;
  /** true when the frame ended with a blank line; false for EOF-flushed tails. */
  finished: boolean;
}

export class SseParser {
  private buffer = "";
  private eventType: string | undefined;
  private dataLines: string[] = [];
  private eventId: string | undefined;
  private retry: number | undefined;

  /** Feed a new chunk of text; returns any complete frames it closed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    const newline = /\r\n|\n/;
    for (;;) {
      const match = newline.exec(this.buffer);
      if (match === null) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Signal end-of-stream: discharge any pending frame (truncated stream). */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    if (this.dataLines.length > 0 || this.eventType !== undefined || this.eventId !== undefined) {
      events.push(this.dispatchFrame(false));
    }
    return events;
  }

  private processLine(line: string): SseEvent | null {
    if (line === "") {
      // Frame boundary. A blank line with nothing pending is a no-op
      // (keep-alive heartbeat); only frames carrying fields are dispatched.
      if (
        this.dataLines.length === 0 &&
        this.eventType === undefined &&
        this.eventId === undefined
      ) {
        return null;
      }
      return this.dispatchFrame(true);
    }
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    if (colon === -1) return null; // field name without value is ignored
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        // Per WHATWG: only the first event field of a frame wins.
        if (this.eventType === undefined) this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) this.eventId = value;
        break;
      case "retry": {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) this.retry = n;
        break;
      }
      // Unknown fields are ignored per the SSE spec.
    }
    return null;
  }

  private dispatchFrame(finished: boolean): SseEvent {
    let data = this.dataLines.join("\n");
    if (data.endsWith("\n")) data = data.slice(0, -1);
    const ev: SseEvent = {
      event: this.eventType ?? "message",
      data,
      finished,
    };
    if (this.eventId !== undefined) ev.id = this.eventId;
    if (this.retry !== undefined) ev.retry = this.retry;
    this.eventType = undefined;
    this.dataLines = [];
    this.eventId = undefined;
    this.retry = undefined;
    return ev;
  }
}
