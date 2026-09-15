/**
 * GigaChat V2 SSE event classification (plan §12 "events").
 *
 * Pipeline: SseEvent → classifyEvent() → GigaChatStreamEvent.
 *
 * The spec (docs/external/gigachat-api.yml) names four event types but gives
 * only a sparse, internally inconsistent example payload (V2 plain object vs
 * legacy OpenAI-shaped object; `created_at` string vs integer; `finish_reason:
 * "error"` outside the enum). Per agents.md RULE 3 we do not guess: payload
 * fields are extracted defensively (type-checked, optional) and everything
 * that cannot be matched is surfaced as `unknown`/`malformed` instead of being
 * silently swallowed.
 */
import type { V2ResponseContentItem, V2ResponseUsage } from "../gigachat/v2/types";
import type { SseEvent } from "./parser";

/** Payload carried by `response.message.delta` / `response.message.done`. */
export interface StreamMessagePayload {
  message_id?: string;
  role?: string;
  /** Minimal model expects content as V2 content items. */
  content?: V2ResponseContentItem[];
  /** V2FinishReason or the spec-anomaly `"error"`. */
  finish_reason?: string;
  usage?: V2ResponseUsage;
  tools_state_id?: string;
  model?: string;
  /** Spec anomaly: string in the SSE example, integer in the JSON schema. */
  created_at?: number | string;
  /** Not confirmed by the spec; extracted defensively if a server sends it. */
  reasoning_content?: string;
}

/** Payload carried by `response.tool.in_progress` / `response.tool.completed`. */
export interface StreamToolPayload {
  tool?: string;
  name?: string;
  status?: string;
  seconds_left?: number;
  censored?: boolean;
}

export type GigaChatStreamEvent =
  | { kind: "delta"; payload: StreamMessagePayload }
  | { kind: "done"; payload: StreamMessagePayload }
  | { kind: "tool_in_progress"; payload: StreamToolPayload }
  | { kind: "tool_completed"; payload: StreamToolPayload }
  | { kind: "unknown"; event: string; raw: unknown }
  | { kind: "malformed"; reason: string; raw: unknown };

export function classifyEvent(ev: SseEvent): GigaChatStreamEvent {
  const raw = parseData(ev.data);
  if (raw === undefined) {
    return { kind: "malformed", reason: `invalid or empty JSON in event "${ev.event}"`, raw: ev.data };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "malformed", reason: `event "${ev.event}" payload is not an object`, raw };
  }
  switch (ev.event) {
    case "response.message.delta":
      return { kind: "delta", payload: asMessagePayload(raw) };
    case "response.message.done":
      return { kind: "done", payload: asMessagePayload(raw) };
    case "response.tool.in_progress":
      return { kind: "tool_in_progress", payload: asToolPayload(raw) };
    case "response.tool.completed":
      return { kind: "tool_completed", payload: asToolPayload(raw) };
    default:
      return { kind: "unknown", event: ev.event, raw };
  }
}

function parseData(data: string): unknown {
  const trimmed = data.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function asMessagePayload(raw: object): StreamMessagePayload {
  const rec = raw as Record<string, unknown>;
  const p: StreamMessagePayload = {};
  if (typeof rec.message_id === "string") p.message_id = rec.message_id;
  if (typeof rec.role === "string") p.role = rec.role;
  if (typeof rec.finish_reason === "string") p.finish_reason = rec.finish_reason;
  if (typeof rec.tools_state_id === "string") p.tools_state_id = rec.tools_state_id;
  if (typeof rec.model === "string") p.model = rec.model;
  if (typeof rec.created_at === "number" || typeof rec.created_at === "string") {
    p.created_at = rec.created_at;
  }
  if (typeof rec.reasoning_content === "string") p.reasoning_content = rec.reasoning_content;
  if (Array.isArray(rec.content)) {
    const items: V2ResponseContentItem[] = [];
    for (const item of rec.content) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        items.push(item as V2ResponseContentItem);
      }
    }
    if (items.length > 0) p.content = items;
  }
  if (rec.usage !== null && typeof rec.usage === "object") {
    const u = rec.usage as Record<string, unknown>;
    if (typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
      const usage: V2ResponseUsage = {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : 0,
      };
      const details = u.input_tokens_details;
      if (details !== null && typeof details === "object") {
        const d = details as Record<string, unknown>;
        if (typeof d.cached_tokens === "number") {
          usage.input_tokens_details = { cached_tokens: d.cached_tokens };
        }
      }
      p.usage = usage;
    }
  }
  return p;
}

function asToolPayload(raw: object): StreamToolPayload {
  const rec = raw as Record<string, unknown>;
  const p: StreamToolPayload = {};
  if (typeof rec.tool === "string") p.tool = rec.tool;
  if (typeof rec.name === "string") p.name = rec.name;
  if (typeof rec.status === "string") p.status = rec.status;
  if (typeof rec.seconds_left === "number") p.seconds_left = rec.seconds_left;
  if (typeof rec.censored === "boolean") p.censored = rec.censored;
  return p;
}