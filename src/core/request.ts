/**
 * Normalized chat-completion *request* model (plan §5 "request").
 *
 * Neutral camelCase field names; the GigaChat boundary converts to the V2
 * wire format. Generation parameters that are not representable in V2
 * (e.g. `stop`, reasoning) are documented at the boundary instead of being
 * silently dropped or guessed.
 */
import type { NormalizedContentPart } from "./content";
import type { NormalizedTool, NormalizedToolCall, NormalizedToolChoice } from "./tools";

export type NormalizedRole = "system" | "user" | "assistant" | "tool";

export interface NormalizedMessage {
  role: NormalizedRole;
  content: NormalizedContentPart[];
  /** Assistant messages: requested tool invocations. */
  toolCalls?: NormalizedToolCall[];
  /** Tool messages: id of the tool call this message answers. */
  toolCallId?: string;
  /**
   * Opaque conversation-scoped state token (V2 `tools_state_id` /
   * OpenAI-compat `functions_state_id`). Neutral name so the GigaChat field
   * name does not spread through the layers (§9), while still round-tripping
   * through stored conversation history.
   */
  stateId?: string;
}

export type NormalizedReasoning =
  | { effort: "low" | "medium" | "high" }
  | { think: { budgetTokens?: number } };

export type NormalizedResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; schema?: unknown; strict?: boolean };

export interface NormalizedRequest {
  /** Required by V2; validated with a controlled error at the boundary. */
  model?: string;
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  toolChoice?: NormalizedToolChoice | null;
  reasoning?: NormalizedReasoning | null;
  responseFormat?: NormalizedResponseFormat | null;
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  repetitionPenalty?: number;
}