/**
 * GigaChat V2 SSE state machine (plan §12 "state").
 *
 * Pipeline: GigaChatStreamEvent → StreamStateMachine → InternalStreamEvent.
 *
 * The minimal internal model follows the plan: TextDelta / ReasoningDelta /
 * ToolCallDelta / ToolCompleted / Usage / Done / Error. Duplicate trailing
 * events and post-done input are ignored; unknown/malformed events become
 * controlled `error` events instead of crashes (agents.md §15).
 */

import type { NormalizedUsage } from "../core/types";
import { toOpenAiFinishReason } from "../gigachat/v2/finish-reason";
import type { V2ResponseUsage } from "../gigachat/v2/types";
import type { GigaChatStreamEvent, StreamMessagePayload } from "./events";

export type InternalStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; callId: string; name: string; arguments: string }
  | {
      kind: "tool_completed";
      name?: string;
      status?: string;
      seconds_left?: number;
      censored?: boolean;
    }
  | { kind: "usage"; usage: NormalizedUsage }
  | { kind: "done"; finishReason: string | null; model?: string }
  | { kind: "error"; message: string };

export class StreamStateMachine {
  private role: string | undefined;
  private messageId: string | undefined;
  private model: string | undefined;
  private created: number | string | undefined;
  private doneEmitted = false;
  private usageEmitted = false;
  private callCounter = 0;
  private pendingCalls = new Map<string, { name: string; args: string }>();
  /** Function-call names already surfaced via deltas (dedupe done payload). */
  private emittedCallNames = new Set<string>();

  /** Last file ids seen in deltas (kept for the aggregated message; PHASE 7). */
  public lastFileIds: string[] = [];

  /** Latest `tools_state_id` from `response.message.done` (PHASE 4 capture). */
  public lastToolsStateId: string | undefined;

  /** Model name from the stream meta; undefined until a delta carries it. */
  get modelName(): string | undefined {
    return this.model;
  }

  /** `created_at` from the stream meta; undefined until a delta carries it. */
  get createdAt(): number | string | undefined {
    return this.created;
  }

  /** Feed a classified stream event; returns zero or more internal events. */
  push(event: GigaChatStreamEvent): InternalStreamEvent[] {
    if (this.doneEmitted) return [];
    switch (event.kind) {
      case "delta":
        return this.onDelta(event.payload);
      case "done":
        return this.onDone(event.payload);
      case "tool_in_progress":
        // Informational only — no OpenAI-compatible delta exists for it
        // (documented; progress is also visible via tool_completed).
        return [];
      case "tool_completed": {
        const t = event.payload;
        const name = t.name ?? t.tool;
        return [
          {
            kind: "tool_completed",
            ...(name !== undefined ? { name } : {}),
            ...(t.status !== undefined ? { status: t.status } : {}),
            ...(t.seconds_left !== undefined ? { seconds_left: t.seconds_left } : {}),
            ...(t.censored !== undefined ? { censored: t.censored } : {}),
          },
        ];
      }
      case "unknown":
        return [{ kind: "error", message: `unknown stream event "${event.event}"` }];
      case "malformed":
        return [{ kind: "error", message: `malformed stream event: ${event.reason}` }];
    }
  }

  private onDelta(p: StreamMessagePayload): InternalStreamEvent[] {
    const out: InternalStreamEvent[] = [];
    if (p.message_id !== undefined && this.messageId === undefined) this.messageId = p.message_id;
    if (p.role !== undefined && this.role === undefined) this.role = p.role;
    if (p.model !== undefined && this.model === undefined) this.model = p.model;
    if (p.created_at !== undefined && this.created === undefined) this.created = p.created_at;
    if (typeof p.reasoning_content === "string" && p.reasoning_content.length > 0) {
      out.push({ kind: "reasoning", text: p.reasoning_content });
    }
    for (const item of p.content ?? []) {
      if (typeof item.text === "string" && item.text.length > 0) {
        out.push({ kind: "text", text: item.text });
      }
      if (item.function_call !== undefined) {
        this.pushFunctionCall(item, out, false);
      }
      if (Array.isArray(item.files) && item.files.length > 0) {
        // Untrusted wire: only arrays yield file ids (a malformed `files`
        // value is skipped, never crash nor leak into iteration).
        this.lastFileIds = item.files.map((f) => f.id ?? "").filter((id) => id.length > 0);
      }
      if (item.tool_execution !== undefined) {
        this.pushToolExecution(item, out);
      }
    }
    return out;
  }

