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
        const call = this.trackCall(item.function_call.name, item.function_call.arguments);
        out.push({ kind: "tool_call", callId: call.callId, name: call.name, arguments: call.args });
      }
      if (item.files !== undefined && item.files.length > 0) {
        this.lastFileIds = item.files.map((f) => f.id ?? "").filter((id) => id.length > 0);
      }
      if (item.tool_execution !== undefined) {
        const te = item.tool_execution;
        out.push({
          kind: "tool_completed",
          ...(te.name !== undefined ? { name: te.name } : {}),
          ...(te.status !== undefined ? { status: te.status } : {}),
          ...(te.seconds_left !== undefined ? { seconds_left: te.seconds_left } : {}),
          ...(te.censored !== undefined ? { censored: te.censored } : {}),
        });
      }
    }
    return out;
  }

  private onDone(p: StreamMessagePayload): InternalStreamEvent[] {
    const out: InternalStreamEvent[] = [];
    if (p.tools_state_id !== undefined) this.lastToolsStateId = p.tools_state_id;
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
