/**
 * GigaChat API V2 wire types (plan §6 "types").
 *
 * No `any`. Content items are *keyed objects without a `type` discriminator*,
 * exactly as the official OpenAPI spec describes them
 * (`docs/external/gigachat-api.yml`, `/v2/chat/completions`).
 * `function_call.arguments` is a JSON **string** per the spec, but the live
 * API (verified 2026-09-15) requires an **object** on the wire; request roles
 * use `function` for tool results and the request state token is
 * `functions_state_id`. See `docs/LIVE_API_OBSERVATIONS.md`.
 */

/* ---------------------------------- tools --------------------------------- */

export interface FunctionCallArgs {
  /** Live API returns an id on function_call responses (spec has none). */
  id?: string;
  name: string;
  /**
   * Function call arguments. The live API (2026-09-15) requires an **object**
   * on the wire — a JSON string is rejected with 400.
   * `FunctionCallArgs.arguments` is a string per the spec, so the type keeps
   * both; the request mapper always emits an object and the response path
   * normalizes either form via `parseToolArguments`.
   */
  arguments: Record<string, unknown> | string;
}

export interface CustomFunction {
  name: string;
  description?: string;
  /** JSON Schema object. */
  parameters?: Record<string, unknown>;
  few_shot_examples?: Array<{
    request: string;
    params: Record<string, unknown>;
  }>;
  return_parameters?: Record<string, unknown>;
}

/** One of the possible tool declaration entries (spec oneOf). */
export type V2Tool =
  | { functions: { specifications: CustomFunction[] } }
  | { image_generate: Record<string, never> }
  | { model_3d_generate: Record<string, never> };

export interface ToolConfig {
  mode: "auto" | "none" | "forced";
  /** Motion-of-thought tool name, required when mode=forced. */
  tool_name?: string;
  /** Function name, required when mode=forced. */
  function_name?: string;
}

/* --------------------------------- requests -------------------------------- */

/**
 * Request-side roles (live-verified 2026-09-15): function results use role
 * `function`; a `tool` role is rejected with 400 (spec: FunctionMessage).
 */
export type V2RequestMessageRole = "user" | "system" | "assistant" | "function";

/** Content item in a request — keyed object, no `type` discriminator. */
export interface V2ContentItem {
  inline_data?: Record<string, unknown>;
  text?: string;
  files?: Array<{ id: string }>;
  function_result?: { name: string; result: string };
  function_call?: FunctionCallArgs;
}

export interface V2Message {
  role: V2RequestMessageRole;
  /**
   * Request-side tool state token. The live API accepts this as
   * `functions_state_id` on assistant messages (verified round-trip); the
   * response side returns the same token as `tool_state_id`.
   */
  functions_state_id?: string;
  content: V2ContentItem[];
}

export interface ModelOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  repetition_penalty?: number;
  update_interval?: number;
  unnormalized_history?: boolean;
  top_logprobs?: number;
  response_format?: {
    type: "json" | "json_schema";
    schema?: unknown;
    strict?: boolean;
  };
}

export interface RankerOptions {
  enabled?: boolean;
  top_n?: number;
  embeddings_model?: string;
}

export interface ChatCompletionV2Request {
  model: string;
  messages: V2Message[];
  model_options?: ModelOptions;
  stream?: boolean;
  disable_filter?: boolean;
  ranker_options?: RankerOptions;
  user_info?: { timezone?: string };
  tool_config?: ToolConfig;
  tools?: V2Tool[];
}

/* --------------------------------- responses ------------------------------- */

export type V2FinishReason =
  | "stop"
  | "length"
  | "function_call"
  | "function_call_error"
  | "blacklist"
  | "request_blacklist"
  | "request_whitelist"
  | "request_filter"
  | "response_blacklist";

/** Response-side roles (spec MessageResponse enum: user/system/assistant/tool). */
export type V2ResponseMessageRole = "user" | "system" | "assistant" | "tool";

export interface V2ResponseUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens: number;
  total_tokens: number;
}

export interface V2ResponseContentItem {
  text?: string;
  files?: Array<{
    target?: "image" | "audio" | "3dmodel";
    id?: string;
    mime?: string;
  }>;
  function_call?: FunctionCallArgs;
  tool_execution?: {
    name?: string;
    status?: "success" | "fail";
    seconds_left?: number;
    censored?: boolean;
  };
  logprobs?: Array<{
    chosen?: { token?: string; token_id?: number; logprob?: number };
    top?: Array<{ token?: string; token_id?: number; logprob?: number }>;
  }>;
  inline_data?: Record<string, unknown>;
}

export interface V2ResponseMessage {
  message_id?: string;
  /** Response-side roles (spec MessageResponse enum); live returns assistant. */
  role: V2ResponseMessageRole;
  /**
   * Tool state token on assistant messages. The live API returns it as
   * `tool_state_id` (verified); the spec names it `tools_state_id` — both are
   * read at the boundary.
   */
  tool_state_id?: string;
  tools_state_id?: string;
  content: V2ResponseContentItem[];
}

export interface V2ExecutionStep {
  ts_start: number;
  ts_end: number;
  event_type: string;
  step: Record<string, unknown>;
}

export interface ChatCompletionV2Response {
  model: string;
  thread_id?: string;
  created_at: number;
  messages: V2ResponseMessage[];
  finish_reason: V2FinishReason;
  usage?: V2ResponseUsage;
  additional_data?: { execution_steps?: V2ExecutionStep[] };
}