  private onDone(p: StreamMessagePayload): InternalStreamEvent[] {
    const out: InternalStreamEvent[] = [];
    if (p.tool_state_id !== undefined) this.lastToolsStateId = p.tool_state_id;
    else if (p.tools_state_id !== undefined) this.lastToolsStateId = p.tools_state_id;
    // Live tools streams deliver the final function_call (and tool executions)
    // only inside the done payload's messages, without preceding delta frames —
    // surface them here, skipping call names already emitted via deltas.
    for (const item of p.content ?? []) {
      if (item.function_call !== undefined) {
        this.pushFunctionCall(item, out, true);
      }
      if (item.tool_execution !== undefined) {
        this.pushToolExecution(item, out);
      }
    }
    if (!this.usageEmitted && p.usage !== undefined) {
      out.push({ kind: "usage", usage: toNormalizedUsage(p.usage) });
      this.usageEmitted = true;
    }
    const reason = p.finish_reason;
    if (reason === "error" || reason === "function_call_error") {
      out.push({ kind: "error", message: `stream finished with finish_reason "${reason}"` });
    }
    out.push({
      kind: "done",
      finishReason: toOpenAiFinishReason(reason),
      model: p.model ?? this.model,
    });
    this.doneEmitted = true;
    return out;
  }

  /**
   * §28 malformed-response rule: a content-item `function_call` that is not a
   * non-null object, or that lacks a name, becomes a controlled `error` event
   * instead of a null/undefined crash. `dedupe` skips calls already surfaced
   * via deltas (done payloads re-deliver the final call).
   */
  private pushFunctionCall(
    item: { function_call?: unknown },
    out: InternalStreamEvent[],
    dedupe: boolean,
  ): void {
    const fc = item.function_call as unknown;
    if (typeof fc !== "object" || fc === null) {
      out.push({
        kind: "error",
        message: "malformed stream event: function_call is not an object",
      });
      return;
    }
    const rec = fc as { name?: unknown; arguments?: unknown };
    if (typeof rec.name !== "string" || rec.name.length === 0) {
      out.push({ kind: "error", message: "malformed stream event: function_call without a name" });
      return;
    }
    if (dedupe && this.emittedCallNames.has(rec.name)) return;
    // Arguments may be a JSON string (spec/legacy), an object (live API), or
    // absent (split delta) — normalise to the internal JSON string; "" carries
    // "still pending" for the split-call merge in trackCall().
    const args =
      typeof rec.arguments === "string"
        ? rec.arguments
        : rec.arguments === undefined || rec.arguments === null
          ? ""
          : JSON.stringify(rec.arguments);
    const call = this.trackCall(rec.name, args);
    this.emittedCallNames.add(call.name);
    out.push({ kind: "tool_call", callId: call.callId, name: call.name, arguments: call.args });
  }

  private pushToolExecution(item: { tool_execution?: unknown }, out: InternalStreamEvent[]): void {
    const te = item.tool_execution as unknown;
    if (typeof te !== "object" || te === null) {
      out.push({
        kind: "error",
        message: "malformed stream event: tool_execution is not an object",
      });
      return;
    }
    const rec = te as {
      name?: unknown;
      status?: unknown;
      seconds_left?: unknown;
      censored?: unknown;
    };
    out.push({
      kind: "tool_completed",
      ...(typeof rec.name === "string" ? { name: rec.name } : {}),
      ...(typeof rec.status === "string" ? { status: rec.status } : {}),
      ...(typeof rec.seconds_left === "number" ? { seconds_left: rec.seconds_left } : {}),
      ...(typeof rec.censored === "boolean" ? { censored: rec.censored } : {}),
    });
  }

  /**
   * V2 function_call parts carry no id; sequential stable ids per stream.
   * Arguments may arrive as an object (live API) or a JSON string
   * (spec/legacy); the internal model always carries the JSON string.
   */
  private trackCall(
    name: string,
    args: string | Record<string, unknown>,
  ): { callId: string; name: string; args: string } {
    const raw = typeof args === "string" ? args : JSON.stringify(args);
    // A call may be split over several delta parts: extend the pending call of
    // the same name whose arguments are still empty.
    for (const [callId, pending] of this.pendingCalls) {
      if (pending.name === name && pending.args === "") {
        pending.args = raw;
        return { callId, name, args: raw };
      }
    }
    this.callCounter += 1;
    const callId = `call_${this.callCounter}`;
    this.pendingCalls.set(callId, { name, args: raw });
    return { callId, name, args: raw };
  }
}

function toNormalizedUsage(u: V2ResponseUsage): NormalizedUsage {
  return {
    promptTokens: u.input_tokens,
    completionTokens: u.output_tokens,
    totalTokens: u.total_tokens,
    ...(u.input_tokens_details?.cached_tokens !== undefined
      ? { cachedTokens: u.input_tokens_details.cached_tokens }
      : {}),
  };
}
