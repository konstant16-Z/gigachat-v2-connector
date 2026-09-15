/**
 * Normalized chat-completion *response* model (plan §5 "response").
 *
 * `content` is the flattened text for plain-text consumers; `contentParts`
 * keeps full fidelity so non-text content (files, tool results) is never
 * silently dropped.
 */
import type { NormalizedContentPart } from "./content";
import type { NormalizedToolCall } from "./tools";
import type { NormalizedRole } from "./request";

export interface NormalizedChoice {
  index: number;
  message: {
    role: NormalizedRole;
    /** Flattened text (all text parts joined). */
    content: string | null;
    /** Full-fidelity parts; never silently drops non-text content. */
    contentParts?: NormalizedContentPart[];
    /** Reasoning text when the provider returns it. */
    reasoning?: string;
    toolCalls?: NormalizedToolCall[];
    /** Opaque state token (V2 `tools_state_id`), neutral name (§9). */
    stateId?: string;
    /** Provider extras with no normalized home yet (logprobs, inline_data). */
    metadata?: Record<string, unknown>;
  };
  finishReason: string | null;
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** From V2 `input_tokens_details.cached_tokens`. */
  cachedTokens?: number;
}

export interface NormalizedResponse {
  /** V2 messages carry no id; generated at the boundary (documented). */
  id: string;
  created: number;
  model: string;
  choices: NormalizedChoice[];
  usage: NormalizedUsage;
  /** Provider extras (thread_id, additional_data). */
  metadata?: Record<string, unknown>;
}